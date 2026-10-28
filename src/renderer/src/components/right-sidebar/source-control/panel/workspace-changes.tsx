import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useAppStore } from '@/store'
import { detectLanguage } from '@/lib/language-detect'
import { joinPath } from '@/lib/path'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { RepositoryState, SubmoduleEntry } from '../../../../../../shared/git-workspace-types'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import { WorkspaceChangesList } from './workspace-changes-list'
import { useWorkspaceMutations } from './use-workspace-mutations'
import { WorkspaceConflictOperation } from './workspace-conflict-operation'

export type WorkspaceChangesProps = {
  repository: RepositoryState
  context: RuntimeGitContext
  label: string
  refreshGeneration: object
  submodules: SubmoduleEntry[]
  /** Root keeps its established commit surface; child contexts get this one. */
  showCommit: boolean
  onRefresh: () => void
  /** Switches the Source Control surface to this context's Log. */
  onOpenLog?: () => void
}

type ChangesState = {
  query: string
  tree: boolean
  selected: string
  collapsed: string[]
  scroll: number
}
const states = new Map<string, ChangesState>()
const keyOf = (entry: GitStatusEntry) => `${entry.area}:${entry.path}`

function shortOid(oid: string | undefined): string {
  return oid ? oid.slice(0, 10) : 'unknown'
}

