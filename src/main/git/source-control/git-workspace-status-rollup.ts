import type { GitWorkspaceSnapshot } from '../../../shared/git-workspace-types'

export function propagateWorkspaceStatus(workspace: GitWorkspaceSnapshot): void {
  const repositoriesById = new Map(
    workspace.repositories.map((repository) => [repository.context.id, repository])
  )
  for (const submodule of [...workspace.submodules].sort(
    (a, b) => b.path.split('/').length - a.path.split('/').length
  )) {
    const child = submodule.contextId ? repositoriesById.get(submodule.contextId) : undefined
    if (child) {
      submodule.dirty ||= child.dirty
      submodule.conflicted ||= child.conflicted
    }
    const parent = repositoriesById.get(submodule.parentContextId)
    if (parent) {
      parent.dirty ||= submodule.dirty || submodule.commitChanged || submodule.stagedGitlinkChanged
      parent.conflicted ||= submodule.conflicted
    }
  }
}
