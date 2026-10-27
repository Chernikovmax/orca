import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { requireRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
import { getConnectionIdForFile } from '@/lib/connection-context'
import { mutateRuntimeGitWorkspace } from '@/runtime/runtime-git-working-tree-client'
import type { GitDiffResult } from '../../../../shared/git-diff-compare-types'
import type { GitDiffDocument, GitDiffSideInfo } from '../../../../shared/git-diff-document'
import type { GitMutationReceipt } from '../../../../shared/git-workspace-mutation'
import type { OpenFile } from '@/store/slices/editor'

const modes = new Map<string, boolean>()
function sideLabel(side: GitDiffSideInfo) {
  return `${side.source.kind === 'commit' ? side.source.oid : side.source.kind.toUpperCase()} · ${side.path}${side.exists ? '' : ' (absent)'}`
}

export function GitDiffDocumentSurface({
  file,
  result,
  sideBySide,
  reload,
  children
}: {
  file: OpenFile
  result: GitDiffResult | undefined
  sideBySide: boolean
  reload: () => void
  children: (sideBySide: boolean) => React.ReactNode
}) {
  const contextId = file.gitDiffSelection?.contextId
  const [mode, setMode] = useState(() => (contextId ? (modes.get(contextId) ?? true) : sideBySide))
  const document = result?.document
  if (!document) {
    return children(sideBySide)
  }
  const special = document.special
  const specialOnly = special && special !== 'mode'
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="git-diff-document">
      <div className="space-y-1 border-b border-border p-2 text-xs">
        <p className="whitespace-pre-wrap break-all">
          {sideLabel(document.left)} → {sideLabel(document.right)}
        </p>
        <p className="text-muted-foreground">
          Mode: {document.left.mode ?? 'absent'} → {document.right.mode ?? 'absent'} ·{' '}
          {document.left.lineEndings ?? '—'} → {document.right.lineEndings ?? '—'}
          {document.left.finalNewline === false || document.right.finalNewline === false
            ? ' · No final newline'
            : ''}
        </p>
        {document.stale && (
          <p role="alert">
            Diff is stale; reread before relying on these contents.{' '}
            <Button variant="outline" size="xs" onClick={reload}>
              Reload diff
            </Button>
          </p>
        )}
        {!specialOnly && contextId && (
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="xs"
              aria-pressed={mode}
              onClick={() => {
                modes.set(contextId, true)
                setMode(true)
              }}
            >
              Side by side
            </Button>
            <Button
              variant="ghost"
              size="xs"
              aria-pressed={!mode}
              onClick={() => {
                modes.set(contextId, false)
                setMode(false)
              }}
            >
              Unified
            </Button>
          </div>
        )}
        {!specialOnly && <PartialSelection file={file} document={document} reload={reload} />}
      </div>
      {specialOnly ? (
        <div
          className="space-y-3 overflow-auto scrollbar-sleek p-4 text-sm"
          data-testid="git-diff-special"
        >
          <h3 className="font-semibold">
            {special === 'gitlink'
              ? 'Submodule commit changed'
              : special === 'symlink'
                ? 'Symbolic link changed'
                : special === 'large'
                  ? 'File too large for text diff'
                  : special === 'encoding'
                    ? 'Unsupported text encoding'
                    : 'Unmerged index'}
          </h3>
          {special === 'gitlink' && (
            <>
              <p className="font-mono break-all">
                {document.left.oid ?? 'absent'} → {document.right.oid ?? 'unavailable'}
              </p>
              {document.childContextId ? (
                <div className="flex flex-wrap gap-1">
                  <Button
                    variant="outline"
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent('orca:git-context-changes', {
                          detail: {
                            contextId: document.childContextId,
                            rootPath: file.gitDiffRootPath,
                            worktreeId: file.worktreeId
                          }
                        })
                      )
                    }
                  >
                    Open child Changes
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent('orca:git-context-log', {
                          detail: {
                            contextId: document.childContextId,
                            rootPath: file.gitDiffRootPath,
                            worktreeId: file.worktreeId,
                            revision:
                              document.right.source.kind === 'commit'
                                ? document.right.source.oid
                                : undefined
                          }
                        })
                      )
                    }
                  >
                    Open child Log
                  </Button>
                </div>
              ) : (
                <p>Child checkout unavailable; initialize it explicitly before browsing.</p>
              )}
            </>
          )}
          {special === 'symlink' && (
            <>
              <p>Targets are displayed without following the link.</p>
              <pre className="whitespace-pre-wrap break-all">
                {result?.originalContent || '(absent)'} → {result?.modifiedContent || '(absent)'}
              </pre>
            </>
          )}
          {special === 'encoding' && (
            <p>Bytes are not valid UTF-8; no lossy replacement or editable text is shown.</p>
          )}
          {special === 'large' && (
            <p>
              Original: {document.left.bytes ?? 'unknown'} bytes · Modified:{' '}
              {document.right.bytes ?? 'unknown'} bytes. Content was not loaded beyond the bounded
              preview limit.
            </p>
          )}
          {special === 'conflict' && (
            <p>
              The index contains conflict stages, not a stage-zero file. Resolve the conflict
              explicitly; this viewer does not treat missing stage zero as a deletion.
            </p>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {children(contextId ? mode : sideBySide)}
        </div>
      )}
    </div>
  )
}

