import { useRef, useState, type RefObject } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { RepositoryState } from '../../../../../../shared/git-workspace-types'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import {
  readContextPopupState,
  writeContextPopupState,
  type ContextPopupState
} from './workspace-popup-state'
import { BranchRefActions } from './workspace-popup-branch-actions'
import { SyncActions } from './workspace-popup-sync-actions'
import { useWorkspaceBranchActions } from './use-workspace-branch-actions'

function shortRef(refName: string): string {
  return refName.replace(/^refs\/(?:heads|remotes|tags)\//, '')
}

function refLabel(name: string): string {
  return name.replace(/^refs\/(heads|remotes|tags)\//, '')
}

export function ContextRefs({
  repository,
  context,
  loading,
  inputRef,
  onChanges,
  onLog,
  onRefresh
}: {
  repository: RepositoryState
  context: RuntimeGitContext
  loading: boolean
  inputRef: RefObject<HTMLInputElement | null>
  onChanges: () => void
  onLog: () => void
  onRefresh: () => void
}) {
  const id = repository.context.id
  const [state, setState] = useState(() => readContextPopupState(id))
  const [branchName, setBranchName] = useState('')
  const [startRef, setStartRef] = useState('HEAD')
  const [revision, setRevision] = useState('')
  const branchInput = useRef<HTMLInputElement>(null)
  const actions = useWorkspaceBranchActions({ repository, context, onRefresh })
  const refsReady = repository.refs !== undefined
  const refs = repository.refs ?? []
  function update(next: ContextPopupState) {
    setState(next)
    writeContextPopupState(id, next)
  }
  const matches = refs.filter((ref) => ref.name.toLowerCase().includes(state.query.toLowerCase()))
  const inspected = refs.find((ref) => ref.name === state.inspected)
  const groups = [
    {
      name: 'Recent',
      rows: state.recent.flatMap((name) => matches.filter((ref) => ref.name === name))
    },
    { name: 'Local', rows: matches.filter((ref) => ref.name.startsWith('refs/heads/')) },
    { name: 'Remote', rows: matches.filter((ref) => ref.name.startsWith('refs/remotes/')) },
    { name: 'Tags', rows: matches.filter((ref) => ref.name.startsWith('refs/tags/')) }
  ]
  function inspect(refName: string) {
    update({
      ...state,
      inspected: refName,
      recent: [refName, ...state.recent.filter((name) => name !== refName)].slice(0, 20)
    })
  }
  function useStartPoint(refName: string) {
    setStartRef(refName)
    branchInput.current?.focus()
  }
  function createBranch() {
    const name = branchName.trim()
    if (!name || !/^[^-\s]/.test(name)) {
      return
    }
    actions.createBranch(name, startRef)
    setBranchName('')
    setStartRef('HEAD')
  }
  return (
    <>
      <div className="flex gap-1">
        <Button
          variant="outline"
          size="sm"
          data-navigation-item
          data-navigation-action
          onClick={onChanges}
        >
          Open Changes
        </Button>
        <Button
          variant="outline"
          size="sm"
          data-navigation-item
          data-navigation-action
          onClick={onLog}
        >
          Open Log
        </Button>
      </div>
      <Input
        ref={inputRef}
        aria-label="Search refs"
        placeholder="Search this context’s refs…"
        value={state.query}
        onChange={(event) => update({ ...state, query: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && matches[0]) {
            event.preventDefault()
            inspect(matches[0].name)
          }
        }}
      />
      {repository.refsError && (
        <p role="alert" className="text-xs text-destructive">
          {repository.refsError.message}
        </p>
      )}
      {!repository.refs && !repository.refsError && (
        <p role="status" className="text-xs text-muted-foreground">
          {loading ? 'Loading refs for this context…' : 'Waiting for context refs…'}
        </p>
      )}
      {refsReady && <SyncActions repository={repository} actions={actions} />}
      <form
        className="space-y-1 rounded border border-border p-2"
        aria-label="New branch"
        onSubmit={(event) => {
          event.preventDefault()
          createBranch()
        }}
      >
        <div className="flex gap-1">
          <Input
            ref={branchInput}
            aria-label="New branch name"
            placeholder="New branch name…"
            value={branchName}
            disabled={actions.busy !== null || !refsReady}
            onChange={(event) => setBranchName(event.target.value)}
          />
          <Button
            size="xs"
            type="submit"
            data-navigation-item
            data-navigation-action
            disabled={actions.busy !== null || !refsReady || branchName.trim().length === 0}
          >
            Create and checkout
          </Button>
        </div>
        <p className="text-muted-foreground">
          Start point: {shortRef(startRef)}. Selecting a ref never checks it out by itself.
          {startRef !== 'HEAD' && (
            <Button variant="ghost" size="xs" className="ml-1" onClick={() => setStartRef('HEAD')}>
              Use HEAD
            </Button>
          )}
        </p>
      </form>
      <form
        className="flex gap-1"
        aria-label="Checkout revision"
        onSubmit={(event) => {
          event.preventDefault()
          const oid = revision.trim()
          if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) {
            return
          }
          actions.checkout(oid)
          setRevision('')
        }}
      >
        <Input
          aria-label="Commit id"
          placeholder="Full commit id for detached checkout…"
          value={revision}
          disabled={actions.busy !== null || !refsReady}
          onChange={(event) => setRevision(event.target.value)}
        />
        <Button
          size="xs"
          type="submit"
          data-navigation-item
          data-navigation-action
          disabled={
            actions.busy !== null ||
            !refsReady ||
            !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision.trim())
          }
        >
          Checkout detached
        </Button>
      </form>
      {inspected && (
        <section
          aria-label="Ref details"
          className="border border-border rounded-md p-2 text-xs break-all space-y-1"
        >
          <p>{inspected.name}</p>
          <p className="font-mono">{inspected.oid}</p>
          <BranchRefActions
            repository={repository}
            ref={inspected}
            actions={actions}
            onUseStartPoint={useStartPoint}
            disabled={actions.busy !== null}
          />
        </section>
      )}
      {groups.map((group) => (
        <section key={group.name} aria-label={group.name} className="space-y-1">
          <h4 className="text-2xs uppercase font-semibold text-muted-foreground">{group.name}</h4>
          {group.rows
            .sort(
              (a, b) =>
                Number(state.favorites.includes(b.name)) - Number(state.favorites.includes(a.name))
            )
            .map((ref) => (
              <div key={ref.name} className="flex items-center min-w-0 gap-1">
                <button
                  type="button"
                  data-navigation-item
                  className="flex-1 min-w-0 text-left break-all rounded-md p-1 text-xs hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring outline-none"
                  onClick={() => inspect(ref.name)}
                >
                  {refLabel(ref.name)}
                  {repository.branch === ref.name ? ' · current' : ''}
                  {ref.upstreamGone
                    ? ' · upstream gone'
                    : ref.ahead !== undefined && ref.behind !== undefined
                      ? ` · ahead ${ref.ahead}, behind ${ref.behind}`
                      : ''}
                </button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Favorite ${ref.name}`}
                  aria-pressed={state.favorites.includes(ref.name)}
                  onClick={() =>
                    update({
                      ...state,
                      favorites: state.favorites.includes(ref.name)
                        ? state.favorites.filter((name) => name !== ref.name)
                        : [...state.favorites, ref.name]
                    })
                  }
                >
                  {state.favorites.includes(ref.name) ? '★' : '☆'}
                </Button>
              </div>
            ))}
          {repository.refs && group.rows.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No {group.name.toLowerCase()} refs{state.query ? ' match' : ''}.
            </p>
          )}
        </section>
      ))}
    </>
  )
}
