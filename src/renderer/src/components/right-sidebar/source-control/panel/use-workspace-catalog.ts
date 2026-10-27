import { useEffect, useRef, useState } from 'react'
import { getRuntimeGitStatus } from '@/runtime/runtime-git-status-client'
import { subscribeRuntimeFileChanges } from '@/runtime/runtime-file-watch-client'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import type { GitWorkspaceSnapshot } from '../../../../../../shared/git-workspace-types'
import { normalizeRuntimePathForComparison } from '../../../../../../shared/cross-platform-path'

export type WorkspaceCatalogModel = {
  context: RuntimeGitContext | null
  snapshot: GitWorkspaceSnapshot | null
  loading: boolean
  error: string | null
  selected: string | null
  setSelected: (id: string | null) => void
  refresh: () => void
  requestRefs: (id: string | undefined) => void
}

export function useWorkspaceCatalog(
  context: RuntimeGitContext | null,
  repoId: string
): WorkspaceCatalogModel {
  const [snapshot, setSnapshot] = useState<GitWorkspaceSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [refsContext, setRefsContext] = useState<string | undefined>()
  const canonicalRoot = useRef<string | undefined>(undefined)
  const readGeneration = useRef(0)
  const readController = useRef<AbortController | null>(null)
  const target = context?.target
  const worktreeId = context?.worktreeId
  const worktreePath = context?.worktreePath
  const connectionId = context?.connectionId
  const identity = `${target?.kind}:${connectionId ?? ''}:${worktreeId}:${worktreePath}`
  const [loadedIdentity, setLoadedIdentity] = useState(identity)

  useEffect(() => {
    setSnapshot(null)
    setSelected(null)
    setRefsContext(undefined)
    canonicalRoot.current = undefined
    setLoadedIdentity(identity)
  }, [identity])

  useEffect(() => {
    if (!target || !worktreePath) {
      return
    }
    const generation = ++readGeneration.current
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    const isCurrent = () => readGeneration.current === generation
    const load = async (retried: boolean): Promise<void> => {
      controller?.abort()
      controller = new AbortController()
      readController.current = controller
      setLoading(true)
      setError(null)
      try {
        const result = await getRuntimeGitStatus(
          { target, worktreeId, worktreePath, connectionId },
          {
            includeWorkspace: true,
            workspaceRefsContextId: refsContext,
            includeLineStats: false,
            signal: controller.signal
          }
        )
        if (!isCurrent()) {
          return
        }
        if (!result.workspace) {
          throw new Error(
            'This execution host does not support the Git context catalog; update the host and refresh.'
          )
        }
        setSnapshot(result.workspace)
        canonicalRoot.current = result.workspace.repositories.find(
          (item) => item.context.id === result.workspace?.rootContextId
        )?.context.checkoutPath
        setSelected((current) =>
          current && result.workspace?.repositories.some((item) => item.context.id === current)
            ? current
            : (result.workspace?.rootContextId ?? null)
        )
        setLoading(false)
      } catch (reason) {
        if (!isCurrent()) {
          return
        }
        const message = reason instanceof Error ? reason.message : 'Git catalog could not be loaded'
        // Why: a mutation invalidates in-flight reads; retry once instead of leaving the
        // panel on an old snapshot until the 15-second reconciliation tick.
        if (!retried && (reason instanceof Error && reason.name === 'AbortError')) {
          retryTimer = setTimeout(() => void load(true), 300)
          return
        }
        setError(message)
        setLoading(false)
      }
    }
    void load(false)
    return () => {
      readGeneration.current += 1
      if (retryTimer) {
        clearTimeout(retryTimer)
      }
      controller?.abort()
    }
  }, [target, worktreeId, worktreePath, connectionId, refreshVersion, refsContext])

  useEffect(() => {
    if (!target || !worktreePath) {
      return
    }
    let closed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      if (timer !== undefined) {
        return
      }
      timer = setTimeout(() => {
        timer = undefined
        if (!closed) {
          setRefreshVersion((value) => value + 1)
        }
      }, 300)
    }
    const stopMetadata = window.api.worktrees.onGitStatusMetadataChanged((event) => {
      if (event.repoId === repoId) {
        schedule()
      }
    })
    let stopFiles: (() => void) | undefined
    void subscribeRuntimeFileChanges(
      { target, worktreeId, worktreePath, connectionId },
      (event) => {
        const eventRoot = normalizeRuntimePathForComparison(event.worktreePath)
        const sameRoot = [worktreePath, canonicalRoot.current].some(
          (root) => root !== undefined && normalizeRuntimePathForComparison(root) === eventRoot
        )
        if (sameRoot && (event.connectionId ?? undefined) === connectionId) {
          schedule()
        }
      },
      schedule
    )
      .then((stop) => {
        if (closed) {
          stop()
        } else {
          stopFiles = stop
        }
      })
      .catch(schedule)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        schedule()
      }
    }
    const onMutation = () => schedule()
    window.addEventListener('orca:git-workspace-refresh', onMutation)
    window.addEventListener('focus', schedule)
    document.addEventListener('visibilitychange', onVisibility)
    const reconcile = setInterval(onVisibility, 15_000)
    return () => {
      closed = true
      clearTimeout(timer)
      clearInterval(reconcile)
      stopMetadata()
      stopFiles?.()
      window.removeEventListener('orca:git-workspace-refresh', onMutation)
      window.removeEventListener('focus', schedule)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [target, worktreeId, worktreePath, connectionId, repoId])

  return {
    context,
    snapshot: loadedIdentity === identity ? snapshot : null,
    loading,
    error,
    selected,
    setSelected,
    refresh: () => setRefreshVersion((value) => value + 1),
    requestRefs: setRefsContext
  }
}
