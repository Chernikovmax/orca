import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { RepositoryState } from '../../../../../../shared/git-workspace-types'
import type { WorkspaceBranchActions } from './use-workspace-branch-actions'

const PHASE_LABEL: Record<string, string> = {
  connecting: 'Connecting',
  remote: 'Remote',
  receiving: 'Receiving objects',
  resolving: 'Resolving deltas',
  checkout: 'Updating files',
  enumerating: 'Enumerating objects',
  counting: 'Counting objects',
  compressing: 'Compressing objects',
  writing: 'Writing objects',
  done: 'Done'
}

function timeLabel(iso: string | undefined): string {
  return iso ? new Date(iso).toLocaleTimeString() : 'never'
}

function operationLabel(repository: RepositoryState): string {
  if (!repository.operationInProgress) {
    return ''
  }
  const kind =
    repository.conflictOperation === 'unknown' ? 'Git operation' : repository.conflictOperation
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)} in progress`
}

export function SyncActions({
  repository,
  actions
}: {
  repository: RepositoryState
  actions: WorkspaceBranchActions
}) {
  const remotes = repository.remotes ?? []
  const localRefs = (repository.refs ?? []).filter((ref) => ref.name.startsWith('refs/heads/'))
  const [remoteChoice, setRemoteChoice] = useState('')
  const [pushChoice, setPushChoice] = useState('')
  const [setUpstream, setSetUpstream] = useState(false)
  const remote = remotes.includes(remoteChoice) ? remoteChoice : (remotes[0] ?? '')
  const pushedRef =
    localRefs.find((ref) => ref.name === pushChoice) ??
    localRefs.find((ref) => ref.name === repository.branch) ??
    localRefs[0]
  const busy = actions.busy !== null
  const progress = actions.progress
  const conflicts = repository.entries.filter(
    (entry) => entry.conflictStatus === 'unresolved'
  ).length
  const showProgress =
    progress !== null ||
    actions.busy?.startsWith('Fetch') === true ||
    actions.busy?.startsWith('Push') === true
  return (
    <section aria-label="Remote operations" className="space-y-2" data-testid="git-sync-actions">
      {actions.notice && (
        <p
          role={actions.notice.tone === 'ok' ? 'status' : 'alert'}
          className={actions.notice.tone === 'error' ? 'text-destructive' : undefined}
          data-testid="git-branch-notice"
        >
          {actions.notice.text}
        </p>
      )}
      <p className="text-muted-foreground" data-testid="git-refs-freshness">
        Refs read {timeLabel(repository.refsReadAt)}; last fetch {timeLabel(repository.lastFetchAt)}
        . Remote-tracking data only — Orca never fetches automatically.
      </p>
      {remotes.length === 0 ? (
        <p className="text-muted-foreground">
          No remotes are configured in this checkout. Fetch and push need an explicit remote.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-1">
            <label className="text-muted-foreground">
              Remote
              <select
                aria-label="Remote"
                className="ml-1 rounded border border-border bg-background px-1 py-0.5 text-xs"
                value={remote}
                disabled={busy}
                onChange={(event) => setRemoteChoice(event.target.value)}
              >
                {remotes.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="outline"
              size="xs"
              data-navigation-item
              data-navigation-action
              disabled={busy || !remote}
              onClick={() => actions.fetch(remote)}
            >
              Fetch
            </Button>
          </div>
          <div className="flex flex-wrap items-end gap-1">
            <label className="text-muted-foreground">
              Push branch
              <select
                aria-label="Push branch"
                className="ml-1 max-w-56 rounded border border-border bg-background px-1 py-0.5 text-xs"
                value={pushedRef?.name ?? ''}
                disabled={busy || localRefs.length === 0}
                onChange={(event) => {
                  setPushChoice(event.target.value)
                  setSetUpstream(false)
                }}
              >
                {localRefs.map((ref) => (
                  <option key={ref.name} value={ref.name}>
                    {ref.name.replace(/^refs\/heads\//, '')}
                  </option>
                ))}
              </select>
            </label>
            {pushedRef && !pushedRef.upstream && (
              <label className="flex items-center gap-1 text-muted-foreground">
                <input
                  type="checkbox"
                  checked={setUpstream}
                  disabled={busy}
                  onChange={(event) => setSetUpstream(event.target.checked)}
                />
                Publish (set upstream)
              </label>
            )}
            <Button
              variant="outline"
              size="xs"
              data-navigation-item
              data-navigation-action
              disabled={busy || !remote || !pushedRef}
              onClick={() =>
                pushedRef && actions.push(remote, pushedRef.name, pushedRef.oid, setUpstream)
              }
            >
              Push
            </Button>
          </div>
          {showProgress && (
            <div role="status" aria-live="polite" data-testid="git-sync-progress">
              <p>
                {actions.busy ?? 'Remote operation'}
                {progress ? ` · ${PHASE_LABEL[progress.phase] ?? progress.phase}` : ''}
                {progress?.percent !== undefined ? ` · ${progress.percent}%` : ''}
              </p>
              {progress?.percent !== undefined && (
                <progress max={100} value={progress.percent} className="w-full" />
              )}
            </div>
          )}
        </>
      )}
      {repository.operationInProgress && (
        <section
          aria-label="Unfinished operation"
          className="space-y-1 rounded border border-border p-2"
          data-testid="git-unfinished-operation"
        >
          <p className="font-semibold">{operationLabel(repository)}</p>
          <p>
            {conflicts > 0
              ? `${conflicts} unresolved conflict file(s). The integration is not complete.`
              : 'No unresolved conflict entries remain. Git still decides whether continuing is possible.'}
          </p>
          <p className="text-muted-foreground">
            Resolve conflicts outside the full resolver (a later stage), stage the files, then
            Continue. Abort restores the pre-merge/pre-rebase state.
          </p>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="xs"
              data-navigation-item
              data-navigation-action
              disabled={busy}
              onClick={actions.continueOperation}
            >
              Continue
            </Button>
            <Button
              variant="destructive"
              size="xs"
              data-navigation-item
              data-navigation-action
              disabled={busy}
              onClick={actions.abortOperation}
            >
              Abort
            </Button>
          </div>
        </section>
      )}
      {actions.lastOperation && (
        <p className="text-muted-foreground" data-testid="git-last-operation">
          Last operation: {actions.lastOperation.kind} ·{' '}
          {actions.lastOperation.completed ? 'completed' : 'not completed'}
          {actions.lastOperation.conflicts ? ' · conflicts present' : ''}
        </p>
      )}
    </section>
  )
}
