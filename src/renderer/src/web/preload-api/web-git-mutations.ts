import type {
  GitMutationReceipt,
  GitWorkspaceMutationRequest
} from '../../../../shared/git-workspace-mutation'
import { GIT_MUTATION_TIMEOUT_MS } from '../../../../shared/git-workspace-mutation'
import {
  requireGitStageWorktreeScopeReceipt,
  type GitStageWorktreeScope
} from '../../../../shared/git-stage-worktree-scope'
import { toRuntimeWorktreeSelector } from '../../runtime/runtime-worktree-selector'
import { callRuntimeResult } from './web-runtime-calls'
import {
  resolveRuntimeFilePath,
  resolveRuntimeWorktreeByPath
} from './web-runtime-worktree-catalog'

export async function mutateGitPath(
  method: string,
  worktreePath: string,
  filePath: string
): Promise<void> {
  const file = await resolveRuntimeFilePath(filePath, worktreePath)
  await callRuntimeResult(method, {
    worktree: toRuntimeWorktreeSelector(file.worktree.id),
    filePath: file.relativePath
  })
}

export async function mutateGitPaths(
  method: string,
  worktreePath: string,
  filePaths: string[]
): Promise<void> {
  const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
  await callRuntimeResult(method, { worktree: toRuntimeWorktreeSelector(worktree.id), filePaths })
}

/** One host-authorized workspace write with the same long deadline as the desktop client. */
export async function mutateGitWorkspace(
  args: { worktreePath: string; connectionId?: string } & GitWorkspaceMutationRequest
): Promise<GitMutationReceipt> {
  const { worktreePath, connectionId: _connectionId, ...request } = args
  const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
  return callRuntimeResult<GitMutationReceipt>(
    'git.mutate',
    { worktree: toRuntimeWorktreeSelector(worktree.id), ...request },
    GIT_MUTATION_TIMEOUT_MS[request.action] ?? 60_000
  )
}

export async function bulkStageGitPaths(args: {
  worktreePath: string
  filePaths: string[]
  scope?: GitStageWorktreeScope
}): Promise<void> {
  if (!args.scope) {
    return mutateGitPaths('git.bulkStage', args.worktreePath, args.filePaths)
  }
  const worktree = await resolveRuntimeWorktreeByPath(args.worktreePath)
  // Why no paths: an older host strips `scope` and stages `filePaths`, so an empty list makes that a no-op.
  const reply = await callRuntimeResult<unknown>('git.bulkStage', {
    worktree: toRuntimeWorktreeSelector(worktree.id),
    filePaths: [],
    scope: args.scope
  })
  requireGitStageWorktreeScopeReceipt(reply, args.scope)
}
