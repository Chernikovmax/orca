import type { GetStatusOptions } from './get-status-options'
import { workspaceGitRead } from './git-workspace-discovery'
import { GitMutationError } from './git-workspace-mutation-error'
import { FULL_OID, type ResolvedWorkspace } from './git-workspace-mutation-shared'
import { gitExecFileAsync } from '../runner'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { stripCredentialsFromMessage } from '../../../shared/git-remote-error'

const REF_PREFIX = /^refs\/(?:heads|remotes|tags)\//
const UNSAFE_REF_CHARS = /[\s~^:?*[\]\\]/u
const CONTROL_CHARS = /\p{Cc}/u
const MAX_REF_LENGTH = 512

/** A full ref from the catalog or a full commit id; anything else is refused. */
export function validateWorkspaceRefName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_REF_LENGTH) {
    throw new GitMutationError('invalid', 'A full ref name or full commit id is required')
  }
  if (FULL_OID.test(raw)) {
    return raw
  }
  const rest = raw.replace(REF_PREFIX, '')
  if (
    !REF_PREFIX.test(raw) ||
    rest.split('/').some((part) => part.startsWith('-')) ||
    raw.includes('..') ||
    raw.includes('@{') ||
    raw.includes('//') ||
    raw.endsWith('/') ||
    raw.endsWith('.lock') ||
    CONTROL_CHARS.test(raw) ||
    UNSAFE_REF_CHARS.test(raw)
  ) {
    throw new GitMutationError(
      'invalid',
      'Only a full refs/heads, refs/remotes or refs/tags name, or a full commit id, is accepted'
    )
  }
  return raw
}

/** A new local branch name; Git's own check-ref-format runs before any write. */
export function validateNewBranchName(raw: unknown): string {
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > 200 ||
    raw.startsWith('-') ||
    raw === '@' ||
    raw.includes('..') ||
    raw.includes('@{') ||
    raw.includes('//') ||
    raw.startsWith('/') ||
    raw.endsWith('/') ||
    raw.endsWith('.') ||
    raw.endsWith('.lock') ||
    CONTROL_CHARS.test(raw) ||
    UNSAFE_REF_CHARS.test(raw)
  ) {
    throw new GitMutationError('invalid', 'A valid branch name is required')
  }
  return raw
}

/** Git diagnostics may include credential-bearing URLs; only the message is exposed. */
export function safeGitMessage(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return String(error)
  }
  const record = error as Record<string, unknown>
  const raw =
    (typeof record.stderr === 'string' && record.stderr.trim()) ||
    (typeof record.stdout === 'string' && record.stdout.trim()) ||
    (error instanceof Error ? error.message : '')
  return stripCredentialsFromMessage(String(raw)).trim().slice(0, 4000)
}

export async function readHead(
  workspace: ResolvedWorkspace,
  options: GetStatusOptions
): Promise<string | undefined> {
  const value = (
    await workspaceGitRead(
      workspace.context.checkoutPath,
      ['rev-parse', '--verify', '--quiet', 'HEAD'],
      options,
      true
    )
  ).trim()
  return FULL_OID.test(value) ? value : undefined
}

export async function readCurrentBranch(
  workspace: ResolvedWorkspace,
  options: GetStatusOptions
): Promise<string | undefined> {
  const value = (
    await workspaceGitRead(
      workspace.context.checkoutPath,
      ['symbolic-ref', '--quiet', 'HEAD'],
      options,
      true
    )
  ).trim()
  return value.startsWith('refs/heads/') ? value : undefined
}

/** Resolves a validated ref or full id to a commit available in this checkout. */
export async function resolveLocalCommit(
  workspace: ResolvedWorkspace,
  refName: string,
  options: GetStatusOptions
): Promise<string> {
  const value = (
    await workspaceGitRead(
      workspace.context.checkoutPath,
      ['rev-parse', '--verify', '--quiet', `${refName}^{commit}`],
      options,
      true
    )
  ).trim()
  if (!FULL_OID.test(value)) {
    throw new GitMutationError(
      'invalid',
      `Ref ${refName} does not resolve to a commit available locally; no fetch was attempted`
    )
  }
  return value
}

export async function localRefExists(
  workspace: ResolvedWorkspace,
  refName: string,
  options: GetStatusOptions
): Promise<boolean> {
  const value = (
    await workspaceGitRead(
      workspace.context.checkoutPath,
      ['rev-parse', '--verify', '--quiet', refName],
      options,
      true
    )
  ).trim()
  return FULL_OID.test(value)
}

/** Git's own name grammar, run locally before the branch is created. */
export async function assertValidBranchRefFormat(
  workspace: ResolvedWorkspace,
  branchName: string,
  options: GetStatusOptions
): Promise<void> {
  try {
    await gitExecFileAsync(['check-ref-format', `refs/heads/${branchName}`], {
      ...gitOptionsForWorktree(workspace.context.checkoutPath, options),
      admissionTier: 'interactive',
      timeout: 15_000
    })
  } catch {
    throw new GitMutationError('invalid', 'Git rejected this branch name')
  }
}
