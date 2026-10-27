import type { GitDiffResult } from '../../../shared/git-diff-compare-types'
import type { GitDiffSelection } from '../../../shared/git-diff-document'
import type { GetStatusOptions } from './get-status-options'
import { workspaceGitRead } from './git-workspace-discovery'

export type RowKind = ' ' | '-' | '+'
export type SourceRow = { kind: RowKind; text: string; noNewline?: boolean }
export type SourceHunk = { header: string; oldStart: number; newStart: number; rows: SourceRow[] }
export type PatchHeader = {
  lines: string[]
  newFileMode?: string
  deletedFileMode?: string
  indexMode?: string
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** C-quotes a full header path exactly when the raw spelling would break parsing. */
export function headerPath(filePath: string): string {
  // oxlint-disable-next-line no-control-regex -- Git's C-quoted path syntax is defined over control bytes.
  if (!/[\u0000-\u001f"\\\u007f-\uffff]/.test(filePath)) {
    return filePath
  }
  const escaped = [...filePath]
    .map((char) => {
      if (char === '\\') {
        return '\\\\'
      }
      if (char === '"') {
        return '\\"'
      }
      if (char === '\t') {
        return '\\t'
      }
      if (char === '\n') {
        return '\\n'
      }
      const code = char.codePointAt(0)!
      if (code < 0x20 || code === 0x7f) {
        return `\\${code.toString(8).padStart(3, '0')}`
      }
      if (code > 0x7f) {
        return [...Buffer.from(char, 'utf8')]
          .map((byte) => `\\${byte.toString(8).padStart(3, '0')}`)
          .join('')
      }
      return char
    })
    .join('')
  return `"${escaped}"`
}

function parseHeader(lines: string[]): PatchHeader {
  const header: PatchHeader = { lines }
  for (const line of lines) {
    if (line.startsWith('new file mode ')) {
      header.newFileMode = line.slice('new file mode '.length).trim()
    } else if (line.startsWith('deleted file mode ')) {
      header.deletedFileMode = line.slice('deleted file mode '.length).trim()
    } else {
      const index = /^index [0-9a-f]+\.\.[0-9a-f]+ (\d{6})$/.exec(line)
      if (index) {
        header.indexMode = index.at(1)
      }
    }
  }
  return header
}

const UNSUPPORTED_HEADER = [
  'old mode ',
  'new mode ',
  'rename from ',
  'rename to ',
  'similarity index ',
  'dissimilarity index ',
  'copy from ',
  'copy to '
]

/** Parses `git diff` output byte-faithfully: latin1 round-trips every byte. */
export function parsePatch(
  raw: string
): { header: PatchHeader; hunks: SourceHunk[] } | undefined {
  const headerLines: string[] = []
  const hunks: SourceHunk[] = []
  let hunk: SourceHunk | undefined
  for (const line of raw.split('\n')) {
    const match = HUNK_HEADER.exec(line)
    if (match) {
      hunk = {
        header: line,
        oldStart: Number(match.at(1)),
        newStart: Number(match.at(3)),
        rows: []
      }
      hunks.push(hunk)
      continue
    }
    if (!hunk) {
      if (line === '') {
        continue
      }
      if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
        return undefined
      }
      if (UNSUPPORTED_HEADER.some((prefix) => line.startsWith(prefix))) {
        return undefined
      }
      headerLines.push(line)
      continue
    }
    if (line.startsWith('\\')) {
      const previous = hunk.rows.at(-1)
      if (previous) {
        previous.noNewline = true
      }
      continue
    }
    if (line === '') {
      continue
    }
    const kind = line.at(0)
    if (kind === ' ' || kind === '-' || kind === '+') {
      hunk.rows.push({ kind, text: line.slice(1) })
      continue
    }
    return undefined
  }
  return { header: parseHeader(headerLines), hunks }
}

function syntheticNewFilePatch(content: string, filePath: string, mode: string): string {
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const body: string[] = []
  for (const line of lines) {
    const hasNewline = line.endsWith('\n')
    body.push(`+${hasNewline ? line.slice(0, -1) : line}`)
    if (!hasNewline) {
      body.push('\\ No newline at end of file')
    }
  }
  return [
    `diff --git a/${headerPath(filePath)} b/${headerPath(filePath)}`,
    `new file mode ${mode}`,
    '--- /dev/null',
    `+++ b/${headerPath(filePath)}`,
    ...(lines.length ? [`@@ -0,0 +1,${lines.length} @@`, ...body] : []),
    ''
  ].join('\n')
}

export async function readPatch(
  cwd: string,
  filePath: string,
  direction: 'stage' | 'unstage',
  result: GitDiffResult,
  options: GetStatusOptions
): Promise<string> {
  if (direction === 'unstage' || result.document?.left.exists) {
    return workspaceGitRead(
      cwd,
      [
        'diff',
        ...(direction === 'unstage' ? ['--cached'] : []),
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--no-renames',
        '--unified=3',
        '--',
        `:(literal)${filePath}`
      ],
      options
    )
  }
  return syntheticNewFilePatch(
    result.modifiedContent,
    filePath,
    result.document?.right.mode ?? '100644'
  )
}

export function ownershipDirection(
  selection: GitDiffSelection
): 'stage' | 'unstage' | undefined {
  if (selection.left.kind === 'head' && selection.right.kind === 'index') {
    return 'unstage'
  }
  if (
    (selection.left.kind === 'index' || selection.left.kind === 'empty') &&
    selection.right.kind === 'worktree'
  ) {
    return 'stage'
  }
  return undefined
}
