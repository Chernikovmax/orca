import type { GitMutationReceipt } from '../../../shared/git-workspace-mutation'
import type { GetStatusOptions } from './get-status-options'
import { GitMutationError } from './git-workspace-mutation-error'
import { workspaceGitRead } from './git-workspace-discovery'
import { type BatchState, repositoryFor } from './git-workspace-batch-state'
import { flattenContextPaths } from './git-workspace-batch-plan'
import { freshSnapshot } from './git-workspace-batch-runtime'
export async function reconcileCommitFences(
  state: BatchState,
  contextId: string,
  receipt: GitMutationReceipt,
  options: GetStatusOptions
): Promise<void> {
  const before = state.lastWorkspace
  const after = await freshSnapshot(state.workspaceRoot, options)
  const oldChild = before && repositoryFor(before, contextId)
  const child = repositoryFor(after, contextId)
  const oid = receipt.commit?.head ?? receipt.head
  if (
    !before ||
    !oldChild ||
    !child ||
    !oid ||
    child.head !== oid ||
    child.expectedState !== receipt.expectedState
  ) {
    throw new GitMutationError(
      'stale',
      'Committed context state could not be verified; inspect Git before continuing'
    )
  }
  for (const dependencyId of state.selectedIds) {
    const repository = repositoryFor(after, dependencyId)
    const expectedIndex = state.indexRecords.get(dependencyId)
    if (!repository || !expectedIndex) {
      throw new GitMutationError(
        'unknown-outcome',
        `Commit completed, but dependency ${dependencyId} disappeared before validation`
      )
    }
    const currentIndex = await workspaceGitRead(
      repository.context.checkoutPath,
      ['ls-files', '--stage', '-z'],
      options
    )
    if (currentIndex !== expectedIndex) {
      throw new GitMutationError(
        'unknown-outcome',
        `Commit completed, but index ${dependencyId} changed during the commit; inspect Git before continuing`
      )
    }
  }

  const moduleBefore = before.submodules.find((entry) => entry.contextId === contextId)
  const moduleAfter = after.submodules.find((entry) => entry.contextId === contextId)
  const parentId = moduleBefore?.parentContextId
  if (parentId && state.selectedIds.includes(parentId)) {
    const oldParent = repositoryFor(before, parentId)
    const parent = repositoryFor(after, parentId)
    const oldIdentity = state.identities.get(parentId)
    const oldParentPath = flattenContextPaths(before).get(parentId) ?? ''
    const relativePath =
      oldParentPath && moduleBefore.path.startsWith(`${oldParentPath}/`)
        ? moduleBefore.path.slice(oldParentPath.length + 1)
        : moduleBefore.path
    const oldOthers = oldParent?.entries.filter((entry) => entry.path !== relativePath)
    const newOthers = parent?.entries.filter((entry) => entry.path !== relativePath)
    const oldStaged = oldParent?.entries.filter(
      (entry) => entry.path === relativePath && entry.area === 'staged'
    )
    const newStaged = parent?.entries.filter(
      (entry) => entry.path === relativePath && entry.area === 'staged'
    )
    if (
      !oldParent ||
      !parent ||
      !moduleAfter ||
      !oldIdentity ||
      parent.context.checkoutPath !== oldIdentity.checkoutPath ||
      parent.context.commonGitDir !== oldIdentity.commonGitDir ||
      parent.head !== oldParent.head ||
      parent.conflictOperation !== oldParent.conflictOperation ||
      parent.operationInProgress !== oldParent.operationInProgress ||
      parent.conflicted !== oldParent.conflicted ||
      parent.incomplete !== oldParent.incomplete ||
      moduleAfter.currentOid !== oid ||
      moduleAfter.indexOid !== moduleBefore.indexOid ||
      moduleAfter.headOid !== moduleBefore.headOid ||
      JSON.stringify(oldOthers) !== JSON.stringify(newOthers) ||
      JSON.stringify(oldStaged) !== JSON.stringify(newStaged)
    ) {
      throw new GitMutationError(
        'stale',
        'Parent dependency changed beyond the child commit; review it before continuing'
      )
    }
    state.expectedStates.set(parentId, parent.expectedState)
    state.identities.set(parentId, parent.context)
  }

  for (const dependencyId of state.selectedIds) {
    if (dependencyId === contextId || dependencyId === parentId) {
      continue
    }
    const oldRepo = repositoryFor(before, dependencyId)
    const repo = repositoryFor(after, dependencyId)
    if (
      !oldRepo ||
      !repo ||
      repo.expectedState !== state.expectedStates.get(dependencyId) ||
      repo.context.checkoutPath !== state.identities.get(dependencyId)?.checkoutPath ||
      repo.context.commonGitDir !== state.identities.get(dependencyId)?.commonGitDir
    ) {
      throw new GitMutationError(
        'stale',
        `Dependency ${dependencyId} changed during commit; review before continuing`
      )
    }
  }
  state.expectedStates.set(contextId, child.expectedState)
  state.identities.set(contextId, child.context)
  state.lastWorkspace = after
}
