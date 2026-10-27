import { useEffect, useRef, useState } from 'react'
import type {
  GitMutationProgress,
  GitMutationReceipt,
  GitWorkspaceMutationRequest,
  GitWorkspaceOperationReceipt
} from '../../../../../../shared/git-workspace-mutation'
import type { RepositoryState } from '../../../../../../shared/git-workspace-types'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import type { WorkspaceNotice } from './use-workspace-mutations'
import { mutateRuntimeGitWorkspace } from '@/runtime/runtime-git-working-tree-client'
import { subscribeRuntimeGitMutationProgress } from '@/runtime/runtime-git-progress-client'
import { createBrowserUuid } from '@/lib/browser-uuid'

export type WorkspaceBranchActions = {
  busy: string | null
  notice: WorkspaceNotice | null
  progress: GitMutationProgress | null
  lastOperation: GitWorkspaceOperationReceipt | null
  checkout: (refName: string) => void
  createBranch: (name: string, startRef?: string) => void
  fetch: (remote: string, branch?: string) => void
  push: (remote: string, refName: string, expectedRefOid: string, setUpstream: boolean) => void
  merge: (refName: string) => void
  rebase: (refName: string) => void
  continueOperation: () => void
  abortOperation: () => void
}

const NETWORK_ACTION: Record<string, true> = { fetch: true, push: true }

