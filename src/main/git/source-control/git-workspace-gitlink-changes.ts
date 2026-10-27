import { createHash } from 'node:crypto'
import type { GitFileStatus, GitStatusEntry } from '../../../shared/git-status-types'
import type { GitWorkspaceSnapshot } from '../../../shared/git-workspace-types'

function changeStatus(before?: string, after?: string): GitFileStatus {
  return !before ? 'added' : !after ? 'deleted' : 'modified'
}

/** Porcelain is read with --ignore-submodules=all; restore only pointer changes from authorized metadata. */
export function attachGitlinkChanges(workspace: GitWorkspaceSnapshot): void {
  const repositories = new Map(
    workspace.repositories.map((repository) => [repository.context.id, repository])
  )
  const paths = new Map(
    workspace.submodules
      .filter((module) => module.contextId)
      .map((module) => [module.contextId!, module.path])
  )
  for (const module of workspace.submodules) {
    const parent = repositories.get(module.parentContextId)
    if (!parent) {
      continue
    }
    const parentPath = paths.get(parent.context.id)
    const relativePath =
      parentPath && module.path.startsWith(`${parentPath}/`)
        ? module.path.slice(parentPath.length + 1)
        : module.path
    const changes: GitStatusEntry[] = []
    if (module.indexConflictOids.length) {
      changes.push({
        area: 'unstaged',
        path: relativePath,
        status: 'modified',
        conflictStatus: 'unresolved'
      })
    } else {
      if (module.stagedGitlinkChanged) {
        changes.push({
          area: 'staged',
          path: relativePath,
          status: changeStatus(module.headOid, module.indexOid)
        })
      }
      if (
        module.availability === 'initialized' &&
        module.currentOid &&
        module.currentOid !== module.indexOid
      ) {
        changes.push({
          area: 'unstaged',
          path: relativePath,
          status: changeStatus(module.indexOid, module.currentOid)
        })
      }
    }
    for (const change of changes) {
      if (
        !parent.entries.some((entry) => entry.path === change.path && entry.area === change.area)
      ) {
        parent.entries.push(change)
      }
    }
    if (changes.length) {
      parent.expectedState = createHash('sha256')
        .update(JSON.stringify([parent.expectedState, changes]))
        .digest('hex')
    }
  }
}
