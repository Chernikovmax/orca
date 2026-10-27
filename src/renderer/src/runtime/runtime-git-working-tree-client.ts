import {
  requireGitStageWorktreeScopeReceipt,
  type GitStageWorktreeScope
} from '../../../shared/git-stage-worktree-scope'
import {
  GIT_MUTATION_TIMEOUT_MS,
  type GitMutationReceipt,
  type GitWorkspaceMutationRequest
} from '../../../shared/git-workspace-mutation'
import { resolveLocalWorktreePath, type RuntimeGitContext } from './runtime-git-client-context'
import { callRuntimeRpc } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

const TRANSPORT_UNKNOWN =
  /timed out|timeout|abort|disconnect|socket|ECONN|ENOTFOUND|network|closed|not connected|pipe/i

/**
 * A dropped request may already have run on the host. Report `unknown` instead of
 * throwing, so the UI verifies the real state and never retries automatically.
 */
function asUnknownOutcome(
  request: GitWorkspaceMutationRequest,
  error: unknown
): GitMutationReceipt | undefined {
  const message = error instanceof Error ? error.message : String(error)
  if (
    !TRANSPORT_UNKNOWN.test(message) &&
    !(error instanceof Error && error.name === 'AbortError')
  ) {
    return undefined
  }
  return {
    action: request.action,
    outcome: 'unknown',
    ...(request.contextId ? { contextId: request.contextId } : {}),
    error: `${message}\nThe outcome is unknown. Verify the real Git state before retrying; nothing was retried automatically.`,
    errorCategory: 'unknown-outcome'
  }
}

/** One host-authorized write for the workspace UI; ids and state fences come from the host. */
export async function mutateRuntimeGitWorkspace(
  context: RuntimeGitContext,
  request: GitWorkspaceMutationRequest,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<GitMutationReceipt> {
  const target = context.target
  const worktreePath = resolveLocalWorktreePath(context)
  try {
    if (target.kind === 'local' || !context.worktreeId) {
      return await window.api.git.mutate({
        worktreePath,
        connectionId: context.connectionId,
        ...request
      })
    }
    return await callRuntimeRpc<GitMutationReceipt>(
      target,
      'git.mutate',
      { worktree: toRuntimeWorktreeSelector(context.worktreeId), ...request },
      {
        timeoutMs: options.timeoutMs ?? GIT_MUTATION_TIMEOUT_MS[request.action] ?? 60_000,
        ...(options.signal ? { signal: options.signal } : {})
      }
    )
  } catch (error) {
    const unknown = asUnknownOutcome(request, error)
    if (unknown) {
      return unknown
    }
    throw error
  }
}

function requireSucceeded(receipt: GitMutationReceipt, fallback: string): void {
  if (receipt.outcome !== 'succeeded') {
    throw new Error(receipt.error ?? fallback)
  }
}

export async function stageRuntimeGitPath(
  context: RuntimeGitContext,
  filePath: string
): Promise<void> {
  requireSucceeded(
    await mutateRuntimeGitWorkspace(context, { action: 'stage', filePath }),
    'Git stage failed'
  )
}

export async function bulkStageRuntimeGitPaths(
  context: RuntimeGitContext,
  filePaths: string[]
): Promise<void> {
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.bulkStage({
      worktreePath: resolveLocalWorktreePath(context),
      filePaths,
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.bulkStage',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), filePaths },
    { timeoutMs: 15_000 }
  )
}

/** Stage every change the host sees, for a capped listing that cannot name them all. */
export async function stageRuntimeGitWorktreeScope(
  context: RuntimeGitContext,
  scope: GitStageWorktreeScope
): Promise<void> {
  const target = context.target
  // Why no paths: an older host strips `scope` and stages `filePaths`, so an empty list makes that a no-op.
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.bulkStage({
      worktreePath: resolveLocalWorktreePath(context),
      filePaths: [],
      connectionId: context.connectionId,
      scope
    })
    return
  }
  const reply = await callRuntimeRpc<unknown>(
    target,
    'git.bulkStage',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), filePaths: [], scope },
    { timeoutMs: 15_000 }
  )
  requireGitStageWorktreeScopeReceipt(reply, scope)
}

export async function unstageRuntimeGitPath(
  context: RuntimeGitContext,
  filePath: string
): Promise<void> {
  requireSucceeded(
    await mutateRuntimeGitWorkspace(context, { action: 'unstage', filePath }),
    'Git unstage failed'
  )
}

export async function bulkUnstageRuntimeGitPaths(
  context: RuntimeGitContext,
  filePaths: string[]
): Promise<void> {
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.bulkUnstage({
      worktreePath: resolveLocalWorktreePath(context),
      filePaths,
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.bulkUnstage',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), filePaths },
    { timeoutMs: 15_000 }
  )
}

export async function bulkDiscardRuntimeGitPaths(
  context: RuntimeGitContext,
  filePaths: string[]
): Promise<void> {
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.bulkDiscard({
      worktreePath: resolveLocalWorktreePath(context),
      filePaths,
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.bulkDiscard',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), filePaths },
    { timeoutMs: 15_000 }
  )
}

export async function discardRuntimeGitPath(
  context: RuntimeGitContext,
  filePath: string
): Promise<void> {
  requireSucceeded(
    await mutateRuntimeGitWorkspace(context, { action: 'discard', filePath }),
    'Git discard failed'
  )
}

export async function getRuntimeGitRemoteFileUrl(
  context: RuntimeGitContext,
  args: { relativePath: string; line: number }
): Promise<string | null> {
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.remoteFileUrl({
      worktreePath: resolveLocalWorktreePath(context),
      relativePath: args.relativePath,
      line: args.line,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<string | null>(
    target,
    'git.remoteFileUrl',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      relativePath: args.relativePath,
      line: args.line
    },
    { timeoutMs: 15_000 }
  )
}

export async function getRuntimeGitRemoteCommitUrl(
  context: RuntimeGitContext,
  args: { sha: string }
): Promise<string | null> {
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.remoteCommitUrl({
      worktreePath: resolveLocalWorktreePath(context),
      sha: args.sha,
      connectionId: context.connectionId
    })
  }
  return callRuntimeRpc<string | null>(
    target,
    'git.remoteCommitUrl',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId), sha: args.sha },
    { timeoutMs: 15_000 }
  )
}