function shortRef(refName: string | undefined): string {
  return refName?.replace(/^refs\/(?:heads|remotes|tags)\//, '') ?? 'revision'
}

export function describeOperation(operation: GitWorkspaceOperationReceipt): string {
  switch (operation.kind) {
    case 'checkout':
      return operation.detached
        ? `Detached HEAD at ${operation.oid?.slice(0, 10) ?? 'the selected revision'}`
        : `Checked out ${shortRef(operation.branch ?? operation.refName)}`
    case 'createBranch':
      return `Created and checked out ${shortRef(operation.branch)}`
    case 'fetch':
      return `Fetched ${operation.remote ?? 'remote'}${operation.refName ? ` ${shortRef(operation.refName)}` : ''}`
    case 'push':
      return `Pushed ${shortRef(operation.refName)} to ${operation.remote ?? 'remote'}`
    case 'merge':
      return operation.detail === 'already-up-to-date'
        ? 'Already up to date; nothing merged'
        : `Merged ${shortRef(operation.refName)} (${operation.detail ?? 'completed'})`
    case 'rebase':
      return `Rebased onto ${shortRef(operation.refName)}`
    case 'continue':
      return 'Git operation continued and completed'
    case 'abort':
      return 'Git operation aborted'
    default:
      return 'Git operation completed'
  }
}

/**
 * The HEAD returned by the last host action is more recent than a snapshot that
 * was already in flight. These maps survive a popup remount so a quick action
 * cannot fall back to an older reviewed HEAD; a changed snapshot prop still wins
 * because it means a newer host read arrived.
 */
const receiptHeads = new Map<string, string>()
const seenPropHeads = new Map<string, string>()

function initialHead(contextId: string, propHead: string): string {
  const seen = seenPropHeads.get(contextId)
  if (seen !== undefined && seen !== propHead) {
    return propHead
  }
  return receiptHeads.get(contextId) ?? propHead
}

/**
 * Branch/remote writes for one authorized Git context. Every request carries the
 * host-issued context id and the last snapshot state; nothing is retried, and an
 * unknown outcome remains unknown until the snapshot is refreshed.
 */
export function useWorkspaceBranchActions(args: {
  repository: RepositoryState
  context: RuntimeGitContext
  onRefresh: () => void
}): WorkspaceBranchActions {
  const { repository, context, onRefresh } = args
  const contextId = repository.context.id
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<WorkspaceNotice | null>(null)
  const [progress, setProgress] = useState<GitMutationProgress | null>(null)
  const [lastOperation, setLastOperation] = useState<GitWorkspaceOperationReceipt | null>(null)
  const propHead = repository.head ?? ''
  const [head, setHead] = useState(() => initialHead(contextId, propHead))
  const lastPropHead = useRef(propHead)

  useEffect(() => {
    setHead(initialHead(contextId, propHead))
    lastPropHead.current = propHead
    seenPropHeads.set(contextId, propHead)
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- reset the local fence only on a context change; later prop changes are handled below.
  }, [contextId])

  useEffect(() => {
    // Follow a real external HEAD change, but never let a stale prop snapshot
    // overwrite the HEAD returned by the action receipt that just ran.
    if (lastPropHead.current !== propHead) {
      lastPropHead.current = propHead
      seenPropHeads.set(contextId, propHead)
      receiptHeads.set(contextId, propHead)
      setHead(propHead)
    }
  }, [contextId, propHead])

  useEffect(() => {
    setNotice(null)
    setProgress(null)
    setLastOperation(null)
  }, [contextId])

  const run = async (
    request: GitWorkspaceMutationRequest,
    label: string
  ): Promise<GitMutationReceipt | null> => {
    if (busy) {
      return null
    }
    const fenceHead = request.action !== 'fetch' && request.action !== 'push'
    setBusy(label)
    setNotice(null)
    setProgress(null)
    const progressId =
      NETWORK_ACTION[request.action] === true
        ? `git-${request.action}-${createBrowserUuid()}`
        : undefined
    const stop = progressId
      ? await subscribeRuntimeGitMutationProgress(context, progressId, setProgress)
      : () => {}
    try {
      const receipt = await mutateRuntimeGitWorkspace(context, {
        ...request,
        contextId,
        ...(fenceHead ? { expectedHead: head } : {}),
        ...(progressId ? { progressId } : {})
      })
      if (receipt.outcome === 'succeeded') {
        setNotice({
          tone: 'ok',
          text: receipt.operation ? describeOperation(receipt.operation) : `${label} completed`
        })
      } else if (receipt.outcome === 'unknown') {
        setNotice({
          tone: 'warn',
          text: `${label}: outcome unknown. ${receipt.error ?? 'Verify the real Git state before retrying.'}`
        })
      } else {
        setNotice({ tone: 'error', text: receipt.error ?? `${label} failed` })
      }
      setLastOperation(receipt.operation ?? null)
      if (receipt.head !== undefined) {
        receiptHeads.set(contextId, receipt.head)
        setHead(receipt.head)
      }
      onRefresh()
      window.dispatchEvent(new CustomEvent('orca:git-workspace-refresh'))
      return receipt
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : `${label} failed`
      })
      onRefresh()
      return null
    } finally {
      stop()
      setProgress(null)
      setBusy(null)
    }
  }

  return {
    busy,
    notice,
    progress,
    lastOperation,
    checkout: (refName) => void run({ action: 'checkout', refName }, 'Checkout'),
    createBranch: (name, startRef) =>
      void run(
        {
          action: 'createBranch',
          branch: name,
          ...(startRef && startRef !== 'HEAD' ? { startRef } : {})
        },
        'Create branch'
      ),
    fetch: (remote, branch) =>
      void run({ action: 'fetch', remote, ...(branch ? { branch } : {}) }, `Fetch ${remote}`),
    push: (remote, refName, expectedRefOid, setUpstream) =>
      void run(
        {
          action: 'push',
          remote,
          refName,
          expectedRefOid,
          ...(setUpstream ? { setUpstream: true } : {})
        },
        'Push'
      ),
    merge: (refName) => void run({ action: 'merge', refName }, 'Merge'),
    rebase: (refName) => void run({ action: 'rebase', refName }, 'Rebase'),
    continueOperation: () => void run({ action: 'continueOperation' }, 'Continue operation'),
    abortOperation: () => void run({ action: 'abortOperation' }, 'Abort operation')
  }
}
