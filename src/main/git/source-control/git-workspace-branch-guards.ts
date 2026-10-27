import * as path from 'node:path'
import { realpath } from 'node:fs/promises'
import type { RepositoryState } from '../../../shared/git-workspace-types'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import { parseWorktreeList } from '../../../shared/git-worktree-porcelain-parser'
import type { GetStatusOptions } from './get-status-options'
import { workspaceGitRead } from './git-workspace-discovery'
import { GitMutationError } from './git-workspace-mutation-error'
import type { ResolvedWorkspace } from './git-workspace-mutation-shared'
import { detectConflictOperationState, type ConflictOperationState } from './git-conflict-operation'

const MAX_REPORTED_PATHS = 20

export async function readRemoteNames(
  workspace: ResolvedWorkspace,
  options: GetStatusOptions
): Promise<string[]> {
  const output = await workspaceGitRead(workspace.context.checkoutPath, ['remote'], options)
  return output
    .split('\n')
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && !/\p{Cc}/u.test(name))
}

export function requireRemoteName(raw: unknown, remotes: string[]): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200 || raw.startsWith('-')) {
    throw new GitMutationError('invalid', 'An explicit remote name is required')
  }
  if (!remotes.includes(raw)) {
    throw new GitMutationError(
      'invalid',
      `Remote ${raw} is not configured in this checkout; no network request was made`
    )
  }
  return raw
}

/** Splits refs/remotes/<remote>/<branch> using the configured remote names. */
export function splitRemoteBranch(
  refName: string,
  remotes: string[]
): { remote: string; branch: string } {
  const rest = refName.slice('refs/remotes/'.length)
  const remote = [...remotes]
    .sort((a, b) => b.length - a.length)
    .find((name) => rest.startsWith(`${name}/`))
  const branch = remote ? rest.slice(remote.length + 1) : ''
  if (!remote || !branch || branch === 'HEAD') {
    throw new GitMutationError(
      'invalid',
      'Remote HEAD or an unknown remote branch cannot be checked out'
    )
  }
  return { remote, branch }
}

export async function readWorktrees(
  workspace: ResolvedWorkspace,
  options: GetStatusOptions
): Promise<GitWorktreeInfo[]> {
  const output = await workspaceGitRead(
    workspace.context.checkoutPath,
    ['worktree', 'list', '--porcelain', '-z'],
    options
  )
  return parseWorktreeList(output, { nulDelimited: true })
}

function samePath(left: string, right: string): boolean {
  return (
    normalizeRuntimePathForComparison(path.resolve(left)) ===
    normalizeRuntimePathForComparison(path.resolve(right))
  )
}

/** A branch attached to any other live worktree cannot be checked out here. */
export async function assertBranchNotCheckedOutElsewhere(
  workspace: ResolvedWorkspace,
  refName: string,
  options: GetStatusOptions
): Promise<void> {
  const worktrees = await readWorktrees(workspace, options)
  for (const worktree of worktrees) {
    if (worktree.prunable || worktree.branch !== refName) {
      continue
    }
    if (samePath(worktree.path, workspace.context.checkoutPath)) {
      continue
    }
    const shown = await realpath(worktree.path).catch(() => worktree.path)
    throw new GitMutationError(
      'busy',
      `Branch ${refName.slice('refs/heads/'.length)} is already checked out in another worktree: ${shown}`
    )
  }
}

/** Paths where a checkout would overwrite staged, unstaged or untracked work. */
export async function blockingDirtyPaths(
  workspace: ResolvedWorkspace,
  targetOid: string,
  options: GetStatusOptions
): Promise<string[]> {
  const { repository } = workspace
  if (!repository.dirty) {
    return []
  }
  if (!repository.head) {
    // An unborn checkout would materialize the whole target tree over these files.
    return repository.entries.map((entry) => entry.path).slice(0, MAX_REPORTED_PATHS)
  }
  const changed = new Set(
    (
      await workspaceGitRead(
        workspace.context.checkoutPath,
        [
          'diff',
          '--name-only',
          '-z',
          '--no-renames',
          '--diff-filter=ACDMRTUXB',
          repository.head,
          targetOid,
          '--'
        ],
        options
      )
    )
      .split('\0')
      .filter(Boolean)
  )
  const blocked: string[] = []
  for (const entry of repository.entries) {
    for (const candidate of [entry.path, entry.oldPath]) {
      if (candidate && changed.has(candidate) && !blocked.includes(candidate)) {
        blocked.push(candidate)
      }
    }
  }
  return blocked.slice(0, MAX_REPORTED_PATHS)
}

/** Checkout would lose work only in the blocking paths; other local changes stay. */
export async function assertCheckoutKeepsLocalChanges(
  workspace: ResolvedWorkspace,
  targetOid: string,
  options: GetStatusOptions
): Promise<void> {
  const blocked = await blockingDirtyPaths(workspace, targetOid, options)
  if (blocked.length > 0) {
    throw new GitMutationError(
      'dirty',
      `Checkout would overwrite local changes in: ${blocked.join(', ')}. Commit, stash outside Orca, or discard them first; Orca does not stash automatically.`
    )
  }
}

export function assertNoUnfinishedOperation(repository: RepositoryState): void {
  if (repository.operationInProgress) {
    const kind =
      repository.conflictOperation === 'unknown' ? '' : `${repository.conflictOperation} `
    throw new GitMutationError(
      'operation-in-progress',
      `A Git ${kind}operation is unfinished; continue or abort it before starting another`
    )
  }
  if (repository.conflicted) {
    throw new GitMutationError(
      'conflict',
      'Resolve or abort the current conflicts before starting another Git operation'
    )
  }
}

export function assertCleanForIntegration(repository: RepositoryState): void {
  if (repository.dirty || repository.conflicted) {
    throw new GitMutationError(
      'dirty',
      `This operation needs a clean index and working tree; ${repository.entries.length} change(s) are present. Commit or discard them first; Orca does not stash automatically.`
    )
  }
}

export async function currentOperation(
  workspace: ResolvedWorkspace,
  options: GetStatusOptions
): Promise<ConflictOperationState> {
  return detectConflictOperationState(workspace.context.checkoutPath, options)
}

export async function unresolvedConflictCount(
  workspace: ResolvedWorkspace,
  options: GetStatusOptions
): Promise<number> {
  const output = await workspaceGitRead(
    workspace.context.checkoutPath,
    ['diff', '--name-only', '-z', '--diff-filter=U'],
    options
  )
  return output.split('\0').filter(Boolean).length
}
