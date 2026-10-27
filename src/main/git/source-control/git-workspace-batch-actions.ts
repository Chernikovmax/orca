import { assertPublishedChildDestination } from './git-workspace-batch-destination'
import type { GitMutationReceipt } from '../../../shared/git-workspace-mutation'
import type {
  GitWorkspaceBatchConfirmation,
  GitWorkspaceBatchStepResult
} from '../../../shared/git-workspace-batch'
import type { GetStatusOptions } from './get-status-options'
import { mutateGitWorkspace } from './git-workspace-mutation'
import { readAuthorizedWorkspace } from './git-workspace-mutation-shared'
import { GitMutationError } from './git-workspace-mutation-error'
import { resolveLocalCommit } from './git-workspace-branch-refs'
import { workspaceGitRead } from './git-workspace-discovery'
import {
  FULL_OID,
  type BatchState,
  repositoryFor,
  sameStrings,
  stagedPathSet
} from './git-workspace-batch-state'
import { stagedPathsAfterLinks } from './git-workspace-batch-plan'
import {
  assertDependencies,
  destinationCanBeVerified,
  freshSnapshot,
  remoteEndpoints,
  remoteFingerprint,
  stepRequest
} from './git-workspace-batch-runtime'
export async function executeMutation(
  state: BatchState,
  step: GitWorkspaceBatchStepResult,
  options: GetStatusOptions
): Promise<GitMutationReceipt> {
  const latest = await assertDependencies(state, options)
  const repo = repositoryFor(latest, step.contextId)
  if (!repo) {
    throw new GitMutationError('stale', 'Batch context disappeared')
  }

  if (step.kind === 'commit') {
    const approved = stagedPathsAfterLinks(state, step.contextId)
    if (!sameStrings(stagedPathSet(repo), approved)) {
      throw new GitMutationError(
        'stale',
        `Staged paths changed for ${step.contextId}; the batch refuses unrelated index content`
      )
    }
    const preview = await mutateGitWorkspace(
      state.workspaceRoot,
      {
        action: 'previewCommit',
        contextId: step.contextId,
        expectedState: repo.expectedState
      },
      options
    )
    if (preview.outcome !== 'succeeded' || !preview.preview || !('staged' in preview.preview)) {
      throw new GitMutationError(
        preview.errorCategory ?? 'git-error',
        preview.error ?? 'Commit preview failed'
      )
    }
    if (
      preview.preview.truncated ||
      !sameStrings(preview.preview.staged.map((entry) => entry.path).sort(), approved)
    ) {
      throw new GitMutationError(
        'stale',
        `Commit index changed for ${step.contextId}; review the exact staged paths again`
      )
    }
  }

  if (step.kind === 'stageGitlink') {
    const childId = step.childContextId!
    const child = repositoryFor(latest, childId)
    const reviewedOid = step.childOid
    if (!child || !reviewedOid || child.head !== reviewedOid) {
      throw new GitMutationError(
        'stale',
        'Child HEAD changed; review the gitlink confirmation again'
      )
    }
    const approved = stagedPathsAfterLinks(state, step.contextId)
    const nextApproved = [...new Set([...approved, step.filePath!])].sort()
    const current = stagedPathSet(repo)
    if (!sameStrings(current, approved) && !sameStrings(current, nextApproved)) {
      throw new GitMutationError(
        'stale',
        'Parent index contains unreviewed staged paths; no gitlink was written'
      )
    }
  }

  if (step.kind === 'push') {
    const destination = state.publication.get(step.contextId)
    if (!destination) {
      throw new GitMutationError('invalid', 'Publication destination is missing')
    }
    const resolved = await readAuthorizedWorkspace(
      state.workspaceRoot,
      { action: 'previewCommit', contextId: step.contextId },
      options
    )
    const approvedRemote = state.remoteFingerprints.get(step.contextId)?.get(destination.remote)
    const currentRemote = await remoteFingerprint(
      resolved.context.checkoutPath,
      destination.remote,
      options
    )
    if (!approvedRemote || currentRemote !== approvedRemote) {
      throw new GitMutationError('stale', 'Publication destination changed since batch review')
    }
    const currentOid = await resolveLocalCommit(resolved, destination.refName, options)
    if (currentOid !== state.currentRefs.get(step.contextId)) {
      throw new GitMutationError('stale', 'Local publication ref moved; refresh before pushing')
    }
  }

  return mutateGitWorkspace(state.workspaceRoot, stepRequest(step, state), options)
}