/**
 * Lines and hunks are addressed by host-issued ids from the diff document. The
 * host rebuilds the patch from those ids and refuses when the content fence moved,
 * so a stale choice never applies to a similar fragment of new content.
 */
function PartialSelection({
  file,
  document,
  reload
}: {
  file: OpenFile
  document: GitDiffDocument
  reload: () => void
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string } | null>(
    null
  )
  const [busy, setBusy] = useState(false)
  const selection = file.gitDiffSelection
  const hunks = document.hunks ?? []
  const direction: 'stage' | 'unstage' | undefined = selection
    ? selection.left.kind === 'head' && selection.right.kind === 'index'
      ? 'unstage'
      : (selection.left.kind === 'index' || selection.left.kind === 'empty') &&
          selection.right.kind === 'worktree'
        ? 'stage'
        : undefined
    : undefined
  useEffect(() => {
    setSelected(new Set())
  }, [document.id])
  if (!document.id || !direction || !selection?.contextId || !hunks.length) {
    return document.partialUnavailable ? (
      <p className="text-muted-foreground" data-testid="git-partial-unavailable">
        {document.partialUnavailable}
      </p>
    ) : null
  }
  const toggle = (ids: string[]) =>
    setSelected((previous) => {
      const next = new Set(previous)
      const all = ids.every((id) => next.has(id))
      for (const id of ids) {
        if (all) {
          next.delete(id)
        } else {
          next.add(id)
        }
      }
      return next
    })
  const run = async (ids: { lineIds?: string[]; hunkIds?: string[] }) => {
    if (busy) {
      return
    }
    setBusy(true)
    setNotice(null)
    try {
      const worktreePath =
        file.gitDiffRootPath ??
        (file.relativePath
          ? file.filePath.slice(0, Math.max(0, file.filePath.length - file.relativePath.length - 1))
          : file.filePath)
      const target = requireRuntimeTargetForFileOwner(
        useAppStore.getState(),
        file.worktreeId,
        file.runtimeEnvironmentId
      )
      const connectionId = getConnectionIdForFile(file.worktreeId, file.filePath) ?? undefined
      const receipt: GitMutationReceipt = await mutateRuntimeGitWorkspace(
        { target, worktreeId: file.worktreeId, worktreePath, connectionId },
        {
          action: direction,
          contextId: selection.contextId,
          filePath: file.relativePath,
          documentId: document.id,
          ...ids
        }
      )
      if (receipt.outcome === 'succeeded') {
        setSelected(new Set())
        setNotice({
          tone: 'ok',
          text: `${direction === 'stage' ? 'Staged' : 'Unstaged'} the selected changes.`
        })
        window.dispatchEvent(new CustomEvent('orca:git-workspace-refresh'))
      } else {
        setNotice({
          tone: receipt.outcome === 'unknown' ? 'warn' : 'error',
          text: receipt.error ?? 'Git refused the selection'
        })
      }
      reload()
    } catch (error) {
      setNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : 'Git refused the selection'
      })
      reload()
    } finally {
      setBusy(false)
    }
  }
  return (
    <details className="rounded border border-border p-1" data-testid="git-partial-staging">
      <summary className="cursor-pointer select-none">
        {direction === 'stage' ? 'Stage' : 'Unstage'} lines or hunks
      </summary>
      <div className="space-y-2 pt-1">
        {hunks.map((hunk) => (
          <section key={hunk.id} aria-label={`Hunk ${hunk.header}`}>
            <div className="flex flex-wrap items-center gap-1">
              <input
                type="checkbox"
                aria-label={`Select hunk ${hunk.header}`}
                checked={hunk.lines.every((line) => selected.has(line.id))}
                onChange={() => toggle(hunk.lines.map((line) => line.id))}
              />
              <code className="break-all">{hunk.header}</code>
              <Button
                variant="ghost"
                size="xs"
                disabled={busy}
                onClick={() =>
                  void run({
                    hunkIds: [hunk.id]
                  })
                }
              >
                {direction === 'stage' ? 'Stage' : 'Unstage'} hunk
              </Button>
            </div>
            <ul>
              {hunk.lines.map((line) => (
                <li key={line.id}>
                  <label className="flex items-start gap-1 font-mono break-all">
                    <input
                      type="checkbox"
                      checked={selected.has(line.id)}
                      aria-label={`${line.kind} ${line.text}`}
                      onChange={() => toggle([line.id])}
                    />
                    <span>
                      {line.kind === 'add' ? '+' : '-'}
                      {line.text || ' '}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <Button
          size="xs"
          disabled={busy || selected.size === 0}
          onClick={() => void run({ lineIds: [...selected] })}
        >
          {direction === 'stage' ? 'Stage' : 'Unstage'} {selected.size} line(s)
        </Button>
        {notice && (
          <p
            role={notice.tone === 'ok' ? 'status' : 'alert'}
            data-testid="git-partial-notice"
            className={notice.tone === 'error' ? 'text-destructive' : undefined}
          >
            {notice.text}
          </p>
        )}
      </div>
    </details>
  )
}
