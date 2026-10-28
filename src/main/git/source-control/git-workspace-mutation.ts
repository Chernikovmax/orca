import type {
  GitMutationReceipt,
  GitWorkspaceMutationRequest
} from '../../../shared/git-workspace-mutation'
import type { GetStatusOptions } from './get-status-options'
import { verifyWorkspaceContext } from './git-workspace-context'
import { validateDiffPath } from './git-diff-path'
import { withGitMutationQueue } from './git-mutation-queue'
import { discardChanges } from './discard-changes'
import { invalidateGitReadCaches } from './git-read-cache-invalidation'
import {
  GitMutationError,
  classifyMutationError,
  failedOperation,
  isUnknownOutcome
} from './git-workspace-mutation-error'
import {
  readAuthorizedWorkspace,
  readFreshState,
  refreshReceipt,
  submoduleForPath
} from './git-workspace-mutation-shared'
import { discardImpl, previewDiscardImpl } from './git-workspace-mutation-discard'
import { listRecoveriesImpl, restoreDiscardImpl } from './git-workspace-mutation-recovery'
import { commitImpl, previewCommitImpl } from './git-workspace-mutation-commit'
import { stageGitlinkImpl } from './git-workspace-mutation-gitlink'
import { checkoutImpl, createBranchImpl } from './git-workspace-branch-actions'
import { fetchImpl, pushImpl } from './git-workspace-sync'
import {
  abortOperationImpl,
  continueOperationImpl,
  mergeImpl,
  rebaseImpl
} from './git-workspace-integrate'
import { mutateGitWorkspaceBatch } from './git-workspace-batch-mutation'
import { previewSubmoduleLifecycle } from './git-workspace-submodule-preview'
import { applySubmoduleLifecycle } from './git-workspace-submodule-apply'
import { readConflictImpl } from './git-workspace-conflict-read'
import { saveConflictImpl, resolveConflictImpl } from './git-workspace-conflict-write'
import { stageOrUnstage } from './git-workspace-mutation-stage'

const HEAD_FENCED_ACTION: Record<string, true> = {
  checkout: true,
  createBranch: true,
  merge: true,
  rebase: true,
  continueOperation: true,
  abortOperation: true
}

async function runWrite(
  root: string,
  request: GitWorkspaceMutationRequest,
  options: GetStatusOptions
): Promise<GitMutationReceipt> {
  const initial = await readAuthorizedWorkspace(root, request, options)
  if (request.action === 'submoduleInitialize' || request.action === 'submoduleSyncUrl') {
    return applySubmoduleLifecycle(initial, request, options)
  }
  let queueContext = initial.context
  if (request.action === 'submoduleCheckout') {
    const entry = submoduleForPath(initial.workspace, initial.context, request.filePath ?? '')
    const child = initial.workspace.repositories.find(
      (repository) => repository.context.id === entry?.contextId
    )
    if (!child) {
      throw new GitMutationError(
        'incomplete',
        'Submodule checkout is unavailable until its child context is initialized'
      )
    }
    queueContext = child.context
  }
  return withGitMutationQueue(queueContext.checkoutPath, options, async () => {
    options.signal?.throwIfAborted()
    const resolved = await readAuthorizedWorkspace(root, request, options)
    await verifyWorkspaceContext(resolved.context, options)
    if (request.action === 'submoduleCheckout') {
      const child = submoduleForPath(resolved.workspace, resolved.context, request.filePath ?? '')
      if (child?.contextId !== queueContext.id) {
        throw new GitMutationError(
          'stale',
          'Submodule identity changed before its mutation queue was acquired'
        )
      }
    }
    if (HEAD_FENCED_ACTION[request.action] === true) {
      if (resolved.repository.incomplete) {
        throw new GitMutationError(
          'incomplete',
          'Git context discovery is incomplete; refresh and review the real state before writing'
        )
      }
      if (typeof request.expectedHead !== 'string') {
        throw new GitMutationError(
          'invalid',
          `${request.action} requires the reviewed HEAD; refresh before running it`
        )
      }
      if ((resolved.repository.head ?? '') !== request.expectedHead) {
        throw new GitMutationError(
          'stale',
          'HEAD changed since it was reviewed; refresh the context before running this action'
        )
      }
    }
    switch (request.action) {
      case 'saveConflict':
        return saveConflictImpl(resolved, request, options)
      case 'resolveConflict':
        return resolveConflictImpl(resolved, request, options)
      case 'stage':
      case 'unstage':
        return stageOrUnstage(resolved, request, options)
      case 'discard': {
        if (request.previewId === undefined && request.expectedState === undefined) {
          // Why: pre-existing callers (fix-it actions, file menu) keep the established
          // discard semantics; the workspace UI always previews and confirms first.
          await discardChanges(
            resolved.context.checkoutPath,
            validateDiffPath(request.filePath ?? ''),
            { ...options, admissionTier: 'interactive' }
          )
          return { action: 'discard', outcome: 'succeeded' }
        }
        return discardImpl(resolved, request, options)
      }
      case 'restoreDiscard':
        return restoreDiscardImpl(resolved, request, options)
      case 'commit':
        return commitImpl(resolved, request, options)
      case 'stageGitlink':
        await stageGitlinkImpl(resolved, request, options)
        return { action: 'stageGitlink', outcome: 'succeeded' }
      case 'checkout':
        return checkoutImpl(resolved, request, options)
      case 'createBranch':
        return createBranchImpl(resolved, request, options)
      case 'fetch':
        return fetchImpl(resolved, request, options)
      case 'push':
        return pushImpl(resolved, request, options)
      case 'merge':
        return mergeImpl(resolved, request, options)
      case 'rebase':
        return rebaseImpl(resolved, request, options)
      case 'continueOperation':
        return continueOperationImpl(resolved, options)
      case 'abortOperation':
        return abortOperationImpl(resolved, options)
      case 'submoduleCheckout':
      case 'submoduleAdd':
      case 'submoduleRemove':
        return applySubmoduleLifecycle(resolved, request, options)
      default:
        throw new GitMutationError(
          'invalid',
          `Unsupported Git mutation action: ${String(request.action)}`
        )
    }
  })
}

