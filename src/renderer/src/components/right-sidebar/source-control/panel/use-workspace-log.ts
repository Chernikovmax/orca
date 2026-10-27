import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitHistoryItem, GitHistoryItemRef } from '../../../../../../shared/git-history'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import { getRuntimeGitHistory } from '@/runtime/runtime-git-status-client'
import {
  appendWorkspaceHistoryPage,
  EMPTY_WORKSPACE_HISTORY,
  startWorkspaceHistory,
  type WorkspaceHistoryState
} from './workspace-log-model'

const PAGE_SIZE = 50

export type WorkspaceLogFilters = { revision: string; path: string; message: string }

export type WorkspaceLogStatus = 'idle' | 'loading' | 'ready' | 'error' | 'refreshing'

export type WorkspaceLogMeta = {
  currentRef?: GitHistoryItemRef
  remoteRef?: GitHistoryItemRef
  baseRef?: GitHistoryItemRef
  mergeBase?: string
}

export type WorkspaceLogModel = {
  status: WorkspaceLogStatus
  items: GitHistoryItem[]
  empty: boolean
  hasMore: boolean
  error: string | null
  notice: string | null
  loadingMore: boolean
  meta: WorkspaceLogMeta
  filters: WorkspaceLogFilters
  setRevision: (value: string) => void
  setPath: (value: string) => void
  setMessage: (value: string) => void
  refresh: () => void
  loadMore: () => void
}

/**
 * Paged, pinned history for one host-issued Git context. `signature` is the
 * observed HEAD/refs identity: when it changes, the list restarts from a fresh
 * first page, and a continuation page carrying the old generation is dropped
 * instead of being appended.
 */
export function useWorkspaceLog({
  context,
  contextId,
  signature,
  enabled,
  revision
}: {
  context: RuntimeGitContext | null
  contextId: string | null
  signature: string
  enabled: boolean
  /** Revision requested by the entry point; changing it restarts with that filter. */
  revision?: string | null
}): WorkspaceLogModel {
  const [filters, setFilters] = useState<WorkspaceLogFilters>({
    revision: revision ?? '',
    path: '',
    message: ''
  })
  const [state, setState] = useState<WorkspaceHistoryState>(EMPTY_WORKSPACE_HISTORY)
  const [status, setStatus] = useState<WorkspaceLogStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [meta, setMeta] = useState<WorkspaceLogMeta>({})
  const stateRef = useRef(state)
  const requestSeq = useRef(0)
  const controller = useRef<AbortController | null>(null)

  const commitState = useCallback((next: WorkspaceHistoryState) => {
    stateRef.current = next
    setState(next)
  }, [])

  useEffect(() => {
    commitState(EMPTY_WORKSPACE_HISTORY)
    setFilters({ revision: revision ?? '', path: '', message: '' })
    setError(null)
    setNotice(null)
    setMeta({})
    setStatus('idle')
  }, [commitState, contextId, revision])

  const runFirstPage = useCallback(async () => {
    if (!context || !contextId) {
      return
    }
    const requestId = requestSeq.current + 1
    requestSeq.current = requestId
    controller.current?.abort()
    const abort = new AbortController()
    controller.current = abort
    setStatus(stateRef.current.items.length ? 'refreshing' : 'loading')
    setError(null)
    try {
      const result = await getRuntimeGitHistory(context, {
        contextId,
        limit: PAGE_SIZE,
        ...(filters.revision ? { revision: filters.revision } : {}),
        ...(filters.path.trim() ? { path: filters.path.trim() } : {}),
        ...(filters.message.trim() ? { message: filters.message.trim() } : {})
      })
      if (requestSeq.current !== requestId) {
        return
      }
      commitState(startWorkspaceHistory(result))
      setMeta({
        currentRef: result.currentRef,
        remoteRef: result.remoteRef,
        baseRef: result.baseRef,
        mergeBase: result.mergeBase
      })
      setStatus('ready')
    } catch (failure) {
      if (requestSeq.current !== requestId || abort.signal.aborted) {
        return
      }
      setError(
        failure instanceof Error ? failure.message : 'Git history could not be loaded for this context.'
      )
      setStatus('error')
    }
  }, [commitState, context, contextId, filters.message, filters.path, filters.revision])

  const loadMore = useCallback(() => {
    if (!context || !contextId || loadingMore || !stateRef.current.cursor) {
      return
    }
    const requestId = requestSeq.current + 1
    requestSeq.current = requestId
    const cursor = stateRef.current.cursor
    setLoadingMore(true)
    void (async () => {
      try {
        const result = await getRuntimeGitHistory(context, {
          contextId,
          limit: PAGE_SIZE,
          ...(filters.revision ? { revision: filters.revision } : {}),
          ...(filters.path.trim() ? { path: filters.path.trim() } : {}),
          ...(filters.message.trim() ? { message: filters.message.trim() } : {}),
          cursor
        })
        if (requestSeq.current !== requestId) {
          return
        }
        const applied = appendWorkspaceHistoryPage(stateRef.current, result)
        if (applied.outcome === 'restart') {
          setNotice('Refs changed since this history was loaded; reloading the first page.')
          void runFirstPage()
          return
        }
        if (applied.outcome === 'appended') {
          commitState(applied.state)
        }
      } catch (failure) {
        if (requestSeq.current !== requestId) {
          return
        }
        setError(
          failure instanceof Error ? failure.message : 'The next history page could not be loaded.'
        )
      } finally {
        if (requestSeq.current === requestId) {
          setLoadingMore(false)
        }
      }
    })()
  }, [commitState, context, contextId, filters.message, filters.path, filters.revision, loadingMore, runFirstPage])

  useEffect(() => {
    setNotice(null)
  }, [filters.message, filters.path, filters.revision, contextId])

  useEffect(() => {
    if (!enabled) {
      return
    }
    void runFirstPage()
  }, [enabled, runFirstPage, signature])

  useEffect(() => {
    return () => {
      controller.current?.abort()
    }
  }, [])

  return {
    status,
    items: state.items,
    empty: state.empty,
    hasMore: state.hasMore,
    error,
    notice,
    loadingMore,
    meta,
    filters,
    setRevision: (revision) =>
      setFilters((current) =>
        current.revision === revision ? current : { ...current, revision }
      ),
    setPath: (path) =>
      setFilters((current) => (current.path === path ? current : { ...current, path })),
    setMessage: (message) =>
      setFilters((current) => (current.message === message ? current : { ...current, message })),
    refresh: () => {
      setNotice(null)
      void runFirstPage()
    },
    loadMore
  }
}
