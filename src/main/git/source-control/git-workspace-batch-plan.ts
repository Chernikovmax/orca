import { randomUUID } from 'node:crypto'
import type {
  GitWorkspaceBatchRequest,
  GitWorkspaceBatchStep
} from '../../../shared/git-workspace-batch'
import type { GitWorkspaceSnapshot } from '../../../shared/git-workspace-types'
import { GitMutationError } from './git-workspace-mutation-error'
import { validateWorkspaceRefName } from './git-workspace-branch-refs'
import { FULL_OID, type BatchState } from './git-workspace-batch-state'
export function validateRequest(request: GitWorkspaceBatchRequest): void {
  if (!request || typeof request.rootContextId !== 'string' || !request.rootContextId) {
    throw new GitMutationError('invalid', 'A host-issued root context id is required')
  }
  if (
    !Array.isArray(request.contextIds) ||
    request.contextIds.length === 0 ||
    request.contextIds.length > 128
  ) {
    throw new GitMutationError('invalid', 'Select between 1 and 128 workspace contexts')
  }
  if (new Set(request.contextIds).size !== request.contextIds.length) {
    throw new GitMutationError('invalid', 'A workspace context may be selected only once')
  }
  if (typeof request.recursive !== 'boolean' || !Array.isArray(request.commits)) {
    throw new GitMutationError('invalid', 'Explicit recursion and commit selections are required')
  }
  if (request.publication !== undefined && !Array.isArray(request.publication)) {
    throw new GitMutationError('invalid', 'Publication selections must be a list')
  }
}

export function flattenContextPaths(snapshot: GitWorkspaceSnapshot): Map<string, string> {
  const paths = new Map<string, string>()
  for (const module of snapshot.submodules) {
    if (module.contextId) {
      paths.set(module.contextId, module.path)
    }
  }
  if (snapshot.rootContextId) {
    paths.set(snapshot.rootContextId, '')
  }
  return paths
}

export function computeSelection(
  snapshot: GitWorkspaceSnapshot,
  request: GitWorkspaceBatchRequest,
  errors: string[]
): string[] {
  const repos = new Map(
    snapshot.repositories.map((repository) => [repository.context.id, repository])
  )
  if (snapshot.rootContextId !== request.rootContextId) {
    errors.push('The selected root context is no longer the current workspace root')
    return []
  }
  const selected = new Set(request.contextIds)
  for (const id of selected) {
    if (!repos.has(id)) {
      errors.push(
        'A selected context is no longer part of the authorized workspace; refresh and review'
      )
    }
  }
  if (request.recursive) {
    let changed = true
    while (changed) {
      changed = false
      for (const module of snapshot.submodules) {
        if (module.parentContextId && selected.has(module.parentContextId)) {
          if (module.descendants !== 'complete' && module.contextId) {
            errors.push(`Descendants of ${module.path} are not completely discovered`)
          }
          if (module.availability !== 'initialized' || !module.contextId) {
            errors.push(
              `Recursive batch includes unavailable or uninitialized submodule ${module.path}`
            )
          } else if (!selected.has(module.contextId)) {
            selected.add(module.contextId)
            changed = true
          }
        }
      }
    }
  }
  if (snapshot.incomplete) {
    errors.push('Workspace discovery is incomplete; refresh before reviewing a batch')
  }
  const commitIds = new Set<string>()
  for (const commit of request.commits) {
    if (commitIds.has(commit.contextId)) {
      errors.push(`Commit selection repeats context ${commit.contextId}`)
    }
    commitIds.add(commit.contextId)
    if (!selected.has(commit.contextId)) {
      errors.push(`Commit selection for ${commit.contextId} is outside the selected contexts`)
    }
    if (
      typeof commit.message !== 'string' ||
      !commit.message.trim() ||
      commit.message.length > 10_000
    ) {
      errors.push(`A non-empty bounded commit message is required for ${commit.contextId}`)
    }
    if (
      !Array.isArray(commit.stagedPaths) ||
      new Set(commit.stagedPaths).size !== commit.stagedPaths.length
    ) {
      errors.push(
        `An exact, duplicate-free staged path selection is required for ${commit.contextId}`
      )
    }
  }
  return [...selected]
}

export function stagedPathsAfterLinks(state: BatchState, contextId: string): string[] {
  return [
    ...new Set([
      ...(state.stagedSelections.get(contextId) ?? []),
      ...(state.stagedLinks.get(contextId) ?? [])
    ])
  ].sort()
}

