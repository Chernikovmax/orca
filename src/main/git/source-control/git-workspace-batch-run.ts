import type {
  GitWorkspaceBatchReceipt,
  GitWorkspaceBatchRunRequest
} from '../../../shared/git-workspace-batch'
import type { GetStatusOptions } from './get-status-options'
import { GitMutationError } from './git-workspace-mutation-error'
import { safeGitMessage } from './git-workspace-branch-refs'
import { FULL_OID, resultSnapshot, states } from './git-workspace-batch-state'
import { assertDependencies, recordStagedGitlink, updateFence } from './git-workspace-batch-runtime'
import {
  confirmationMatches,
  executeMutation,
  verifyChildRemote
} from './git-workspace-batch-actions'
import { reconcileCommitFences } from './git-workspace-batch-reconcile'
export async function runGitWorkspaceBatch(
  root: string,
  request: GitWorkspaceBatchRunRequest,
  options: GetStatusOptions = {}
): Promise<GitWorkspaceBatchReceipt> {
  const state = states.get(request.previewId)
  if (!state || state.expiresAt <= Date.now()) {
    if (state && !state.running) {
      states.delete(state.id)
    }
    throw new GitMutationError(
      'stale',
      'Batch preview expired or is unknown; refresh and preview again'
    )
  }
  if (state.workspaceRoot !== root) {
    throw new GitMutationError('access-denied', 'Batch preview belongs to another workspace root')
  }
  if (request.inspectOnly === true) {
    return resultSnapshot(state, state.running ? 'running' : (state.terminal ?? 'paused'))
  }
  if (state.running) {
    return resultSnapshot(state, 'running')
  }
  if (state.terminal === 'unknown' || state.terminal === 'completed') {
    return resultSnapshot(state, state.terminal)
  }
  state.running = true
  try {
    if (state.terminal === 'failed') {
      if (request.retryFailed !== true) {
        return resultSnapshot(state, 'failed')
      }
      await assertDependencies(state, options)
      const failed = state.steps.filter((step) => step.status === 'failed')
      if (failed.length !== 1) {
        throw new GitMutationError(
          'invalid',
          'Only one known-failed batch step may be explicitly retried'
        )
      }
      failed[0].status = 'pending'
      delete failed[0].error
      delete failed[0].errorCategory
      delete state.terminal
    } else if (request.retryFailed === true) {
      throw new GitMutationError('invalid', 'There is no failed batch step to retry')
    }
    let nextConfirmation = request.confirmations?.[0]
    if ((request.confirmations?.length ?? 0) > 1) {
      throw new GitMutationError(
        'invalid',
        'Confirm only the next generated child gitlink at a time'
      )
    }
    for (const step of state.steps) {
      if (step.status === 'succeeded') {
        continue
      }
      if (step.status === 'unknown') {
        state.terminal = 'unknown'
        return resultSnapshot(state, 'unknown')
      }
      if (step.status === 'failed') {
        state.terminal = 'failed'
        return resultSnapshot(state, 'failed')
      }
      if (step.kind === 'stageGitlink') {
        const childId = step.childContextId!
        const childOid = state.committedOids.get(childId) ?? state.initialHeads.get(childId)
        if (!childOid || !FULL_OID.test(childOid)) {
          throw new GitMutationError('stale', 'Child has no verified commit OID for the gitlink')
        }
        step.childOid = childOid
        step.status = 'needs-confirmation'
        if (!nextConfirmation || !confirmationMatches(nextConfirmation, step, childOid)) {
          return resultSnapshot(state, 'paused')
        }
        nextConfirmation = undefined
      } else if (nextConfirmation) {
        throw new GitMutationError(
          'invalid',
          'Confirmation does not match the next required gitlink'
        )
      }
      step.status = 'running'
      let mutationSucceeded = false
      try {
        if (step.kind === 'verifyRemote') {
          const childOid =
            state.committedOids.get(step.childContextId!) ??
            state.initialHeads.get(step.childContextId!)
          if (!childOid) {
            throw new GitMutationError(
              'stale',
              'Child commit has no verified OID for remote reachability'
            )
          }
          step.childOid = childOid
          await assertDependencies(state, options)
          await verifyChildRemote(state, step, options)
        } else {
          const receipt = await executeMutation(state, step, options)
          if (receipt.outcome === 'unknown') {
            step.status = 'unknown'
            step.error = safeGitMessage(
              receipt.error ?? 'The Git operation outcome is unknown; inspect before continuing'
            )
            step.errorCategory = receipt.errorCategory ?? 'unknown-outcome'
            state.terminal = 'unknown'
            return resultSnapshot(state, 'unknown')
          }
          if (receipt.outcome !== 'succeeded') {
            step.status = 'failed'
            step.error = safeGitMessage(receipt.error ?? `${step.kind} failed`)
            step.errorCategory = receipt.errorCategory ?? 'git-error'
            state.terminal = 'failed'
            return resultSnapshot(state, 'failed')
          }
          mutationSucceeded = true
          if (step.kind === 'stageGitlink') {
            await recordStagedGitlink(
              state,
              step.contextId,
              step.filePath!,
              step.childOid!,
              options
            )
          }
          if (step.kind === 'stageGitlink') {
            const paths = state.stagedLinks.get(step.contextId) ?? new Set<string>()
            paths.add(step.filePath!)
            state.stagedLinks.set(step.contextId, paths)
          }
          if (step.kind === 'commit') {
            const oid = receipt.commit?.head ?? receipt.head
            if (!oid || !FULL_OID.test(oid)) {
              step.status = 'unknown'
              step.error =
                'Commit completed without a verifiable resulting HEAD; inspect Git before continuing'
              step.errorCategory = 'unknown-outcome'
              state.terminal = 'unknown'
              return resultSnapshot(state, 'unknown')
            }
            state.committedOids.set(step.contextId, oid)
            const destination = state.publication.get(step.contextId)
            if (destination) {
              state.currentRefs.set(step.contextId, oid)
            }
          }
          await (step.kind === 'commit'
            ? reconcileCommitFences(state, step.contextId, receipt, options)
            : updateFence(state, step.contextId, options, receipt.expectedState))
          if (step.kind === 'stageGitlink') {
            await updateFence(
              state,
              step.childContextId!,
              options,
              state.expectedStates.get(step.childContextId!)
            )
          }
        }
        step.status = 'succeeded'
        delete step.error
        delete step.errorCategory
      } catch (error) {
        const unknown =
          mutationSucceeded ||
          (error instanceof GitMutationError &&
            (error.category === 'unknown-outcome' || error.unknownOutcome))
        step.status = unknown ? 'unknown' : 'failed'
        step.error = safeGitMessage(error)
        step.errorCategory = unknown
          ? 'unknown-outcome'
          : error instanceof GitMutationError
            ? error.category
            : 'git-error'
        state.terminal = unknown ? 'unknown' : 'failed'
        return resultSnapshot(state, state.terminal)
      }
    }
    state.terminal = 'completed'
    return resultSnapshot(state, 'completed')
  } finally {
    state.running = false
  }
}
