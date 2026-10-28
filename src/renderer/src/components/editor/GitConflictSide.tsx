import type {
  GitConflictContent,
  GitConflictStage
} from '../../../../shared/git-workspace-conflict'
import type { OpenFile } from '@/store/slices/editor'
import { MonacoEditor } from './editor-lazy-views'

const ignoreReadOnlyChange = (_content: string): void => {}

export function GitConflictContentSummary({ content }: { content: GitConflictContent }) {
  return (
    <p className="p-3 text-xs text-muted-foreground break-all">
      {content.kind === 'absent'
        ? 'Absent — choosing this side records a deletion.'
        : content.kind === 'binary'
          ? `Binary or non-UTF-8 content · ${content.bytes} bytes. Choose an explicit side or deletion.`
          : content.kind === 'large'
            ? `Oversized content · ${content.bytes} bytes. Not loaded beyond the host limit.`
            : content.kind === 'gitlink'
              ? 'Submodule commit — resolve by recording an explicit child commit OID.'
              : content.kind === 'symlink'
                ? `Symbolic link target (not followed): ${content.content}`
                : content.content}
    </p>
  )
}

export function GitConflictSide({
  file,
  stage,
  label,
  identity,
  side
}: {
  file: OpenFile
  stage: GitConflictStage
  label: string
  identity: string
  side: 'base' | 'ours' | 'theirs'
}) {
  const modelPath = `${file.filePath}.orca-conflict-${identity}-${side}`
  return (
    <section
      aria-label={label}
      className="flex min-h-40 min-w-0 flex-col border border-border"
      data-testid={`git-conflict-${side}`}
    >
      <h3 className="border-b border-border px-2 py-1 text-xs font-semibold">{label}</h3>
      <p className="break-all px-2 py-1 font-mono text-2xs text-muted-foreground">
        {stage.mode ?? 'absent'} · {stage.oid ?? 'no object'}
      </p>
      <div className="min-h-0 flex-1 bg-editor-surface">
        {stage.content.kind === 'text' ? (
          <MonacoEditor
            fileId={modelPath}
            filePath={modelPath}
            relativePath={file.relativePath}
            viewStateKey={modelPath}
            content={stage.content.content}
            language={file.language}
            onContentChange={ignoreReadOnlyChange}
            onSave={ignoreReadOnlyChange}
            readOnly
            passiveMirror
          />
        ) : (
          <GitConflictContentSummary content={stage.content} />
        )}
      </div>
    </section>
  )
}