export async function verifyChildRemote(
  state: BatchState,
  step: GitWorkspaceBatchStepResult,
  options: GetStatusOptions
): Promise<void> {
  const childId = step.childContextId!
  const oid = step.childOid
  const remote = step.remote
  const refName = step.refName
  if (!oid || !FULL_OID.test(oid) || !remote || !refName) {
    throw new GitMutationError(
      'invalid',
      'Child publication verification lacks an exact OID or destination'
    )
  }
  const destination = state.publication.get(childId)
  if (!destination || destination.remote !== remote || destination.refName !== refName) {
    throw new GitMutationError('stale', 'Child destination changed; review the batch again')
  }
  const expectedBefore = state.expectedStates.get(childId)
  const identity = state.identities.get(childId)
  const approvedRemote = state.remoteFingerprints.get(childId)?.get(remote)
  if (
    !expectedBefore ||
    !identity ||
    !approvedRemote ||
    (await remoteFingerprint(identity.checkoutPath, remote, options)) !== approvedRemote
  ) {
    throw new GitMutationError('stale', 'Child destination changed since batch review')
  }
  const endpoints = await remoteEndpoints(identity.checkoutPath, remote, options)
  if (!destinationCanBeVerified(endpoints)) {
    throw new GitMutationError(
      'incomplete',
      `Remote ${remote} does not have one identical fetch/push destination; parent publication is blocked`
    )
  }
  await assertPublishedChildDestination(state, step, endpoints.push[0], options)
  const receipt = await mutateGitWorkspace(
    state.workspaceRoot,
    {
      action: 'fetch',
      contextId: childId,
      remote,
      branch: refName.replace(/^refs\/heads\//, ''),
      ...(step.progressId ? { progressId: step.progressId } : {})
    },
    options
  )
  if (receipt.outcome !== 'succeeded') {
    throw new GitMutationError(
      receipt.errorCategory ?? 'network',
      receipt.error ?? 'The child destination could not be checked; parent publication is blocked',
      { unknownOutcome: receipt.outcome === 'unknown' }
    )
  }
  const current = await freshSnapshot(state.workspaceRoot, options)
  const currentChild = repositoryFor(current, childId)
  const oldIdentity = state.identities.get(childId)
  const fetchedRemote = currentChild
    ? await remoteFingerprint(currentChild.context.checkoutPath, remote, options)
    : undefined
  if (
    receipt.expectedState !== expectedBefore ||
    !currentChild ||
    currentChild.expectedState !== expectedBefore ||
    currentChild.context.checkoutPath !== oldIdentity?.checkoutPath ||
    currentChild.context.commonGitDir !== oldIdentity?.commonGitDir ||
    fetchedRemote !== approvedRemote
  ) {
    throw new GitMutationError(
      'stale',
      'Child worktree or destination changed during remote reachability verification'
    )
  }
  state.lastWorkspace = current
  const resolved = await readAuthorizedWorkspace(
    state.workspaceRoot,
    { action: 'previewCommit', contextId: childId, expectedState: expectedBefore },
    options
  )
  let available = false
  try {
    const fetchedOid = (
      await workspaceGitRead(
        resolved.context.checkoutPath,
        ['rev-parse', '--verify', 'FETCH_HEAD'],
        options
      )
    ).trim()
    if (FULL_OID.test(fetchedOid)) {
      await workspaceGitRead(
        resolved.context.checkoutPath,
        ['merge-base', '--is-ancestor', oid, fetchedOid],
        options
      )
      available = true
    }
  } catch {
    available = false
  }
  if (!available) {
    throw new GitMutationError(
      'incomplete',
      `Remote ${remote} does not prove that child commit ${oid} is reachable from ${refName}; parent publication is blocked`
    )
  }
}

export function confirmationMatches(
  confirmation: GitWorkspaceBatchConfirmation,
  step: GitWorkspaceBatchStepResult,
  childOid: string
): boolean {
  return (
    confirmation.confirmed === true &&
    confirmation.parentContextId === step.parentContextId &&
    confirmation.filePath === step.filePath &&
    confirmation.childContextId === step.childContextId &&
    confirmation.childOid === childOid
  )
}
