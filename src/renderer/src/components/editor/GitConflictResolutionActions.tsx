import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAppStore } from '@/store'
import { requestGitContextPopup } from '@/lib/git-context-popup-command'
import type { OpenFile } from '@/store/slices/editor'
import type {
  GitConflictResolution,
  GitWorkspaceConflictDocument
} from '../../../../shared/git-workspace-conflict'
import type { GitWorkspaceSnapshot } from '../../../../shared/git-workspace-types'

export function GitConflictResolutionActions({
  file,
  document,
  workspace,
  disabled,
  dirty,
  onResolve,
  onInspectChild
}: {
  file: OpenFile
  document: GitWorkspaceConflictDocument
  workspace: GitWorkspaceSnapshot | null
  disabled: boolean
  dirty: boolean
  onResolve: (resolution: GitConflictResolution, childOid?: string) => Promise<void>
  onInspectChild: () => Promise<void>
}) {
  const [childOid, setChildOid] = useState('')
  const parentPath = workspace?.submodules.find(
    (item) => item.contextId === document.contextId
  )?.path
  const modulePath = parentPath ? `${parentPath}/${document.filePath}` : document.filePath
  const module = workspace?.submodules.find(
    (item) => item.parentContextId === document.contextId && item.path === modulePath
  )
  const child = workspace?.repositories.find((item) => item.context.id === module?.contextId)
  const openChild = (branchMenu: boolean) => {
    if (!child) {
      return
    }
    useAppStore.getState().setRightSidebarTab('source-control')
    window.dispatchEvent(
      new CustomEvent('orca:git-context-changes', {
        detail: {
          contextId: child.context.id,
          rootPath: file.gitConflict?.rootPath ?? file.gitDiffRootPath,
          worktreeId: file.worktreeId
        }
      })
    )
    if (branchMenu) {
      requestAnimationFrame(requestGitContextPopup)
    }
  }
  return (
    <section
      aria-label="Explicit conflict resolution"
      className="space-y-2 border-t border-border p-2 text-xs"
    >
      <p className="text-muted-foreground">
        Mark Resolved updates the real index. Side choices preserve exact bytes and modes; an absent
        side means deletion.
      </p>
      {dirty && (
        <p role="status">
          Save the result or reload it before choosing a whole-file side. Your draft is retained.
        </p>
      )}
      <div className="flex flex-wrap gap-1">
        <Button
          size="xs"
          variant="outline"
          disabled={disabled || dirty}
          onClick={() => void onResolve('ours')}
        >
          Mark resolved using ours
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={disabled || dirty}
          onClick={() => void onResolve('theirs')}
        >
          Mark resolved using theirs
        </Button>
        <Button
          size="xs"
          variant="destructive"
          disabled={disabled || dirty}
          onClick={() => void onResolve('delete')}
        >
          Delete and mark resolved
        </Button>
      </div>
      {document.kind === 'gitlink' && (
        <section
          aria-label="Gitlink resolution"
          className="space-y-2"
          data-testid="git-conflict-gitlink"
        >
          <p className="font-mono break-all">
            Ours: {document.ours.oid ?? 'absent'}
            <br />
            Theirs: {document.theirs.oid ?? 'absent'}
          </p>
          <p>
            Record a reviewed side above, or a locally available resulting child commit below. The
            parent does not checkout, reset, stash, stage or commit child files.
          </p>
          {child ? (
            <>
              <p className="break-all">
                Child {module?.path} · {child.branch ?? 'detached HEAD'}
                <br />
                <span className="font-mono">{child.head ?? 'unborn'}</span>
              </p>
              <div className="flex flex-wrap gap-1">
                <Button size="xs" variant="outline" onClick={() => openChild(false)}>
                  Open child Changes
                </Button>
                <Button size="xs" variant="outline" onClick={() => openChild(true)}>
                  Open child branch menu
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => void onInspectChild()}
                >
                  Refresh child state
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={disabled || !child.head}
                  onClick={() => setChildOid(child.head ?? '')}
                >
                  Use inspected child HEAD
                </Button>
              </div>
              <p className="text-muted-foreground">
                For a new result, use New Branch in the child branch menu if detached, then stage
                and commit in child Changes. Refresh child state and explicitly record the resulting
                OID here.
              </p>
            </>
          ) : (
            <p>
              Child checkout unavailable. Reviewed side OIDs can still be recorded; creating a
              result requires an authorized local child checkout.
            </p>
          )}
          <label className="block space-y-1">
            <span>Resulting child commit OID</span>
            <Input
              aria-label="Resulting child commit OID"
              value={childOid}
              disabled={disabled || !child}
              onChange={(event) => setChildOid(event.target.value)}
              className="font-mono"
            />
          </label>
          <Button
            size="xs"
            variant="outline"
            disabled={disabled || !child || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(childOid)}
            onClick={() => void onResolve('gitlink', childOid)}
          >
            Record child commit and mark resolved
          </Button>
        </section>
      )}
    </section>
  )
}