export function SourceControlWorkspaceChanges({
  repository,
  context,
  label,
  refreshGeneration,
  submodules,
  showCommit,
  onRefresh,
  onOpenLog
}: WorkspaceChangesProps) {
  const id = repository.context.id
  const [view, setView] = useState<ChangesState>(
    () => states.get(id) ?? { query: '', tree: true, selected: '', collapsed: [], scroll: 0 }
  )
  const element = useRef<HTMLElement>(null)
  const currentView = useRef(view)
  currentView.current = view
  const mutations = useWorkspaceMutations({ repository, context, onRefresh })
  useEffect(() => {
    const scrollElement = element.current?.closest('[data-git-changes-scroll]')
    if (scrollElement instanceof HTMLElement) {
      scrollElement.scrollTop = states.get(id)?.scroll ?? 0
    }
    return () => {
      states.set(id, {
        ...currentView.current,
        scroll: scrollElement instanceof HTMLElement ? scrollElement.scrollTop : 0
      })
    }
  }, [id])
  const update = (patch: Partial<ChangesState>) =>
    setView((current) => {
      const next = { ...current, ...patch }
      states.set(id, next)
      return next
    })
  useEffect(() => {
    useAppStore.setState((state) => ({
      openFiles: state.openFiles.map((file) =>
        file.gitDiffSelection?.contextId === id && !file.isDirty
          ? { ...file, diffContentReloadNonce: (file.diffContentReloadNonce ?? 0) + 1 }
          : file
      )
    }))
  }, [id, refreshGeneration])
  const entries = repository.entries.filter((entry) =>
    `${entry.oldPath ?? ''}\n${entry.path}`
      .toLocaleLowerCase()
      .includes(view.query.toLocaleLowerCase())
  )
  const open = (entry: GitStatusEntry) => {
    if (!context.worktreeId) {
      return
    }
    update({ selected: keyOf(entry) })
    if (entry.conflictStatus === 'unresolved') {
      useAppStore
        .getState()
        .openConflictFile(
          context.worktreeId,
          repository.context.checkoutPath,
          entry,
          detectLanguage(entry.path),
          {
            preview: false,
            gitDiffRootPath: context.worktreePath,
            runtimeEnvironmentId:
              context.target.kind === 'environment' ? context.target.environmentId : undefined,
            gitDiffSelection: {
              contextId: id,
              left: { kind: 'index' },
              right: { kind: 'worktree' }
            }
          }
        )
      return
    }
    useAppStore
      .getState()
      .openDiff(
        context.worktreeId,
        joinPath(repository.context.checkoutPath, entry.path),
        entry.path,
        detectLanguage(entry.path),
        entry.area === 'staged',
        {
          preview: false,
          runtimeEnvironmentId:
            context.target.kind === 'environment' ? context.target.environmentId : undefined,
          gitDiffRootPath: context.worktreePath,
          gitDiffSelection: {
            contextId: id,
            oldPath: entry.area === 'staged' ? entry.oldPath : undefined,
            left: {
              kind:
                entry.area === 'staged' ? 'head' : entry.area === 'untracked' ? 'empty' : 'index'
            },
            right: { kind: entry.area === 'staged' ? 'index' : 'worktree' }
          }
        }
      )
  }
  const groups = [
    {
      name: 'Conflicts',
      entries: entries.filter((entry) => entry.conflictStatus === 'unresolved')
    },
    ...(['unstaged', 'staged', 'untracked'] as const).map((area) => ({
      name: area[0].toUpperCase() + area.slice(1),
      entries: entries.filter(
        (entry) => entry.area === area && entry.conflictStatus !== 'unresolved'
      )
    }))
  ]
  const move = (direction: number) => {
    if (entries.length) {
      const index = entries.findIndex((entry) => keyOf(entry) === view.selected)
      open(entries[(index + direction + entries.length) % entries.length])
    }
  }
  const parentPath = submodules.find((item) => item.contextId === id)?.path ?? ''
  const gitlinkFor = (entry: GitStatusEntry): SubmoduleEntry | undefined =>
    submodules.find(
      (item) =>
        item.parentContextId === id &&
        item.path === (parentPath ? `${parentPath}/${entry.path}` : entry.path)
    )
  const stagedEntries = repository.entries.filter((entry) => entry.area === 'staged')
  return (
    <section
      ref={element}
      aria-label="Context changes"
      className="space-y-2 border-t border-border p-3 text-xs"
      data-testid="git-context-changes"
    >
      <div className="flex items-start gap-1">
        <h3 className="min-w-0 flex-1 font-semibold break-all">Changes · {label}</h3>
        {onOpenLog && (
          <Button variant="ghost" size="xs" onClick={onOpenLog}>
            Open Log
          </Button>
        )}
      </div>
      {repository.incomplete && <p role="status">Partial context status</p>}
      {repository.statusTruncated && (
        <p role="status">The change listing is truncated by the host limit.</p>
      )}
      {repository.operationInProgress && (
        <WorkspaceConflictOperation
          repository={repository}
          context={context}
          onRefresh={onRefresh}
        />
      )}
      {mutations.notice && (
        <p
          role={mutations.notice.tone === 'ok' ? 'status' : 'alert'}
          className={mutations.notice.tone === 'error' ? 'text-destructive' : undefined}
          data-testid="git-mutation-notice"
        >
          {mutations.notice.text}
        </p>
      )}
      {mutations.lastRecovery && (
        <p role="status" data-testid="git-discard-recovery">
          Recovery copy kept for {mutations.lastRecovery.filePath}.{' '}
          <Button
            variant="outline"
            size="xs"
            disabled={mutations.busy !== null}
            onClick={() => void mutations.restoreRecovery(mutations.lastRecovery!)}
          >
            Restore copy
          </Button>
        </p>
      )}
      <div className="flex gap-1">
        <Input
          aria-label="Filter changes"
          value={view.query}
          onChange={(event) => update({ query: event.target.value })}
        />
        <Button
          variant="outline"
          size="xs"
          aria-pressed={view.tree}
          onClick={() => update({ tree: !view.tree })}
        >
          {view.tree ? 'Tree' : 'List'}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          disabled={mutations.busy !== null}
          onClick={() => void mutations.loadRecoveries()}
        >
          Recovery copies
        </Button>
      </div>
      {mutations.recoveries && (
        <section aria-label="Recovery copies" data-testid="git-recovery-list">
          {mutations.recoveries.length === 0 && <p>No recoverable copies for this context.</p>}
          <ul className="space-y-1">
            {mutations.recoveries.map((item) => (
              <li key={item.id} className="flex items-center gap-1">
                <span className="break-all">
                  {item.filePath} · {new Date(item.createdAt).toLocaleString()}
                </span>
                <Button
                  variant="outline"
                  size="xs"
                  disabled={mutations.busy !== null}
                  onClick={() => void mutations.restoreRecovery(item)}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {mutations.discardPreview && (
        <section
          aria-label="Discard preview"
          role="alertdialog"
          className="space-y-1 rounded border border-border p-2"
          data-testid="git-discard-preview"
        >
          <p className="font-semibold">Discard {mutations.discardPreview.filePath}?</p>
          <p>
            {mutations.discardPreview.exists
              ? 'The working-tree file returns to the index content.'
              : 'The deleted file is restored from the index.'}{' '}
            {mutations.discardPreview.warning}
          </p>
          <p>
            Recovery copy:{' '}
            {mutations.discardPreview.recoveryAvailable ? 'available' : 'unavailable'}
          </p>
          <div className="flex gap-1">
            <Button
              variant="destructive"
              size="xs"
              disabled={mutations.busy !== null || !mutations.discardPreview.recoveryAvailable}
              onClick={() => void mutations.confirmDiscard()}
            >
              Confirm discard
            </Button>
            <Button variant="ghost" size="xs" onClick={mutations.cancelDiscard}>
              Cancel
            </Button>
          </div>
        </section>
      )}
      {showCommit && (
        <section aria-label="Commit" className="space-y-1" data-testid="git-context-commit">
          <h4 className="font-semibold">Commit {label}</h4>
          <p>
            Staged in the real index: {stagedEntries.length} file(s). Hooks and signing run as
            configured.
          </p>
          <Textarea
            aria-label="Commit message"
            data-testid="git-context-commit-message"
            value={mutations.draft}
            rows={3}
            onChange={(event) => mutations.setDraft(event.target.value)}
          />
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="xs"
              disabled={mutations.busy !== null}
              onClick={() => void mutations.previewCommit()}
            >
              Preview staged set
            </Button>
            <Button
              size="xs"
              disabled={mutations.busy !== null || stagedEntries.length === 0}
              onClick={() => void mutations.commit()}
            >
              Commit
            </Button>
          </div>
          {mutations.commitPreview && (
            <div data-testid="git-commit-preview" className="space-y-1">
              <p>
                {mutations.commitPreview.unborn
                  ? 'Unborn HEAD: the first commit is created.'
                  : mutations.commitPreview.detached
                    ? `Detached HEAD at ${shortOid(mutations.commitPreview.head)}`
                    : `Branch ${mutations.commitPreview.branch ?? 'unknown'}`}{' '}
                · {mutations.commitPreview.stagedFiles} staged file(s)
                {mutations.commitPreview.truncated ? ' · listing truncated' : ''}
              </p>
              <ul>
                {mutations.commitPreview.staged.map((item) => (
                  <li key={`${item.status}:${item.path}`} className="break-all">
                    {item.status} {item.oldPath ? `${item.oldPath} → ` : ''}
                    {item.path}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
      <div className="flex gap-1">
        <Button variant="ghost" size="xs" disabled={!entries.length} onClick={() => move(-1)}>
          Previous file
        </Button>
        <Button variant="ghost" size="xs" disabled={!entries.length} onClick={() => move(1)}>
          Next file
        </Button>
      </div>
      <WorkspaceChangesList
        groups={groups}
        tree={view.tree}
        collapsed={view.collapsed}
        selected={view.selected}
        busy={mutations.busy !== null}
        onToggleDirectory={(key) =>
          update({
            collapsed: view.collapsed.includes(key)
              ? view.collapsed.filter((item) => item !== key)
              : [...view.collapsed, key]
          })
        }
        onOpen={open}
        onStage={mutations.stageEntry}
        onUnstage={mutations.unstageEntry}
        onDiscard={mutations.requestDiscard}
        onStageGitlink={mutations.stageGitlink}
        gitlinkFor={gitlinkFor}
      />
      {!entries.length && (
        <p>
          {repository.entries.length ? 'No matching changes.' : 'No file changes in this checkout.'}
        </p>
      )}
    </section>
  )
}
