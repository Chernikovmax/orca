import type { GitWorkspaceSnapshot, RepositoryState } from '../../../shared/git-workspace-types'
import type { GetStatusOptions } from './get-status-options'
import { getStatus } from './status-read'
import { verifyWorkspaceContext } from './git-workspace-context'
import { GitWorkspaceReadError } from './git-workspace-error'

export type AuthorizedWorkspaceRead = {
  workspace: GitWorkspaceSnapshot
  repository: RepositoryState
}

/**
 * Resolves a host-issued Git context against a fresh discovery pass. The context id
 * is a selector, never a path or permission: discovery decides which checkouts exist,
 * and the checkout identity is verified again so a concurrently replaced submodule
 * cannot lend its identity to a read.
 */
export async function readAuthorizedGitContext(
  root: string,
  contextId: string,
  options: GetStatusOptions
): Promise<AuthorizedWorkspaceRead> {
  const status = await getStatus(root, {
    ...options,
    includeWorkspace: true,
    includeLineStats: false,
    workspaceRefsContextId: undefined
  })
  const workspace = status.workspace
  if (!workspace) {
    throw new GitWorkspaceReadError(
      'unavailable',
      'Git workspace discovery returned no authorized contexts'
    )
  }
  const repository = workspace.repositories.find((item) => item.context.id === contextId)
  if (!repository) {
    throw new GitWorkspaceReadError(
      'access-denied',
      'Git context is not part of this authorized worktree; refresh before reading it'
    )
  }
  await verifyWorkspaceContext(repository.context, options)
  return { workspace, repository }
}
