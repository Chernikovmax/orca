import { useEffect, useState } from 'react'
import type {
  GitSubmoduleLifecyclePreview,
  GitWorkspaceMutationRequest
} from '../../../../../../shared/git-workspace-mutation'
import type {
  GitWorkspaceRef,
  SubmoduleEntry,
  RepositoryState
} from '../../../../../../shared/git-workspace-types'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import { mutateRuntimeGitWorkspace } from '@/runtime/runtime-git-working-tree-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { joinPath } from '@/lib/path'
import { relativePathInsideRoot } from '../../../../../../shared/cross-platform-path'

type Props = {
  entry: SubmoduleEntry
  parent: RepositoryState
  context: RuntimeGitContext
  workspaceRootPath: string
  remoteRefs: GitWorkspaceRef[]
  onLoadRemoteRefs: () => void
  onRefresh: () => void
}

const actionFor = {
  initialize: ['previewSubmoduleInitialize', 'submoduleInitialize'],
  checkout: ['previewSubmoduleCheckout', 'submoduleCheckout'],
  syncUrl: ['previewSubmoduleSyncUrl', 'submoduleSyncUrl'],
  remove: ['previewSubmoduleRemove', 'submoduleRemove']
} as const

type Operation = keyof typeof actionFor

export function WorkspaceSubmoduleActions({
  entry,
  parent,
  context,
  workspaceRootPath,
  remoteRefs,
  onLoadRemoteRefs,
  onRefresh
}: Props) {
  const [syncUrlDraft, setSyncUrlDraft] = useState<string | null>(null)
  const [recursive, setRecursive] = useState(false)
  const [target, setTarget] = useState<'index' | 'selected'>('index')
  const [selectedRemoteRef, setSelectedRemoteRef] = useState('')
  const [remoteRefQuery, setRemoteRefQuery] = useState('')
  const [operation, setOperation] = useState<Operation | null>(null)
  const [preview, setPreview] = useState<GitSubmoduleLifecyclePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => {
    setPreview(null)
    setOperation(null)
  }, [entry.contextId, entry.parentContextId, entry.path, parent.context.id, parent.expectedState])
  const localRemoteRefs = remoteRefs.filter(
    (ref) => ref.name.startsWith('refs/remotes/') && !ref.name.endsWith('/HEAD')
  )
  const availableRemoteRefs = localRemoteRefs.filter((ref) =>
    `${ref.name}\n${ref.oid}`.toLocaleLowerCase().includes(remoteRefQuery.toLocaleLowerCase())
  )
  const visibleRemoteRefs = availableRemoteRefs.slice(0, 128)
  const currentDeclaredUrl = entry.declaredUrls.at(-1) ?? entry.effectiveUrl ?? ''
  const syncUrlValue = syncUrlDraft ?? currentDeclaredUrl
  const invalidateReview = () => {
    setPreview(null)
    setOperation(null)
    setError(null)
  }

  const request = (kind: Operation, apply = false): GitWorkspaceMutationRequest => {
    const filePath = relativePathInsideRoot(
      parent.context.checkoutPath,
      joinPath(workspaceRootPath, entry.path)
    )
    if (!filePath) {
      throw new Error('Submodule path is outside the selected parent checkout.')
    }
    return {
      action: actionFor[kind][apply ? 1 : 0],
      contextId: entry.parentContextId,
      expectedState: parent.expectedState,
      filePath,
      ...(kind === 'syncUrl' && syncUrlDraft !== null ? { url: syncUrlDraft } : {}),
      ...(kind === 'initialize' ? { recursive } : {}),
      ...(kind === 'checkout' && target === 'index'
        ? { childOid: entry.indexOid ?? undefined }
        : {}),
      ...(kind === 'checkout' && target === 'selected' ? { refName: selectedRemoteRef } : {}),
      ...(apply && preview ? { previewId: preview.previewId } : {})
    }
  }

  const review = async (kind: Operation) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    setPreview(null)
    setOperation(null)
    try {
      const receipt = await mutateRuntimeGitWorkspace(context, request(kind))
      if (
        receipt.outcome !== 'succeeded' ||
        !receipt.preview ||
        !('operation' in receipt.preview)
      ) {
        setError(receipt.error ?? 'Preview failed')
        return
      }
      setOperation(kind)
      setPreview(receipt.preview)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Preview failed')
    } finally {
      setBusy(false)
    }
  }

  const apply = async () => {
    if (!operation || !preview) {
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const receipt = await mutateRuntimeGitWorkspace(context, request(operation, true))
      if (receipt.outcome === 'succeeded') {
        setNotice(`${operation} completed`)
        setPreview(null)
        setOperation(null)
        onRefresh()
        window.dispatchEvent(new CustomEvent('orca:git-workspace-refresh'))
      } else {
        setError(
          receipt.error ??
            (receipt.outcome === 'unknown'
              ? 'Outcome unknown; refresh to inspect state.'
              : 'Operation failed')
        )
        setPreview(null)
        setOperation(null)
        onRefresh()
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Operation failed')
      setPreview(null)
      setOperation(null)
      onRefresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-2 border-t border-border pt-2" data-testid="git-submodule-actions">
      <label className="block space-y-1">
        Replacement URL (optional)
        <Input
          disabled={busy}
          value={syncUrlValue}
          onChange={(event) => {
            const value = event.target.value
            setSyncUrlDraft(value === currentDeclaredUrl ? null : value)
            invalidateReview()
          }}
        />
      </label>
      <p role="note">
        Leave unchanged to synchronize the current declared URL to local config; no network request
        is made. A replacement is sent only after you edit this field.
      </p>
      <Button size="xs" variant="outline" disabled={busy} onClick={() => void review('syncUrl')}>
        Preview URL sync
      </Button>
      {!entry.contextId ? (
        <fieldset className="space-y-1">
          <legend className="font-medium">Initialize</legend>
          <label className="block space-y-1">
            Declared URL
            <Input value={entry.declaredUrls[0] ?? entry.effectiveUrl ?? ''} readOnly />
          </label>
          <label className="block space-y-1">
            Path
            <Input value={entry.path} readOnly />
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              disabled={busy}
              checked={recursive}
              onChange={(event) => {
                setRecursive(event.target.checked)
                invalidateReview()
              }}
            />
            Initialize descendants recursively
          </label>
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => void review('initialize')}
          >
            Review Initialize
          </Button>
        </fieldset>
      ) : (
        <>
          <fieldset className="space-y-1">
            <legend className="font-medium">Checkout</legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                disabled={busy}
                name={`checkout-${entry.path}`}
                checked={target === 'index'}
                onChange={() => {
                  setTarget('index')
                  invalidateReview()
                }}
              />
              Parent index OID ({entry.indexOid ?? 'unavailable'})
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                disabled={busy}
                name={`checkout-${entry.path}`}
                checked={target === 'selected'}
                onChange={() => {
                  setTarget('selected')
                  invalidateReview()
                  if (localRemoteRefs.length === 0) {
                    onLoadRemoteRefs()
                  }
                }}
              />
              Selected remote OID
            </label>
            {target === 'selected' && (
              <label className="block space-y-1">
                Filter local remote refs
                <Input
                  disabled={busy}
                  value={remoteRefQuery}
                  onChange={(event) => {
                    setRemoteRefQuery(event.target.value)
                    invalidateReview()
                  }}
                />
              </label>
            )}
            {target === 'selected' && (
              <label className="block space-y-1">
                Available remote-tracking ref
                <select
                  disabled={busy}
                  className="w-full rounded-md border border-input bg-background px-2 py-1"
                  value={selectedRemoteRef}
                  onChange={(event) => {
                    setSelectedRemoteRef(event.target.value)
                    invalidateReview()
                  }}
                >
                  <option value="">Select a local remote ref</option>
                  {visibleRemoteRefs.map((ref) => (
                    <option key={ref.name} value={ref.name}>
                      {ref.name} · {ref.oid}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {target === 'selected' && availableRemoteRefs.length > visibleRemoteRefs.length && (
              <p>
                Showing 128 of {availableRemoteRefs.length} matching local refs; filter to narrow
                the list.
              </p>
            )}
            {target === 'selected' && localRemoteRefs.length === 0 && (
              <Button size="xs" variant="outline" disabled={busy} onClick={onLoadRemoteRefs}>
                Load local remote refs
              </Button>
            )}
            {target === 'selected' && (
              <p role="note">
                Remote refs are read locally without network access. Checkout leaves the child in
                detached HEAD.
              </p>
            )}
            <Button
              size="xs"
              variant="outline"
              disabled={busy || (target === 'index' ? !entry.indexOid : !selectedRemoteRef)}
              onClick={() => void review('checkout')}
            >
              Preview checkout
            </Button>
          </fieldset>
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void review('remove')}>
            Preview remove
          </Button>
        </>
      )}
      {preview && operation && (
        <div
          role="group"
          aria-label="Operation review"
          className="space-y-1 rounded-md border border-border p-2"
        >
          <h3 className="font-medium">Review {operation}</h3>
          <p className="break-all">Workspace path: {entry.path}</p>
          <p className="break-all">Path in parent checkout: {preview.filePath}</p>
          {preview.previousDeclaredUrl && (
            <p className="break-all">Previous declared URL: {preview.previousDeclaredUrl}</p>
          )}
          {preview.declaredUrl && <p className="break-all">Declared URL: {preview.declaredUrl}</p>}
          {preview.previousEffectiveUrl && (
            <p className="break-all">Previous effective URL: {preview.previousEffectiveUrl}</p>
          )}
          {preview.effectiveUrl && (
            <p className="break-all">Effective URL: {preview.effectiveUrl}</p>
          )}
          {preview.refName && <p className="break-all">Remote-tracking ref: {preview.refName}</p>}
          {preview.targetOid && (
            <p className="break-all font-mono">Target OID: {preview.targetOid}</p>
          )}
          {preview.childExpectedState && (
            <p className="break-all">Child state reviewed: {preview.childExpectedState}</p>
          )}
          <p>Recursive: {preview.recursive ? 'Yes' : 'No'}</p>
          {preview.changes.slice(0, 20).map((change) => (
            <p key={change}>{change}</p>
          ))}
          {preview.changes.length > 20 && <p>Showing 20 of {preview.changes.length} changes.</p>}
          {preview.detached && (
            <p role="note">This checkout will leave the child in detached HEAD.</p>
          )}
          {preview.warning && <p role="note">{preview.warning}</p>}
          <Button
            size="xs"
            disabled={busy}
            variant={operation === 'remove' ? 'destructive' : 'default'}
            onClick={() => void apply()}
          >
            {operation === 'remove'
              ? 'Confirm remove'
              : operation === 'syncUrl'
                ? 'Sync URL'
                : operation === 'checkout'
                  ? 'Checkout'
                  : 'Initialize'}
          </Button>
        </div>
      )}
      {busy && <p aria-live="polite">Working…</p>}
      {error && (
        <p role="alert" className="break-words text-destructive">
          {error}
        </p>
      )}
      {notice && <p aria-live="polite">{notice}</p>}
    </section>
  )
}
