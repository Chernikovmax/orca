import { useEffect, useState } from 'react'
import type {
  GitCommitPreview,
  GitDiscardPreview,
  GitMutationReceipt,
  GitRecoveryEntry,
  GitWorkspaceMutationRequest
} from '../../../../../../shared/git-workspace-mutation'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { RepositoryState, SubmoduleEntry } from '../../../../../../shared/git-workspace-types'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import { mutateRuntimeGitWorkspace } from '@/runtime/runtime-git-working-tree-client'
import {
  clearWorkspaceCommitDraftIfUnchanged,
  readWorkspaceCommitDraft,
  writeWorkspaceCommitDraft
} from './workspace-commit-drafts'

export type WorkspaceNotice = { tone: 'ok' | 'warn' | 'error'; text: string }

export type WorkspaceMutations = {
  busy: string | null
  notice: WorkspaceNotice | null
  discardPreview: GitDiscardPreview | null
  lastRecovery: GitRecoveryEntry | null
  recoveries: GitRecoveryEntry[] | null
  commitPreview: GitCommitPreview | null
  draft: string
  setDraft: (value: string) => void
  stageEntry: (entry: GitStatusEntry) => void
  unstageEntry: (entry: GitStatusEntry) => void
  requestDiscard: (entry: GitStatusEntry) => void
  cancelDiscard: () => void
  confirmDiscard: () => Promise<void>
  loadRecoveries: () => Promise<void>
  restoreRecovery: (recovery: GitRecoveryEntry) => Promise<void>
  previewCommit: () => Promise<void>
  commit: () => Promise<void>
  stageGitlink: (entry: GitStatusEntry, module: SubmoduleEntry) => void
}

/**
 * All writes for one Git context. Every request carries the host-issued context id
 * and the last previewed state; no automatic retry, so an unknown outcome stays
 * unknown until the caller refreshes real state.
 */
