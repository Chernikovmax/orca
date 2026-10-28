import { useCallback, useEffect } from 'react'
import type { GitConflictResolution } from '../../../../shared/git-workspace-conflict'
import type { GitWorkspaceMutationRequest } from '../../../../shared/git-workspace-mutation'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import { getRuntimeGitStatus } from '@/runtime/runtime-git-status-client'
import { mutateRuntimeGitWorkspace } from '@/runtime/runtime-git-working-tree-client'
import {
  readGitConflictDraft,
  updateGitConflictDraft,
  useGitConflictDraft
} from './git-conflict-drafts'
import { joinPath } from '@/lib/path'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'

export function useGitConflictDocument(
  key: string,
  context: RuntimeGitContext,
  filePath: string,
  absolutePath: string,
  contextId?: string
) {
  const draft = useGitConflictDraft(key)
  const load = useCallback(async (): Promise<void> => {
    const previous = readGitConflictDraft(key)
    if (previous.busy) {
      return
    }
    updateGitConflictDraft(key, { busy: true, notice: null })
    try {
      const status = await getRuntimeGitStatus(context, {
        includeWorkspace: true,
        includeLineStats: false
      })
      const workspace = status.workspace
      const matching = workspace?.repositories.filter(
        (item) =>
          normalizeRuntimePathForComparison(joinPath(item.context.checkoutPath, filePath)) ===
          normalizeRuntimePathForComparison(absolutePath)
      )
      const selectedId = contextId ?? (matching?.length === 1 ? matching[0].context.id : undefined)
      if (
        !workspace ||
        !selectedId ||
        !workspace.repositories.some((item) => item.context.id === selectedId)
      ) {
        throw new Error(
          'This checkout is no longer available on its execution host; reopen it from Changes.'
        )
      }
      const receipt = await mutateRuntimeGitWorkspace(context, {
        action: 'readConflict',
        contextId: selectedId,
        filePath
      })
      const document = receipt.conflict
      if (receipt.outcome !== 'succeeded' || !document) {
        throw new Error(receipt.error ?? 'The execution host did not return a conflict document.')
      }
      if (document.contextId !== selectedId || document.filePath !== filePath) {
        throw new Error(
          'The conflict response belongs to another context or file; nothing was applied.'
        )
      }
      const current = readGitConflictDraft(key)
      const retained =
        current.document && current.content !== current.savedContent
          ? [
              ...current.retained.filter(
                (item) => item.documentId !== current.document?.documentId
              ),
              { documentId: current.document.documentId, content: current.content }
            ]
          : current.retained
      const content = document.result.kind === 'text' ? document.result.content : ''
      updateGitConflictDraft(key, {
        document,
        workspace,
        content,
        savedContent: content,
        loaded: true,
        stale: false,
        resolved: false,
        retained,
        notice: null
      })
    } catch (error) {
      updateGitConflictDraft(key, {
        loaded: true,
        stale: true,
        notice: {
          error: true,
          text: error instanceof Error ? error.message : 'Conflict could not be loaded.'
        }
      })
    } finally {
      updateGitConflictDraft(key, { busy: false })
    }
  }, [key, context, contextId, filePath, absolutePath])
  useEffect(() => {
    const current = readGitConflictDraft(key)
    if (!current.loaded || current.resolved) {
      void load()
    }
  }, [key, load])

  const run = async (request: GitWorkspaceMutationRequest): Promise<void> => {
    const current = readGitConflictDraft(key)
    const document = current.document
    if (!document || current.busy || current.stale || current.resolved) {
      return
    }
    if (contextId && contextId !== document.contextId) {
      updateGitConflictDraft(key, {
        stale: true,
        notice: {
          error: true,
          text: 'The checkout context changed. Your old document draft is retained; reload explicitly before writing.'
        }
      })
      return
    }
    updateGitConflictDraft(key, { busy: true, notice: null })
    try {
      const receipt = await mutateRuntimeGitWorkspace(context, {
        ...request,
        contextId: document.contextId,
        documentId: document.documentId
      })
      if (receipt.outcome !== 'succeeded') {
        updateGitConflictDraft(key, {
          stale: true,
          notice: {
            error: true,
            text: `${receipt.error ?? 'Git refused the conflict action.'} Your draft is retained; Reload explicitly before another write.`
          }
        })
        return
      }
      if (request.action === 'saveConflict') {
        const next = receipt.conflict
        if (!next || next.contextId !== document.contextId || next.filePath !== filePath) {
          throw new Error(
            'Save outcome requires a fresh review; the host did not return the matching document.'
          )
        }
        updateGitConflictDraft(key, {
          document: next,
          savedContent: current.content,
          notice: {
            error: false,
            text: 'Saved to the worktree only. The index is still unresolved; Mark Resolved is separate.'
          }
        })
      } else {
        updateGitConflictDraft(key, {
          resolved: true,
          notice: {
            error: false,
            text: 'Resolved in the real Git index. Continue the operation from Changes or the branch menu.'
          }
        })
      }
      window.dispatchEvent(new CustomEvent('orca:git-workspace-refresh'))
    } catch (error) {
      updateGitConflictDraft(key, {
        stale: true,
        notice: {
          error: true,
          text: `${error instanceof Error ? error.message : 'Conflict action failed.'} Your draft is retained; reload the real state before retrying.`
        }
      })
    } finally {
      updateGitConflictDraft(key, { busy: false })
    }
  }

  const inspectChild = async (): Promise<void> => {
    if (readGitConflictDraft(key).busy) {
      return
    }
    updateGitConflictDraft(key, { busy: true })
    try {
      const status = await getRuntimeGitStatus(context, {
        includeWorkspace: true,
        includeLineStats: false
      })
      if (!status.workspace) {
        throw new Error('Child context discovery is unavailable on this host.')
      }
      updateGitConflictDraft(key, { workspace: status.workspace })
    } catch (error) {
      updateGitConflictDraft(key, {
        notice: {
          error: true,
          text: error instanceof Error ? error.message : 'Child context could not be inspected.'
        }
      })
    } finally {
      updateGitConflictDraft(key, { busy: false })
    }
  }
  return {
    draft,
    load,
    inspectChild,
    setContent: (content: string) => {
      if (!readGitConflictDraft(key).busy) {
        updateGitConflictDraft(key, { content })
      }
    },
    restoreDraft: (documentId: string) => {
      const current = readGitConflictDraft(key)
      const retained = current.retained.find((item) => item.documentId === documentId)
      if (retained && !current.busy) {
        updateGitConflictDraft(key, { content: retained.content })
      }
    },
    save: () => run({ action: 'saveConflict', content: readGitConflictDraft(key).content }),
    resolve: (resolution: GitConflictResolution, childOid?: string) =>
      run({ action: 'resolveConflict', resolution, childOid })
  }
}
