import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { getConnectionIdForFile } from '@/lib/connection-context'
import {
  getRuntimeTargetForFileOwner,
  requireRuntimeTargetForFileOwner
} from '@/lib/file-owner-runtime-target'
import { findGitConflictBlocks } from './monaco-conflict-decorations'
import { applyGitConflictChoice, type GitConflictChoice } from './apply-git-conflict-choice'
import { useGitConflictDocument } from './use-git-conflict-document'
import { MonacoEditor } from './editor-lazy-views'
import { GitConflictContentSummary, GitConflictSide } from './GitConflictSide'
import { GitConflictResolutionActions } from './GitConflictResolutionActions'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'

export default function GitConflictResolver({ file }: { file: OpenFile }) {
  const ownerIdentity = useAppStore((state) =>
    JSON.stringify(getRuntimeTargetForFileOwner(state, file.worktreeId, file.runtimeEnvironmentId))
  )
  const registeredRoot = useAppStore((state) => {
    for (const rows of Object.values(state.worktreesByRepo)) {
      const worktree = rows.find((item) => item.id === file.worktreeId)
      if (worktree) {
        return worktree.path
      }
    }
    return undefined
  })
  const worktreePath =
    file.gitConflict?.rootPath ??
    file.gitDiffRootPath ??
    registeredRoot ??
    file.filePath.slice(0, Math.max(0, file.filePath.length - file.relativePath.length - 1))
  const connectionId = getConnectionIdForFile(file.worktreeId, file.filePath) ?? undefined
  const context = useMemo((): RuntimeGitContext | null => {
    if (ownerIdentity === 'null') {
      return null
    }
    return {
      target: requireRuntimeTargetForFileOwner(
        useAppStore.getState(),
        file.worktreeId,
        file.runtimeEnvironmentId
      ),
      worktreeId: file.worktreeId,
      worktreePath,
      connectionId
    }
  }, [ownerIdentity, file.worktreeId, file.runtimeEnvironmentId, worktreePath, connectionId])
  if (!context) {
    return (
      <p role="alert" className="p-3 text-sm text-destructive">
        The file execution host cannot be verified. Reopen this conflict from Changes.
      </p>
    )
  }
  const contextId = file.gitConflict?.contextId ?? file.gitDiffSelection?.contextId
  const identity = JSON.stringify([ownerIdentity, connectionId, file.worktreeId, file.filePath])
  return (
    <GitConflictDocumentSurface
      key={identity}
      identity={identity}
      context={context}
      contextId={contextId}
      file={file}
    />
  )
}