export function buildWorkflow(
  snapshot: GitWorkspaceSnapshot,
  selectedIds: string[],
  request: GitWorkspaceBatchRequest,
  errors: string[]
): { steps: GitWorkspaceBatchStep[] } {
  const selected = new Set(selectedIds)
  const repositories = new Map(snapshot.repositories.map((repo) => [repo.context.id, repo]))
  const contextPaths = flattenContextPaths(snapshot)
  const children = new Map<string, typeof snapshot.submodules>()
  for (const module of snapshot.submodules) {
    if (
      module.contextId &&
      selected.has(module.contextId) &&
      selected.has(module.parentContextId)
    ) {
      const list = children.get(module.parentContextId) ?? []
      list.push(module)
      children.set(module.parentContextId, list)
    }
  }
  const publication = new Map((request.publication ?? []).map((item) => [item.contextId, item]))
  if (publication.size !== (request.publication ?? []).length) {
    errors.push('A context may have only one publication destination')
  }
  for (const item of publication.values()) {
    if (!selected.has(item.contextId)) {
      errors.push(`Publication context ${item.contextId} is not selected`)
    }
    if (!item.remote || !FULL_OID.test(item.expectedRefOid)) {
      errors.push(
        `Publication for ${item.contextId} requires an explicit remote and reviewed ref OID`
      )
    }
    try {
      if (!validateWorkspaceRefName(item.refName).startsWith('refs/heads/')) {
        errors.push(`Publication for ${item.contextId} must name a full local branch ref`)
      }
    } catch {
      errors.push(`Publication for ${item.contextId} must name a valid full local branch ref`)
    }
  }

  const steps: GitWorkspaceBatchStep[] = []
  const parentLinks = new Set<string>()
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const commitById = new Map(request.commits.map((item) => [item.contextId, item]))
  const visit = (contextId: string): void => {
    if (visited.has(contextId)) {
      return
    }
    if (visiting.has(contextId)) {
      errors.push('The discovered submodule context tree contains a cycle')
      return
    }
    visiting.add(contextId)
    for (const module of children.get(contextId) ?? []) {
      const childId = module.contextId!
      visit(childId)
      if (!commitById.has(contextId)) {
        continue
      }
      const child = repositories.get(childId)
      const parentPath = contextPaths.get(contextId)
      if (!child || parentPath === undefined || !module.currentOid) {
        errors.push(`Child dependency ${module.path} lacks a verified checkout identity or HEAD`)
        continue
      }
      const childSelection = commitById.get(childId)
      const moves = (childSelection?.stagedPaths.length ?? 0) > 0 || parentLinks.has(childId)
      const needsStage = moves || module.indexOid !== module.currentOid
      if (!needsStage) {
        continue
      }
      if (parentPath && !module.path.startsWith(`${parentPath}/`)) {
        errors.push(`Cannot resolve submodule path ${module.path} relative to its parent context`)
        continue
      }
      const filePath = parentPath ? module.path.slice(parentPath.length + 1) : module.path
      if (!filePath) {
        errors.push(`Cannot resolve submodule path ${module.path} relative to its parent context`)
        continue
      }
      parentLinks.add(contextId)
      steps.push({
        id: `link-${randomUUID()}`,
        kind: 'stageGitlink',
        contextId,
        parentContextId: contextId,
        childContextId: childId,
        filePath,
        ...(moves ? {} : { childOid: module.currentOid }),
        progressId: `batch${randomUUID().replaceAll('-', '')}`.slice(0, 48),
        status: 'pending'
      })
    }
    const selection = commitById.get(contextId)
    const repo = repositories.get(contextId)
    const needsCommit = (selection?.stagedPaths.length ?? 0) > 0 || parentLinks.has(contextId)
    if (selection && needsCommit && repo) {
      steps.push({
        id: `commit-${randomUUID()}`,
        kind: 'commit',
        contextId,
        status: 'pending'
      })
    }
    visiting.delete(contextId)
    visited.add(contextId)
  }
  for (const id of selectedIds) {
    visit(id)
  }

  const publicationOrder = [...selectedIds].sort((left, right) => {
    const leftPath = contextPaths.get(left) ?? ''
    const rightPath = contextPaths.get(right) ?? ''
    return (
      (rightPath ? rightPath.split('/').length : 0) - (leftPath ? leftPath.split('/').length : 0)
    )
  })
  for (const contextId of publicationOrder) {
    const destination = publication.get(contextId)
    if (!destination) {
      continue
    }
    const repo = repositories.get(contextId)
    if (!repo) {
      continue
    }
    for (const module of snapshot.submodules.filter(
      (entry) => entry.parentContextId === contextId
    )) {
      const childId = module.contextId
      if (!childId || !selected.has(childId)) {
        errors.push(
          `Cannot publish parent ${contextId} without explicitly selecting child ${module.path}`
        )
        continue
      }
      const childDestination = publication.get(childId)
      if (!childDestination) {
        errors.push(
          `Cannot publish parent ${contextId} before child ${childId} has a destination remote`
        )
        continue
      }
      steps.push({
        id: `verify-${randomUUID()}`,
        kind: 'verifyRemote',
        contextId: childId,
        parentContextId: contextId,
        childContextId: childId,
        filePath: module.path,
        ...(commitById.get(childId)?.stagedPaths.length ||
        parentLinks.has(childId) ||
        !module.currentOid
          ? {}
          : { childOid: module.currentOid }),
        remote: childDestination.remote,
        refName: childDestination.refName,
        progressId: `batch${randomUUID().replaceAll('-', '')}`.slice(0, 48),
        status: 'pending'
      })
    }
    steps.push({
      id: `push-${randomUUID()}`,
      kind: 'push',
      contextId,
      remote: destination.remote,
      refName: destination.refName,
      progressId: `batch${randomUUID().replaceAll('-', '')}`.slice(0, 48),
      status: 'pending'
    })
  }
  if (steps.length === 0) {
    errors.push('Select at least one commit or publication operation')
  }
  return { steps }
}