export function useWorkspaceMutations(args: {
  repository: RepositoryState
  context: RuntimeGitContext
  onRefresh: () => void
}): WorkspaceMutations {
  const { repository, context, onRefresh } = args
  const contextId = repository.context.id
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<WorkspaceNotice | null>(null)
  const [discardPreview, setDiscardPreview] = useState<GitDiscardPreview | null>(null)
  const [lastRecovery, setLastRecovery] = useState<GitRecoveryEntry | null>(null)
  const [recoveries, setRecoveries] = useState<GitRecoveryEntry[] | null>(null)
  const [commitPreview, setCommitPreview] = useState<GitCommitPreview | null>(null)
  const [draft, setDraft] = useState(() => readWorkspaceCommitDraft(contextId))
  const [expectedState, setExpectedState] = useState(repository.expectedState)

  useEffect(() => {
    setExpectedState(repository.expectedState)
  }, [repository.expectedState, contextId])
  useEffect(() => {
    setDraft(readWorkspaceCommitDraft(contextId))
    setDiscardPreview(null)
    setLastRecovery(null)
    setRecoveries(null)
    setCommitPreview(null)
    setNotice(null)
  }, [contextId])

  const run = async (
    request: GitWorkspaceMutationRequest,
    label: string
  ): Promise<GitMutationReceipt | null> => {
    if (busy) {
      return null
    }
    setBusy(label)
    setNotice(null)
    try {
      const receipt = await mutateRuntimeGitWorkspace(context, request)
      if (receipt.outcome === 'succeeded') {
        setNotice({ tone: 'ok', text: `${label} completed` })
      } else if (receipt.outcome === 'unknown') {
        setNotice({ tone: 'warn', text: `${label}: outcome unknown. ${receipt.error ?? ''}` })
      } else {
        setNotice({ tone: 'error', text: receipt.error ?? `${label} failed` })
      }
      if (receipt.recovery) {
        setLastRecovery(receipt.recovery)
      }
      if (receipt.expectedState) {
        setExpectedState(receipt.expectedState)
      }
      onRefresh()
      window.dispatchEvent(new CustomEvent('orca:git-workspace-refresh'))
      return receipt
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : `${label} failed` })
      onRefresh()
      return null
    } finally {
      setBusy(null)
    }
  }

  const fileRequest = (
    action: 'stage' | 'unstage',
    entry: GitStatusEntry
  ): GitWorkspaceMutationRequest => ({
    action,
    contextId,
    expectedState,
    filePath: entry.path,
    ...(entry.oldPath ? { oldPath: entry.oldPath } : {})
  })

  const requestDiscard = (entry: GitStatusEntry): void => {
    void (async () => {
      setBusy('Preview discard')
      setNotice(null)
      try {
        const receipt = await mutateRuntimeGitWorkspace(context, {
          action: 'previewDiscard',
          contextId,
          expectedState,
          filePath: entry.path
        })
        if (receipt.outcome === 'succeeded' && receipt.preview) {
          setDiscardPreview(receipt.preview as GitDiscardPreview)
        } else {
          setNotice({ tone: 'error', text: receipt.error ?? 'Discard preview failed' })
        }
      } catch (error) {
        setNotice({
          tone: 'error',
          text: error instanceof Error ? error.message : 'Discard preview failed'
        })
      } finally {
        setBusy(null)
      }
    })()
  }

  const confirmDiscard = async (): Promise<void> => {
    if (!discardPreview) {
      return
    }
    const receipt = await run(
      {
        action: 'discard',
        contextId,
        expectedState,
        filePath: discardPreview.filePath,
        previewId: discardPreview.previewId
      },
      'Discard'
    )
    if (receipt?.outcome === 'succeeded') {
      setDiscardPreview(null)
    }
  }

  const loadRecoveries = async (): Promise<void> => {
    const receipt = await run(
      { action: 'listRecoveries', contextId, expectedState },
      'List recoveries'
    )
    if (receipt?.outcome === 'succeeded') {
      setRecoveries(receipt.recoveries ?? [])
      setNotice(null)
    }
  }

  const restoreRecovery = async (recovery: GitRecoveryEntry): Promise<void> => {
    const receipt = await run(
      { action: 'restoreDiscard', contextId, expectedState, recoveryId: recovery.id },
      'Restore copy'
    )
    if (receipt?.outcome !== 'succeeded') {
      return
    }
    setRecoveries((current) => current?.filter((item) => item.id !== recovery.id) ?? null)
    setLastRecovery((current) => (current?.id === recovery.id ? null : current))
  }

  const previewCommit = async (): Promise<void> => {
    const receipt = await run(
      { action: 'previewCommit', contextId, expectedState },
      'Preview commit'
    )
    if (receipt?.outcome === 'succeeded' && receipt.preview) {
      setCommitPreview(receipt.preview as GitCommitPreview)
      setNotice(null)
    }
  }

  const commit = async (): Promise<void> => {
    const message = draft.trim()
    if (!message) {
      setNotice({ tone: 'error', text: 'Commit message is required' })
      return
    }
    const receipt = await run(
      { action: 'commit', contextId, expectedState, message },
      'Commit'
    )
    if (receipt?.outcome === 'succeeded') {
      clearWorkspaceCommitDraftIfUnchanged(contextId, message)
      setDraft(readWorkspaceCommitDraft(contextId))
      setCommitPreview(null)
    }
  }

  return {
    busy,
    notice,
    discardPreview,
    lastRecovery,
    recoveries,
    commitPreview,
    draft,
    setDraft: (value: string) => {
      setDraft(value)
      writeWorkspaceCommitDraft(contextId, value)
    },
    stageEntry: (entry) => void run(fileRequest('stage', entry), 'Stage'),
    unstageEntry: (entry) => void run(fileRequest('unstage', entry), 'Unstage'),
    requestDiscard,
    cancelDiscard: () => setDiscardPreview(null),
    confirmDiscard,
    loadRecoveries,
    restoreRecovery,
    previewCommit,
    commit,
    stageGitlink: (entry, module) => {
      if (!module.currentOid) {
        return
      }
      void run(
        {
          action: 'stageGitlink',
          contextId,
          expectedState,
          filePath: entry.path,
          childOid: module.currentOid
        },
        'Stage gitlink'
      )
    }
  }
}
