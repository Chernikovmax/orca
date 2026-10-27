import { Button } from '@/components/ui/button'
import type {
  GitWorkspaceBatchPreview,
  GitWorkspaceBatchReceipt,
  GitWorkspaceBatchConfirmation
} from '../../../../../../shared/git-workspace-batch'

type Props = {
  preview: GitWorkspaceBatchPreview | null
  receipt: GitWorkspaceBatchReceipt | null
  busy: boolean
  confirmed: boolean
  setConfirmed: (confirmed: boolean) => void
  run: (confirmation?: GitWorkspaceBatchConfirmation, retryFailed?: boolean) => Promise<void>
  refreshProgress: () => Promise<void>
  onEdit: () => void
  onNew: () => void
}

export function WorkspaceBatchReview({
  preview,
  receipt,
  busy,
  confirmed,
  setConfirmed,
  run,
  refreshProgress,
  onEdit,
  onNew
}: Props) {
  const next = receipt?.nextConfirmation
  return (
    <>
      {preview && (
        <div
          role="group"
          aria-label="Batch review"
          className="space-y-1 rounded-md border border-border p-2"
        >
          <h4 className="font-medium">Batch review</h4>
          <p>
            {preview.incomplete
              ? 'Incomplete workspace discovery; review errors before proceeding.'
              : `${preview.steps.length} ordered steps`}
          </p>
          {preview.errors.map((item, index) => (
            <p role="alert" key={`${index}:${item}`} className="text-destructive">
              {item}
            </p>
          ))}
          {preview.steps.slice(0, 128).map((step, index) => (
            <p key={step.id}>
              {index + 1}. {step.kind} · {step.status} ·{' '}
              {step.filePath ?? step.refName ?? step.contextId}
              {step.detail ? ` · ${step.detail}` : ''}
            </p>
          ))}
          {preview.steps.length > 128 && <p>Showing 128 of {preview.steps.length} steps.</p>}
          {!receipt && (
            <Button
              size="xs"
              disabled={busy || preview.incomplete || preview.errors.length > 0}
              onClick={() => void run()}
            >
              Run batch
            </Button>
          )}
          {!receipt && (
            <Button size="xs" variant="outline" disabled={busy} onClick={onEdit}>
              Edit batch
            </Button>
          )}
        </div>
      )}
      {receipt && (
        <div aria-live="polite" className="space-y-1">
          <p>
            Batch {receipt.outcome} · {receipt.progress.completed}/{receipt.progress.total} steps
            completed
          </p>
          {receipt.steps.slice(0, 128).map((step, index) => (
            <p key={`${step.id}:${index}`}>
              {step.contextId} · {step.filePath ?? step.refName ?? step.kind}: {step.status}
              {step.error ? ` — ${step.error}` : ''}
            </p>
          ))}
          {receipt.remaining.length > 0 && (
            <p>{receipt.remaining.length} steps remain; completed steps will not be replayed.</p>
          )}
          {receipt.outcome === 'unknown' && (
            <p role="alert">
              Outcome unknown. Do not retry; refresh and inspect the real Git state before reviewing
              a new batch.
            </p>
          )}
          {receipt.outcome === 'failed' && (
            <p>
              Only the known-failed next step can be retried; completed and unknown steps are not
              replayed. Dependencies will be rechecked.
            </p>
          )}
          {receipt.outcome === 'failed' && (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void run(undefined, true)}
            >
              Retry failed step after revalidation
            </Button>
          )}
          {receipt.outcome === 'completed' && (
            <Button size="xs" variant="outline" onClick={onNew}>
              New batch
            </Button>
          )}
          {next && (
            <fieldset className="space-y-1 border border-border p-2">
              <legend>Confirm parent gitlink</legend>
              <p>
                {next.filePath} → {next.childOid}
              </p>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                Confirm gitlink {next.filePath} at {next.childOid}
              </label>
              <Button
                size="xs"
                disabled={busy || !confirmed}
                onClick={() => void run({ ...next, confirmed: true })}
              >
                Continue batch
              </Button>
            </fieldset>
          )}
          {receipt.outcome === 'running' && (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void refreshProgress()}
            >
              Refresh batch progress
            </Button>
          )}
        </div>
      )}
    </>
  )
}
