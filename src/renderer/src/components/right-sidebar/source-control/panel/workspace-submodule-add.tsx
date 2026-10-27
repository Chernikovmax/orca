import { useEffect, useState } from 'react'
import type { GitSubmoduleLifecyclePreview } from '../../../../../../shared/git-workspace-mutation'
import type { RepositoryState } from '../../../../../../shared/git-workspace-types'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import { mutateRuntimeGitWorkspace } from '@/runtime/runtime-git-working-tree-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function WorkspaceSubmoduleAdd({
  parent,
  context,
  onRefresh
}: {
  parent: RepositoryState
  context: RuntimeGitContext
  onRefresh: () => void
}) {
  const [url, setUrl] = useState('')
  const [path, setPath] = useState('')
  const [preview, setPreview] = useState<GitSubmoduleLifecyclePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setPreview(null)
    setError(null)
  }, [parent.context.id, parent.expectedState])
  const run = async (apply: boolean) => {
    setBusy(true)
    setError(null)
    if (!apply) {
      setPreview(null)
    }
    try {
      const receipt = await mutateRuntimeGitWorkspace(context, {
        action: apply ? 'submoduleAdd' : 'previewSubmoduleAdd',
        contextId: parent.context.id,
        expectedState: parent.expectedState,
        filePath: path,
        url,
        ...(apply && preview ? { previewId: preview.previewId } : {})
      })
      if (receipt.outcome !== 'succeeded') {
        setError(
          receipt.error ??
            (receipt.outcome === 'unknown'
              ? 'Outcome unknown; refresh to inspect state.'
              : 'Add failed')
        )
        if (apply) {
          setPreview(null)
          onRefresh()
        }
      } else if (apply) {
        setPreview(null)
        setUrl('')
        setPath('')
        onRefresh()
        window.dispatchEvent(new CustomEvent('orca:git-workspace-refresh'))
      } else if (receipt.preview && 'operation' in receipt.preview) {
        setPreview(receipt.preview)
      } else {
        setError('Add preview was not returned.')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Add failed')
      if (apply) {
        setPreview(null)
        onRefresh()
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <fieldset className="space-y-2 border-t border-border pt-2" data-testid="git-submodule-add">
      <legend className="font-medium">Add submodule to {parent.context.checkoutPath}</legend>
      <label className="block space-y-1">
        URL
        <Input
          disabled={busy}
          value={url}
          onChange={(event) => {
            setUrl(event.target.value)
            setPreview(null)
            setError(null)
          }}
        />
      </label>
      <label className="block space-y-1">
        Path relative to selected parent
        <Input
          disabled={busy}
          value={path}
          onChange={(event) => {
            setPath(event.target.value)
            setPreview(null)
            setError(null)
          }}
        />
      </label>
      <Button
        size="xs"
        variant="outline"
        disabled={busy || !url || !path}
        onClick={() => void run(false)}
      >
        Preview add
      </Button>
      {preview && (
        <div
          role="group"
          aria-label="Add review"
          className="space-y-1 rounded-md border border-border p-2"
        >
          <h3 className="font-medium">Review add</h3>
          <p className="break-all">Path in selected parent: {preview.filePath}</p>
          <p className="break-all">URL: {preview.declaredUrl ?? url}</p>
          {preview.effectiveUrl && (
            <p className="break-all">Effective URL: {preview.effectiveUrl}</p>
          )}
          {preview.changes.slice(0, 20).map((change) => (
            <p key={change}>{change}</p>
          ))}
          {preview.changes.length > 20 && <p>Showing 20 of {preview.changes.length} changes.</p>}
          {preview.warning && <p role="note">{preview.warning}</p>}
          <Button size="xs" disabled={busy} onClick={() => void run(true)}>
            Confirm add
          </Button>
        </div>
      )}
      {busy && <p aria-live="polite">Working…</p>}
      {error && (
        <p role="alert" className="break-words text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  )
}
