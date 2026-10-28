import { useCallback, useSyncExternalStore } from 'react'
import type { GitWorkspaceConflictDocument } from '../../../../shared/git-workspace-conflict'
import type { GitWorkspaceSnapshot } from '../../../../shared/git-workspace-types'

export type GitConflictDraft = {
  document: GitWorkspaceConflictDocument | null
  workspace: GitWorkspaceSnapshot | null
  content: string
  savedContent: string
  loaded: boolean
  busy: boolean
  stale: boolean
  resolved: boolean
  notice: { error: boolean; text: string } | null
  retained: { documentId: string; content: string }[]
}

const drafts = new Map<string, GitConflictDraft>()
const listeners = new Map<string, Set<() => void>>()

function releaseInactiveCleanDraft(key: string): void {
  const draft = drafts.get(key)
  if (
    draft &&
    !listeners.has(key) &&
    !draft.busy &&
    draft.loaded &&
    draft.content === draft.savedContent &&
    draft.retained.length === 0
  ) {
    drafts.delete(key)
  }
}

export function readGitConflictDraft(key: string): GitConflictDraft {
  let draft = drafts.get(key)
  if (!draft) {
    draft = {
      document: null,
      workspace: null,
      content: '',
      savedContent: '',
      loaded: false,
      busy: false,
      stale: false,
      resolved: false,
      notice: null,
      retained: []
    }
    drafts.set(key, draft)
  }
  return draft
}

export function updateGitConflictDraft(key: string, patch: Partial<GitConflictDraft>): void {
  drafts.set(key, { ...readGitConflictDraft(key), ...patch })
  for (const listener of listeners.get(key) ?? []) {
    listener()
  }
  releaseInactiveCleanDraft(key)
}

export function useGitConflictDraft(key: string): GitConflictDraft {
  const subscribe = useCallback(
    (listener: () => void) => {
      const subscriptions = listeners.get(key) ?? new Set<() => void>()
      listeners.set(key, subscriptions)
      subscriptions.add(listener)
      return () => {
        subscriptions.delete(listener)
        if (!subscriptions.size) {
          listeners.delete(key)
          releaseInactiveCleanDraft(key)
        }
      }
    },
    [key]
  )
  const snapshot = useCallback(() => readGitConflictDraft(key), [key])
  return useSyncExternalStore(subscribe, snapshot)
}
