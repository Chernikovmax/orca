import { useEffect, useState } from 'react'
import type {
  GitBranchChangeEntry,
  GitCommitCompareResult,
  GitCommitCompareSummary
} from '../../../../../../shared/git-diff-compare-types'
import type { GitHistoryItem } from '../../../../../../shared/git-history'
import type { RepositoryState } from '../../../../../../shared/git-workspace-types'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import { getRuntimeGitCommitCompare } from '@/runtime/runtime-git-diff-client'
import { Button } from '@/components/ui/button'
import { formatGitHistoryTimestamp } from '../sync/git-history-format'

type FilesState =
  | { status: 'loading' }
  | { status: 'ready'; result: GitCommitCompareResult }
  | { status: 'error'; error: string }

/**
 * Selected-commit details: message, explicit comparison base (a merge parent or
 * the empty tree), and the real changed files for that base. Files open through
 * the existing commit diff tabs, so the Log never renders its own diff engine.
 */
export function WorkspaceLogDetails({
  item,
  repository,
  context,
  parentChoice,
  compareFrom,
  onParentChoice,
  onCompareFrom,
  onClearCompareFrom,
  onOpenFile,
  onOpenAll
}: {
  item: GitHistoryItem | null
  repository: RepositoryState
  context: RuntimeGitContext
  /** undefined means the first parent, null the empty tree, a string an explicit parent. */
  parentChoice: string | null | undefined
  compareFrom: string | null
  onParentChoice: (oid: string | null) => void
  onCompareFrom: (oid: string) => void
  onClearCompareFrom: () => void
  onOpenFile: (entry: GitBranchChangeEntry, baseOid: string | null) => void
  onOpenAll: ((summary: GitCommitCompareSummary, entries: GitBranchChangeEntry[]) => void) | null
}) {
  const commitId = item?.id ?? null
  const baseOid = compareFrom ?? (parentChoice === undefined ? (item?.parentIds[0] ?? null) : parentChoice)
  const [files, setFiles] = useState<FilesState>({ status: 'loading' })

  useEffect(() => {
    if (!commitId) {
      return
    }
    let cancelled = false
    setFiles({ status: 'loading' })
    getRuntimeGitCommitCompare(context, commitId, {
      contextId: repository.context.id,
      baseOid
    })
      .then((result) => {
        if (cancelled) {
          return
        }
        if (result.summary.status === 'ready') {
          setFiles({ status: 'ready', result })
        } else {
          setFiles({
            status: 'error',
            error: result.summary.errorMessage ?? 'Commit changes are unavailable for this base.'
          })
        }
      })
      .catch((failure: unknown) => {
        if (!cancelled) {
          setFiles({
            status: 'error',
            error:
              failure instanceof Error ? failure.message : 'Commit changes could not be loaded.'
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [baseOid, commitId, context, repository.context.id])

  if (!item) {
    return (
      <p className="p-3 text-xs text-muted-foreground" data-testid="git-log-details">
        Select a commit to see its files and comparison base.
      </p>
    )
  }

  const parents = item.parentIds
  return (
    <section aria-label="Selected commit" className="space-y-1 p-2 text-xs" data-testid="git-log-details">
      <h4 className="font-semibold break-words">{item.subject}</h4>
      <p className="text-muted-foreground break-all">
        {item.displayId ?? item.id.slice(0, 10)} · {item.author ?? 'unknown author'} ·{' '}
        {formatGitHistoryTimestamp(item.timestamp)}
        {parents.length > 1 ? ` · merge of ${parents.length} parents` : ''}
      </p>
      {item.message.trim() !== item.subject.trim() && (
        <pre className="max-h-24 overflow-auto scrollbar-sleek whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
          {item.message.trim()}
        </pre>
      )}
      {compareFrom ? (
        <div className="flex flex-wrap items-center gap-1" data-testid="git-log-compare-mode">
          <span>
            Comparing {compareFrom.slice(0, 8)} → {item.id.slice(0, 8)}
          </span>
          <Button variant="ghost" size="xs" onClick={onClearCompareFrom}>
            Exit compare
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1" aria-label="Comparison base">
          {parents.map((oid, index) => (
            <Button
              key={oid}
              variant={baseOid === oid ? 'secondary' : 'outline'}
              size="xs"
              aria-pressed={baseOid === oid}
              onClick={() => onParentChoice(oid)}
            >
              {parents.length > 1 ? `Parent ${index + 1}` : 'Base'} {oid.slice(0, 8)}
            </Button>
          ))}
          {parents.length === 0 && (
            <Button
              variant={baseOid === null ? 'secondary' : 'outline'}
              size="xs"
              aria-pressed={baseOid === null}
              onClick={() => onParentChoice(null)}
            >
              Empty tree
            </Button>
          )}
          <Button variant="ghost" size="xs" onClick={() => onCompareFrom(item.id)}>
            Use as compare base
          </Button>
        </div>
      )}
      {files.status === 'loading' && (
        <p role="status" className="text-muted-foreground">
          Loading commit files…
        </p>
      )}
      {files.status === 'error' && (
        <p role="alert" className="text-destructive">
          {files.error}
        </p>
      )}
      {files.status === 'ready' && (
        <>
          <p data-testid="git-log-changed-files">
            {files.result.entries.length} changed file(s) against{' '}
            {baseOid ? baseOid.slice(0, 8) : 'the empty tree'}
          </p>
          {files.result.entries.length === 0 ? (
            <p className="text-muted-foreground">No file changes against this base.</p>
          ) : (
            <ul className="space-y-0.5">
              {files.result.entries.map((entry) => (
                <li key={`${entry.status}:${entry.oldPath ?? ''}:${entry.path}`}>
                  <button
                    type="button"
                    data-testid="git-log-file"
                    data-path={entry.path}
                    className="w-full rounded px-1 py-0.5 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring outline-none"
                    onClick={() => onOpenFile(entry, baseOid)}
                  >
                    <span className="font-mono text-[10px] uppercase text-muted-foreground">
                      {entry.status}
                    </span>{' '}
                    <span className="break-all">
                      {entry.oldPath ? `${entry.oldPath} → ` : ''}
                      {entry.path}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {onOpenAll && files.result.entries.length > 0 && (
            <Button
              variant="outline"
              size="xs"
              onClick={() => onOpenAll(files.result.summary, files.result.entries)}
            >
              Open all changes
            </Button>
          )}
        </>
      )}
    </section>
  )
}
