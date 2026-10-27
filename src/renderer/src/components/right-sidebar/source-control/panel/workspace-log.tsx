import { useEffect, useMemo, useState } from 'react'
import type { GitBranchChangeEntry, GitCommitCompareSummary } from '../../../../../../shared/git-diff-compare-types'
import type { GitHistoryItemRef } from '../../../../../../shared/git-history'
import type { RepositoryState } from '../../../../../../shared/git-workspace-types'
import {
  buildDefaultGitHistoryColorMap,
  buildGitHistoryViewModels
} from '../../../../../../shared/git-history-graph'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import { useAppStore } from '@/store'
import { detectLanguage } from '@/lib/language-detect'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useWorkspaceLog } from './use-workspace-log'
import { WorkspaceLogList } from './workspace-log-list'
import { WorkspaceLogDetails } from './workspace-log-details'

const MAX_REVISION_OPTIONS = 500

function shortRefName(name: string): string {
  return name.replace(/^refs\/(?:heads|remotes|tags)\//, '')
}

function refGroups(refs: RepositoryState['refs']): {
  heads: GitHistoryItemRef[]
  tags: GitHistoryItemRef[]
  remotes: GitHistoryItemRef[]
  capped: boolean
} {
  const heads: GitHistoryItemRef[] = []
  const tags: GitHistoryItemRef[] = []
  const remotes: GitHistoryItemRef[] = []
  let capped = false
  for (const ref of refs ?? []) {
    const row = { id: ref.name, name: shortRefName(ref.name), revision: ref.oid }
    if (ref.name.startsWith('refs/heads/')) {
      heads.push(row)
    } else if (ref.name.startsWith('refs/tags/')) {
      tags.push(row)
    } else if (ref.name.startsWith('refs/remotes/')) {
      remotes.push(row)
    }
    if (heads.length + tags.length + remotes.length > MAX_REVISION_OPTIONS) {
      capped = true
      break
    }
  }
  return {
    heads: heads.slice(0, MAX_REVISION_OPTIONS),
    tags: tags.slice(0, MAX_REVISION_OPTIONS),
    remotes: remotes.slice(0, MAX_REVISION_OPTIONS),
    capped
  }
}

/**
 * Paged Log for one Git context. It reuses the shared history reader, graph model,
 * row renderer and commit-diff tabs; the selected commit's base (a merge parent or
 * any revision the user pinned) drives the file list and the opened diff sides.
 */
export function SourceControlWorkspaceLog({
  repository,
  context,
  label,
  isRoot,
  revision
}: {
  repository: RepositoryState
  context: RuntimeGitContext
  label: string
  isRoot: boolean
  /** Revision requested by the entry point (for a gitlink, the child commit). */
  revision?: string | null
}) {
  const openCommitDiff = useAppStore((store) => store.openCommitDiff)
  const openCommitAllDiffs = useAppStore((store) => store.openCommitAllDiffs)
  const refsSignature = useMemo(
    () => (repository.refs ?? []).map((ref) => `${ref.name}:${ref.oid}`).join('|'),
    [repository.refs]
  )
  const signature = `${repository.head ?? ''}|${repository.branch ?? ''}|${repository.detached}|${refsSignature}`
  const log = useWorkspaceLog({
    context,
    contextId: repository.context.id,
    signature,
    enabled: true,
    revision
  })
  const viewModels = useMemo(
    () =>
      buildGitHistoryViewModels(
        log.items,
        buildDefaultGitHistoryColorMap({
          currentRef: log.meta.currentRef,
          remoteRef: log.meta.remoteRef,
          baseRef: log.meta.baseRef
        }),
        log.meta.currentRef,
        log.meta.remoteRef,
        log.meta.baseRef,
        false,
        false,
        log.meta.mergeBase
      ).filter((viewModel) => viewModel.kind === 'node' || viewModel.kind === 'HEAD'),
    [log.items, log.meta]
  )
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [parentChoice, setParentChoice] = useState<string | null | undefined>(undefined)
  const [compareFrom, setCompareFrom] = useState<string | null>(null)
  const selected =
    viewModels.find((viewModel) => viewModel.historyItem.id === selectedId)?.historyItem ??
    viewModels[0]?.historyItem ??
    null
  const selectedKey = selected?.id ?? ''
  const groups = useMemo(() => refGroups(repository.refs), [repository.refs])

  useEffect(() => {
    setParentChoice(undefined)
  }, [selectedKey])

  useEffect(() => {
    setCompareFrom(null)
  }, [repository.context.id])

  const openFile = (entry: GitBranchChangeEntry, baseOid: string | null): void => {
    if (!selected || !context.worktreeId) {
      return
    }
    openCommitDiff(
      context.worktreeId,
      repository.context.checkoutPath,
      entry,
      {
        commitOid: selected.id,
        parentOid: baseOid,
        compareRef: selected.id.slice(0, 7),
        baseRef: baseOid ? baseOid.slice(0, 7) : 'empty tree',
        subject: selected.subject,
        message: selected.message
      },
      detectLanguage(entry.path),
      {
        gitDiffRootPath: repository.context.checkoutPath,
        gitDiffSelection: {
          contextId: repository.context.id,
          ...(entry.oldPath ? { oldPath: entry.oldPath } : {}),
          left: baseOid ? { kind: 'commit', oid: baseOid } : { kind: 'empty' },
          right: { kind: 'commit', oid: selected.id }
        }
      }
    )
  }

  const openAll = isRoot
    ? (summary: GitCommitCompareSummary, entries: GitBranchChangeEntry[]): void => {
        if (!selected || !context.worktreeId) {
          return
        }
        openCommitAllDiffs(
          context.worktreeId,
          repository.context.checkoutPath,
          summary,
          entries,
          selected.subject,
          selected.message
        )
      }
    : null

  const branchLabel = repository.branch?.replace(/^refs\/heads\//, '') ?? null
  const pinnedOidRevision =
    log.filters.revision && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(log.filters.revision)
  const revisionLabel = log.filters.revision
    ? pinnedOidRevision
      ? `commit ${log.filters.revision.slice(0, 8)}`
      : shortRefName(log.filters.revision)
    : repository.unborn
      ? 'HEAD · unborn'
      : branchLabel
        ? `HEAD · ${branchLabel}`
        : `HEAD · ${repository.head?.slice(0, 8) ?? 'unborn'}`
  const revisionInRefs = (repository.refs ?? []).some(
    (ref) => ref.name === log.filters.revision
  )

  return (
    <section
      aria-label="Git log"
      className="flex h-full min-h-0 flex-col border-t border-border text-xs"
      data-testid="git-context-log"
    >
      <div className="space-y-1 p-2">
        <div className="flex items-center gap-1">
          <h3 className="min-w-0 flex-1 font-semibold break-all">Log · {label}</h3>
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {log.items.length}
            {log.hasMore ? '+' : ''}
          </span>
          <Button
            variant="ghost"
            size="xs"
            disabled={log.status === 'loading'}
            onClick={log.refresh}
          >
            Refresh
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          {revisionLabel} · local history only, no fetch or clone
        </p>
        <div className="flex gap-1">
          <select
            aria-label="History revision"
            className="min-w-0 flex-1 rounded border border-border bg-transparent px-1 py-0.5 text-xs"
            value={log.filters.revision}
            onChange={(event) => log.setRevision(event.target.value)}
          >
            <option value="">
              HEAD
              {repository.unborn
                ? ' · unborn'
                : branchLabel
                  ? ` · ${branchLabel}`
                  : ` · ${repository.head?.slice(0, 8) ?? 'unborn'}`}
            </option>
            {log.filters.revision && !revisionInRefs && (
              <option value={log.filters.revision}>{revisionLabel}</option>
            )}
            {groups.heads.length > 0 && (
              <optgroup label="Local branches">
                {groups.heads.map((ref) => (
                  <option key={ref.id} value={ref.id}>
                    {ref.name}
                  </option>
                ))}
              </optgroup>
            )}
            {groups.tags.length > 0 && (
              <optgroup label="Tags">
                {groups.tags.map((ref) => (
                  <option key={ref.id} value={ref.id}>
                    {ref.name}
                  </option>
                ))}
              </optgroup>
            )}
            {groups.remotes.length > 0 && (
              <optgroup label="Remote branches">
                {groups.remotes.map((ref) => (
                  <option key={ref.id} value={ref.id}>
                    {ref.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <Input
            aria-label="History path filter"
            placeholder="Path…"
            className="min-w-0 flex-1"
            value={log.filters.path}
            onChange={(event) => log.setPath(event.target.value)}
          />
        </div>
        <Input
          aria-label="Commit message filter"
          placeholder="Message contains…"
          value={log.filters.message}
          onChange={(event) => log.setMessage(event.target.value)}
        />
        {groups.capped && (
          <p className="text-[10px] text-muted-foreground">
            Ref list is capped; type a revision filter to narrow it.
          </p>
        )}
        {!repository.refs && !repository.refsError && (
          <p role="status" className="text-[10px] text-muted-foreground">
            Refs are loading; only HEAD is offered so far.
          </p>
        )}
        {log.error && (
          <p role="alert" className="text-destructive">
            {log.error}
          </p>
        )}
        {log.notice && (
          <p role="status" className="text-muted-foreground">
            {log.notice}
          </p>
        )}
        {log.status === 'refreshing' && (
          <p role="status" className="text-[10px] text-muted-foreground">
            Refs changed; reloading history…
          </p>
        )}
      </div>
      <WorkspaceLogList
        viewModels={viewModels}
        selectedId={selected?.id ?? null}
        onSelect={(item) => setSelectedId(item.id)}
        empty={log.empty}
        loading={log.status === 'loading' || log.status === 'refreshing'}
        hasMore={log.hasMore}
        loadingMore={log.loadingMore}
        onLoadMore={log.loadMore}
      />
      <div className="max-h-[45%] min-h-0 overflow-auto scrollbar-sleek border-t border-border">
        <WorkspaceLogDetails
          item={selected}
          repository={repository}
          context={context}
          parentChoice={parentChoice}
          compareFrom={compareFrom}
          onParentChoice={setParentChoice}
          onCompareFrom={setCompareFrom}
          onClearCompareFrom={() => setCompareFrom(null)}
          onOpenFile={openFile}
          onOpenAll={openAll}
        />
      </div>
    </section>
  )
}