/**
 * The single host entry point for Git writes requested by the workspace UI.
 * It re-authorizes the context, enforces the issued state/content fences, runs
 * inside the common-git-dir queue and always reports the real outcome.
 */
export async function mutateGitWorkspace(
  root: string,
  request: GitWorkspaceMutationRequest,
  options: GetStatusOptions = {}
): Promise<GitMutationReceipt> {
  let started = false
  try {
    if (!request || typeof request.action !== 'string') {
      throw new GitMutationError('invalid', 'Missing Git mutation request')
    }
    if (request.action === 'previewBatch' || request.action === 'runBatch') {
      started = request.action === 'runBatch' && request.batchRun?.inspectOnly !== true
      return await mutateGitWorkspaceBatch(root, request, options)
    }
    if (request.action === 'readConflict') {
      const resolved = await readAuthorizedWorkspace(root, request, options)
      const conflict = await readConflictImpl(resolved, request, options)
      return refreshReceipt(
        { action: request.action, outcome: 'succeeded', conflict },
        resolved.repository
      )
    }
    if (request.action === 'previewCommit') {
      const resolved = await readAuthorizedWorkspace(root, request, options)
      const preview = await previewCommitImpl(resolved)
      return refreshReceipt(
        { action: request.action, outcome: 'succeeded', preview },
        resolved.repository
      )
    }
    if (request.action === 'previewDiscard') {
      const resolved = await readAuthorizedWorkspace(root, request, options)
      const preview = await previewDiscardImpl(resolved, request, options)
      return refreshReceipt(
        { action: request.action, outcome: 'succeeded', preview },
        resolved.repository
      )
    }
    if (request.action === 'listRecoveries') {
      const resolved = await readAuthorizedWorkspace(root, request, options)
      const recoveries = await listRecoveriesImpl(resolved)
      return refreshReceipt(
        { action: request.action, outcome: 'succeeded', recoveries },
        resolved.repository
      )
    }
    if (request.action.startsWith('previewSubmodule')) {
      const resolved = await readAuthorizedWorkspace(root, request, options)
      const receipt = await previewSubmoduleLifecycle(resolved, request, options)
      return refreshReceipt(receipt, resolved.repository)
    }
    started = true
    const receipt = await runWrite(root, request, options)
    const fresh = await readFreshState(root, request, options)
    return refreshReceipt(receipt, fresh)
  } catch (error) {
    const classified = classifyMutationError(error)
    const unknown = started && isUnknownOutcome(error, options.signal)
    const fresh = started ? await readFreshState(root, request, options) : undefined
    const operation = failedOperation(request, fresh)
    return refreshReceipt(
      {
        action: request.action,
        outcome: unknown ? 'unknown' : 'failed',
        error: unknown
          ? `${classified.message}\nThe outcome is unknown. Verify the real Git state before retrying; nothing is retried automatically.`
          : classified.message,
        errorCategory: unknown ? 'unknown-outcome' : classified.category,
        ...(operation ? { operation } : {})
      },
      fresh
    )
  } finally {
    if (started) {
      invalidateGitReadCaches()
    }
  }
}
