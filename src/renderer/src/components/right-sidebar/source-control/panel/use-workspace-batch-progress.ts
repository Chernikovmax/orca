import { useEffect, useRef, useState } from 'react'
import type { GitWorkspaceBatchReceipt } from '../../../../../../shared/git-workspace-batch'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import { mutateRuntimeGitWorkspace } from '@/runtime/runtime-git-working-tree-client'

export function useWorkspaceBatchProgress(
  context: RuntimeGitContext,
  rootContextId: string | undefined,
  onProgress: (receipt: GitWorkspaceBatchReceipt) => void
) {
  const [previewId, setPreviewId] = useState<string | null>(null)
  const active = useRef<string | null>(null)
  useEffect(() => {
    if (!previewId || !rootContextId) {
      return
    }
    let live = true
    let timer: number | undefined
    const inspect = async () => {
      try {
        const result = await mutateRuntimeGitWorkspace(context, {
          action: 'runBatch',
          contextId: rootContextId,
          batchRun: { previewId, inspectOnly: true }
        })
        if (live && active.current === previewId && result.batch) {
          onProgress(result.batch)
        }
      } catch {
        // Progress reads do not decide the outcome of the in-flight mutation.
      } finally {
        if (live && active.current === previewId) {
          timer = window.setTimeout(() => void inspect(), 1000)
        }
      }
    }
    timer = window.setTimeout(() => void inspect(), 1000)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [context, rootContextId, previewId, onProgress])
  return {
    start: (id: string) => {
      active.current = id
      setPreviewId(id)
    },
    stop: () => {
      active.current = null
      setPreviewId(null)
    }
  }
}
