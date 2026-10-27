import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import * as path from 'node:path'
import type {
  GitCommitPreview,
  GitMutationReceipt,
  GitWorkspaceMutationRequest
} from '../../../shared/git-workspace-mutation'
import type { GitContextRef } from '../../../shared/git-workspace-types'
import type { GetStatusOptions } from './get-status-options'
import { workspaceGitRead } from './git-workspace-discovery'
import { classifyMutationError, GitMutationError } from './git-workspace-mutation-error'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync } from '../runner'
import { commitChanges } from './commit-changes'
import type { ResolvedWorkspace } from './git-workspace-mutation-shared'

const COMMIT_PREVIEW_LIMIT = 500

async function hasCommitHook(
  context: GitContextRef,
  options: GetStatusOptions
): Promise<boolean> {
  const reported = (
    await workspaceGitRead(context.checkoutPath, ['rev-parse', '--git-path', 'hooks'], options)
  ).trim()
  const directory = path.isAbsolute(reported)
    ? reported
    : path.resolve(context.checkoutPath, reported)
  for (const name of ['pre-commit', 'prepare-commit-msg', 'commit-msg']) {
    try {
      await access(path.join(directory, name), constants.X_OK)
      return true
    } catch {
      // Hook absent or not executable.
    }
  }
  return false
}

/** Exactly what the real index holds now; nothing is staged by this preview. */
export async function previewCommitImpl(resolved: ResolvedWorkspace): Promise<GitCommitPreview> {
  const { repository } = resolved
  const stagedEntries = repository.entries.filter((entry) => entry.area === 'staged')
  return {
    contextId: repository.context.id,
    expectedState: repository.expectedState,
    ...(repository.branch
      ? { branch: repository.branch.replace(/^refs\/heads\//, '') }
      : {}),
    ...(repository.head ? { head: repository.head } : {}),
    unborn: repository.unborn,
    detached: repository.detached,
    staged: stagedEntries.slice(0, COMMIT_PREVIEW_LIMIT).map((entry) => ({
      path: entry.path,
      status: entry.status,
      ...(entry.oldPath ? { oldPath: entry.oldPath } : {})
    })),
    stagedFiles: stagedEntries.length,
    truncated: repository.statusTruncated === true,
    preservesHooks: true
  }
}

/**
 * Commits the real index without staging anything else. Hooks and signing run as
 * configured; their failures are reported and the caller refreshes real state.
 */
export async function commitImpl(
  resolved: ResolvedWorkspace,
  request: GitWorkspaceMutationRequest,
  options: GetStatusOptions
): Promise<GitMutationReceipt> {
  const { repository, context } = resolved
  const message = request.message?.trim() ?? ''
  if (!message) {
    throw new GitMutationError('invalid', 'A commit message is required')
  }
  if (request.expectedState === undefined) {
    // Why: pre-existing file/CLI callers keep their established commit contract; the
    // workspace UI always sends the previewed state into the fenced path below.
    const result = await commitChanges(context.checkoutPath, message, {
      ...options,
      admissionTier: 'interactive'
    })
    if (!result.success) {
      const detail = result.error ?? 'Commit failed'
      const classified = classifyMutationError({ stderr: detail })
      const category =
        classified.category === 'git-error' && (await hasCommitHook(context, options))
          ? 'hook'
          : classified.category
      throw new GitMutationError(category, detail)
    }
    const head = (
      await workspaceGitRead(context.checkoutPath, ['rev-parse', '--verify', 'HEAD'], options)
    ).trim()
    return { action: 'commit', outcome: 'succeeded', contextId: context.id, head }
  }
  if (repository.statusTruncated) {
    throw new GitMutationError(
      'incomplete',
      'The staged listing is truncated, so the committed set cannot be reviewed in full; refresh or reduce the change set'
    )
  }
  if (!repository.entries.some((entry) => entry.area === 'staged')) {
    throw new GitMutationError('invalid', 'The real index has no staged changes')
  }
  const headBefore = repository.head
  try {
    await gitExecFileAsync(['commit', '-m', message], {
      ...gitOptionsForWorktree(context.checkoutPath, options),
      admissionTier: 'interactive'
    })
  } catch (error) {
    const classified = classifyMutationError(error)
    if (classified.category === 'hook' || classified.category === 'signing') {
      throw error
    }
    // Git forwards hook output without naming the hook, so classify by what is installed.
    if (await hasCommitHook(context, options)) {
      throw new GitMutationError('hook', classified.message)
    }
    throw error
  }
  const head = (
    await workspaceGitRead(context.checkoutPath, ['rev-parse', '--verify', 'HEAD'], options)
  ).trim()
  if (head === headBefore) {
    throw new GitMutationError(
      'git-error',
      'Git reported a commit but HEAD did not move; verify the real state'
    )
  }
  const summary = (
    await workspaceGitRead(context.checkoutPath, ['show', '-s', '--format=%s', head], options)
  ).trim()
  return {
    action: 'commit',
    outcome: 'succeeded',
    contextId: context.id,
    head,
    commit: { head, summary }
  }
}