function GitConflictDocumentSurface({
  identity,
  context,
  contextId,
  file
}: {
  identity: string
  context: RuntimeGitContext
  contextId?: string
  file: OpenFile
}) {
  const controller = useGitConflictDocument(
    identity,
    context,
    file.relativePath,
    file.filePath,
    contextId
  )
  const { draft } = controller
  const document = draft.document
  const [selectedBlock, setSelectedBlock] = useState(0)
  const blocks = useMemo(() => findGitConflictBlocks(draft.content), [draft.content])
  const index = Math.min(selectedBlock, Math.max(0, blocks.length - 1))
  const dirty = draft.content !== draft.savedContent
  const locked = draft.busy || draft.stale || draft.resolved
  const choose = (choice: GitConflictChoice) => {
    controller.setContent(applyGitConflictChoice(draft.content, index, choice))
    setSelectedBlock(index)
  }
  const modelPath = document ? `${file.filePath}.orca-conflict-${document.documentId}-result` : ''
  return (
    <section
      aria-label="Conflict resolver"
      className="flex h-full min-h-0 flex-col overflow-auto scrollbar-editor bg-background"
      data-testid="git-conflict-resolver"
      aria-busy={draft.busy}
    >
      <div className="space-y-2 border-b border-border p-2 text-xs">
        <h2 className="font-semibold break-all">
          {document
            ? `${document.operation} conflict · ${document.kind} · ${document.filePath}`
            : `Conflict · ${file.relativePath}`}
        </h2>
        {document && (
          <p className="break-all text-muted-foreground">
            Context {document.contextId}
            {document.relatedPaths.length
              ? ` · Rename-associated paths: ${document.relatedPaths.join(', ')}. Resolve each index path separately.`
              : ''}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-1">
          <Button
            size="xs"
            variant="outline"
            disabled={draft.busy}
            onClick={() => void controller.load()}
          >
            Reload conflict
          </Button>
          {document?.editable && (
            <>
              <Button size="xs" disabled={locked || !dirty} onClick={() => void controller.save()}>
                Save result
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={locked || dirty}
                onClick={() => void controller.resolve('result')}
              >
                Mark Resolved
              </Button>
              <span role="status">
                {dirty
                  ? 'Unsaved draft — retained when navigating'
                  : 'Result matches the reviewed worktree'}
              </span>
            </>
          )}
          {draft.resolved && (
            <Button
              size="xs"
              variant="outline"
              onClick={() => useAppStore.getState().closeFile(file.id)}
            >
              Close resolver
            </Button>
          )}
        </div>
        {draft.notice && (
          <p
            role={draft.notice.error ? 'alert' : 'status'}
            className={
              draft.notice.error ? 'text-destructive whitespace-pre-wrap' : 'whitespace-pre-wrap'
            }
            data-testid="git-conflict-notice"
          >
            {draft.notice.text}
          </p>
        )}
        {draft.stale && (
          <p role="status">
            Writes are blocked. Reload is explicit and preserves the previous draft for recovery.
          </p>
        )}
        {draft.retained.map((retained) => (
          <details
            key={retained.documentId}
            className="rounded border border-border p-2"
            data-testid="git-conflict-retained-draft"
          >
            <summary>Retained draft from previous document · {retained.documentId}</summary>
            <pre className="max-h-40 overflow-auto scrollbar-editor whitespace-pre-wrap break-all p-2">
              {retained.content}
            </pre>
            <Button
              size="xs"
              variant="outline"
              disabled={locked || !document?.editable}
              onClick={() => controller.restoreDraft(retained.documentId)}
            >
              Restore retained draft into result
            </Button>
          </details>
        ))}
        {!document && draft.busy && <p role="status">Loading bounded local conflict stages…</p>}
      </div>
      {document && (
        <>
          <div className="grid min-h-48 shrink-0 grid-cols-1 gap-1 p-1 md:grid-cols-3">
            {(['base', 'ours', 'theirs'] as const).map((side) => (
              <GitConflictSide
                key={`${document.documentId}:${side}`}
                file={file}
                side={side}
                identity={document.documentId}
                label={document.labels[side]}
                stage={document[side]}
              />
            ))}
          </div>
          <section
            aria-label="Conflict result"
            className="flex min-h-64 flex-1 flex-col border-t border-border"
            data-testid="git-conflict-result"
          >
            <h3 className="px-2 py-1 text-xs font-semibold">{document.labels.result}</h3>
            {document.editable ? (
              <>
                <div
                  className="flex flex-wrap items-center gap-1 border-y border-border p-1 text-xs"
                  aria-label="Conflict block actions"
                >
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!blocks.length}
                    onClick={() => setSelectedBlock((index + blocks.length - 1) % blocks.length)}
                  >
                    Previous conflict
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!blocks.length}
                    onClick={() => setSelectedBlock((index + 1) % blocks.length)}
                  >
                    Next conflict
                  </Button>
                  <span aria-live="polite">
                    {blocks.length
                      ? `Conflict ${index + 1} of ${blocks.length}`
                      : 'No conflict marker blocks; explicit Mark Resolved is still required.'}
                  </span>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={locked || !blocks.length}
                    onClick={() => choose('ours')}
                  >
                    Use ours for block
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={locked || !blocks.length}
                    onClick={() => choose('theirs')}
                  >
                    Use theirs for block
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={locked || !blocks.length}
                    onClick={() => choose('both')}
                  >
                    Use both for block
                  </Button>
                </div>
                <div className="min-h-0 flex-1 bg-editor-surface">
                  <MonacoEditor
                    key={modelPath}
                    fileId={modelPath}
                    filePath={modelPath}
                    relativePath={file.relativePath}
                    viewStateKey={modelPath}
                    content={draft.content}
                    language={file.language}
                    onContentChange={controller.setContent}
                    onSave={() => {
                      if (!locked && dirty) {
                        void controller.save()
                      }
                    }}
                    conflictDecorationsEnabled
                    readOnly={draft.busy || draft.resolved}
                    revealLine={blocks[index]?.startLine}
                  />
                </div>
              </>
            ) : (
              <GitConflictContentSummary content={document.result} />
            )}
          </section>
          <GitConflictResolutionActions
            key={document.documentId}
            file={file}
            document={document}
            workspace={draft.workspace}
            disabled={locked}
            dirty={dirty}
            onResolve={controller.resolve}
            onInspectChild={controller.inspectChild}
          />
        </>
      )}
    </section>
  )
}
