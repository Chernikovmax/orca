import { useEffect, useState } from 'react'
import type {
  GitWorkspaceBatchPreview,
  GitWorkspaceBatchReceipt,
  GitWorkspaceBatchRequest,
  GitWorkspaceBatchConfirmation
} from '../../../../../../shared/git-workspace-batch'
import type { GitWorkspaceMutationRequest } from '../../../../../../shared/git-workspace-mutation'
import type {
  GitWorkspaceRef,
  GitWorkspaceSnapshot
} from '../../../../../../shared/git-workspace-types'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import { mutateRuntimeGitWorkspace } from '@/runtime/runtime-git-working-tree-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { WorkspaceBatchReview } from './workspace-batch-review'
import { useWorkspaceBatchProgress } from './use-workspace-batch-progress'

export function WorkspaceBatchActions({
  snapshot,
  context,
  onRefresh,
  onRequestRefs
}: {
  snapshot: GitWorkspaceSnapshot
  context: RuntimeGitContext
  onRefresh: () => void
  onRequestRefs: (contextId: string) => void
}) {
  const repositories = snapshot.repositories
  const [selected, setSelected] = useState<string[]>([])
  const [recursive, setRecursive] = useState(false)
  const [messages, setMessages] = useState<Record<string, string>>({})
  const [commitSelected, setCommitSelected] = useState<string[]>([])
  const [publish, setPublish] = useState<string[]>([])
  const [remotes, setRemotes] = useState<Record<string, string>>({})
  const [refs, setRefs] = useState<Record<string, string>>({})
  const [oids, setOids] = useState<Record<string, string>>({})
  const [refsByContext, setRefsByContext] = useState<Record<string, GitWorkspaceRef[]>>({})
  const [preview, setPreview] = useState<GitWorkspaceBatchPreview | null>(null)
  const [receipt, setReceipt] = useState<GitWorkspaceBatchReceipt | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const progress = useWorkspaceBatchProgress(context, snapshot.rootContextId, setReceipt)
  useEffect(() => {
    const loaded = repositories.filter((repository) => repository.refs !== undefined)
    if (loaded.length === 0) {
      return
    }
    setRefsByContext((current) => {
      let next = current
      for (const repository of loaded) {
        const refs = repository.refs
        if (refs && current[repository.context.id] !== refs) {
          if (next === current) {
            next = { ...current }
          }
          next[repository.context.id] = refs
        }
      }
      return next
    })
  }, [repositories])
  const rootContextId = snapshot.rootContextId
  if (!rootContextId) {
    return null
  }
  const invalidateReview = () => {
    if (receipt) {
      return
    }
    setPreview(null)
    setConfirmed(false)
    setError(null)
  }
  const toggle = (items: string[], id: string, set: (next: string[]) => void) =>
    set(items.includes(id) ? items.filter((item) => item !== id) : [...items, id])
  const request = (): GitWorkspaceBatchRequest => ({
    rootContextId,
    contextIds: selected,
    recursive,
    commits: commitSelected.flatMap((contextId) => {
      if (!selected.includes(contextId) || !messages[contextId]?.trim()) {
        return []
      }
      const repository = repositories.find((item) => item.context.id === contextId)
      const stagedPaths =
        repository?.entries.filter((entry) => entry.area === 'staged').map((entry) => entry.path) ??
        []
      return [{ contextId, message: messages[contextId], stagedPaths }]
    }),
    publication: publish.flatMap((contextId) => {
      if (!selected.includes(contextId)) {
        return []
      }
      const refName = refs[contextId]
      const remote = remotes[contextId]
      const expectedRefOid = oids[contextId]
      return refName && remote && expectedRefOid
        ? [{ contextId, remote, refName, expectedRefOid }]
        : []
    })
  })
  const missingCommitMessage = commitSelected.some(
    (contextId) => selected.includes(contextId) && !messages[contextId]?.trim()
  )
  const incompletePublication = publish.some(
    (contextId) =>
      selected.includes(contextId) && (!remotes[contextId] || !refs[contextId] || !oids[contextId])
  )
  const hasWork = commitSelected.length > 0 || publish.length > 0
  const run = async (confirmation?: GitWorkspaceBatchConfirmation, retryFailed = false) => {
    if (!preview) {
      return
    }
    setBusy(true)
    setError(null)
    progress.start(preview.previewId)
    try {
      const req: GitWorkspaceMutationRequest = {
        action: 'runBatch',
        contextId: rootContextId,
        batchRun: {
          previewId: preview.previewId,
          ...(confirmation ? { confirmations: [confirmation] } : {}),
          ...(retryFailed ? { retryFailed: true } : {})
        }
      }
      const result = await mutateRuntimeGitWorkspace(context, req)
      if (!result.batch) {
        setError(result.error ?? 'Batch result was not returned.')
      } else {
        setReceipt(result.batch)
        setConfirmed(false)
        if (result.batch.workspace) {
          onRefresh()
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Batch run failed')
    } finally {
      setBusy(false)
      progress.stop()
    }
  }
  const review = async () => {
    setBusy(true)
    setError(null)
    setPreview(null)
    setReceipt(null)
    try {
      const req: GitWorkspaceMutationRequest = {
        action: 'previewBatch',
        contextId: rootContextId,
        batch: request()
      }
      const result = await mutateRuntimeGitWorkspace(context, req)
      if (!result.preview || !('steps' in result.preview)) {
        setError(result.error ?? 'Batch preview was not returned.')
      } else {
        setPreview(result.preview)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Batch preview failed')
    } finally {
      setBusy(false)
    }
  }
  const refreshProgress = async () => {
    if (!preview) {
      return
    }
    setBusy(true)
    try {
      const result = await mutateRuntimeGitWorkspace(context, {
        action: 'runBatch',
        contextId: rootContextId,
        batchRun: { previewId: preview.previewId, inspectOnly: true }
      })
      if (result.batch) {
        setReceipt(result.batch)
      } else {
        setError(result.error ?? 'Batch progress unavailable.')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Batch progress unavailable.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="space-y-2 border-t border-border pt-2" data-testid="git-workspace-batch">
      <h3 className="font-medium">Selected-context batch</h3>
      <fieldset className="space-y-1">
        <legend>Select repositories</legend>
        {repositories.slice(0, 128).map((repository) => (
          <label key={repository.context.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              disabled={busy || !!receipt}
              checked={selected.includes(repository.context.id)}
              onChange={() => {
                const id = repository.context.id
                if (selected.includes(id)) {
                  setSelected(selected.filter((item) => item !== id))
                  setCommitSelected(commitSelected.filter((item) => item !== id))
                  setPublish(publish.filter((item) => item !== id))
                } else {
                  setSelected([...selected, id])
                }
                invalidateReview()
              }}
            />
            {repository.context.id === rootContextId ? 'Root' : repository.context.checkoutPath}
          </label>
        ))}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            disabled={busy || !!receipt}
            checked={recursive}
            onChange={(event) => {
              setRecursive(event.target.checked)
              invalidateReview()
            }}
          />
          Include descendants recursively
        </label>
      </fieldset>
      {selected.map((id) => {
        const repository = repositories.find((item) => item.context.id === id)
        if (!repository) {
          return null
        }
        const localRefs = refsByContext[id] ?? repository.refs ?? []
        const localBranches = localRefs.filter(
          (ref) => ref.name === repository.branch && ref.name.startsWith('refs/heads/')
        )
        return (
          <fieldset key={id} className="space-y-1 border-t border-border pt-1">
            <legend>Commit and publication · {repository.context.checkoutPath}</legend>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                disabled={busy || !!receipt}
                checked={commitSelected.includes(id)}
                onChange={() => {
                  toggle(commitSelected, id, setCommitSelected)
                  invalidateReview()
                }}
              />
              Commit staged changes
            </label>
            {commitSelected.includes(id) && (
              <label className="block space-y-1">
                Commit message
                <Input
                  disabled={busy || !!receipt}
                  value={messages[id] ?? ''}
                  onChange={(event) => {
                    setMessages({ ...messages, [id]: event.target.value })
                    invalidateReview()
                  }}
                />
              </label>
            )}
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                disabled={busy || !!receipt}
                checked={publish.includes(id)}
                onChange={() => {
                  const enabling = !publish.includes(id)
                  toggle(publish, id, setPublish)
                  if (
                    enabling &&
                    repository.refs === undefined &&
                    refsByContext[id] === undefined
                  ) {
                    onRequestRefs(id)
                  }
                  invalidateReview()
                }}
              />
              Publish this repository
            </label>
            {publish.includes(id) && (
              <>
                <label className="block space-y-1">
                  Destination remote
                  <select
                    disabled={busy || !!receipt}
                    className="w-full rounded-md border border-input bg-background px-2 py-1"
                    value={remotes[id] ?? ''}
                    onChange={(event) => {
                      setRemotes({ ...remotes, [id]: event.target.value })
                      invalidateReview()
                    }}
                  >
                    <option value="">Choose configured remote</option>
                    {(repository.remotes ?? []).map((remote) => (
                      <option key={remote} value={remote}>
                        {remote}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-1">
                  Local branch to publish
                  <select
                    disabled={busy || !!receipt || localBranches.length === 0}
                    className="w-full rounded-md border border-input bg-background px-2 py-1"
                    value={refs[id] ?? ''}
                    onChange={(event) => {
                      const refName = event.target.value
                      const ref = localBranches.find((item) => item.name === refName)
                      setRefs({ ...refs, [id]: refName })
                      setOids({ ...oids, [id]: ref?.oid ?? '' })
                      invalidateReview()
                    }}
                  >
                    <option value="">Choose checked-out branch</option>
                    {localBranches.map((ref) => (
                      <option key={ref.name} value={ref.name}>
                        {ref.name} · {ref.oid}
                      </option>
                    ))}
                  </select>
                </label>
                {localBranches.length === 0 && (
                  <p role="note">
                    Publication is limited to the current local branch; load refs to review its OID.
                  </p>
                )}
                <label className="block space-y-1">
                  Expected ref OID
                  <Input className="font-mono" readOnly value={oids[id] ?? ''} />
                </label>
                {(repository.remotes?.length ?? 0) === 0 && (
                  <p role="note">No configured remotes are available in this checkout.</p>
                )}
              </>
            )}
          </fieldset>
        )
      })}
      {missingCommitMessage && (
        <p role="alert" className="text-destructive">
          Enter a commit message for every selected commit.
        </p>
      )}
      {incompletePublication && (
        <p role="alert" className="text-destructive">
          Choose a configured remote and local branch for each publication target.
        </p>
      )}
      {!hasWork && selected.length > 0 && (
        <p role="note">Select at least one commit or publication operation.</p>
      )}
      <Button
        size="xs"
        variant="outline"
        disabled={
          busy ||
          !!receipt ||
          selected.length === 0 ||
          !hasWork ||
          missingCommitMessage ||
          incompletePublication
        }
        onClick={() => void review()}
      >
        Review selected batch
      </Button>
      <WorkspaceBatchReview
        preview={preview}
        receipt={receipt}
        busy={busy}
        confirmed={confirmed}
        setConfirmed={setConfirmed}
        run={run}
        refreshProgress={refreshProgress}
        onEdit={invalidateReview}
        onNew={() => {
          setReceipt(null)
          setPreview(null)
          setConfirmed(false)
          setError(null)
        }}
      />
      {busy && <p aria-live="polite">Working…</p>}
      {error && (
        <p role="alert" className="break-words text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
