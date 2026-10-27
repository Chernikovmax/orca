import { randomUUID } from 'node:crypto'
import type { GitDiffResult } from '../../../shared/git-diff-compare-types'
import type { GitDiffSelection } from '../../../shared/git-diff-document'
import type { GitSelectableHunk, GitSelectableLine } from '../../../shared/git-workspace-mutation'
import type { GetStatusOptions } from './get-status-options'
import { readContentFence } from './git-content-fence'
import { GitMutationError } from './git-workspace-mutation-error'
import {
  ownershipDirection,
  parsePatch,
  readPatch
} from './git-selection-patch-text'
import type { IssuedGitSelection, IssuedHunk, IssuedRow } from './git-selection-patch-types'

export { selectedGitPatch } from './git-selection-patch-build'
export type { IssuedGitSelection } from './git-selection-patch-types'

const issued = new Map<string, IssuedGitSelection>()
const ISSUED_LIMIT = 128

/**
 * Issues host-owned selection ids for an already-read diff. The registry entry
 * carries the exact content fence the rows came from; a write is accepted only
 * while that fence still matches.
 */
export async function issueGitSelection(
  cwd: string,
  filePath: string,
  selection: GitDiffSelection,
  result: GitDiffResult,
  options: GetStatusOptions
): Promise<void> {
  const document = result.document
  if (!document || document.stale) {
    return
  }
  const direction = ownershipDirection(selection)
  if (!direction) {
    return
  }
  if (selection.oldPath && selection.oldPath !== filePath) {
    document.partialUnavailable =
      'Partial changes are unavailable for a rename; stage or unstage the whole file.'
    return
  }
  if (result.kind !== 'text' || document.special || result.largeDiffRenderLimit?.limited) {
    document.partialUnavailable =
      'Partial changes are unavailable for this representation; stage or unstage the whole file.'
    return
  }
  const before = await readContentFence(cwd, { filePath }, options)
  const parsed = parsePatch(await readPatch(cwd, filePath, direction, result, options))
  const after = await readContentFence(cwd, { filePath }, options)
  if (before !== after) {
    document.stale = true
    return
  }
  if (!parsed || !parsed.hunks.length) {
    document.partialUnavailable =
      'No selectable text hunks were issued for this file; use whole-file staging.'
    return
  }
  const id = randomUUID()
  const hunks: IssuedHunk[] = []
  const selectable: GitSelectableHunk[] = []
  let lineIndex = 0
  for (const [hunkIndex, hunk] of parsed.hunks.entries()) {
    const rows: IssuedRow[] = []
    const lines: GitSelectableLine[] = []
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    for (const row of hunk.rows) {
      const issuedRow: IssuedRow = { ...row }
      if (row.kind !== ' ') {
        issuedRow.id = `${id}:l${lineIndex++}`
        lines.push({
          id: issuedRow.id,
          kind: row.kind === '+' ? 'add' : 'delete',
          text: row.text,
          ...(row.kind === '-' ? { oldLine } : { newLine })
        })
      }
      if (row.kind !== '+') {
        oldLine++
      }
      if (row.kind !== '-') {
        newLine++
      }
      rows.push(issuedRow)
    }
    const hunkId = `${id}:h${hunkIndex}`
    hunks.push({
      id: hunkId,
      header: hunk.header,
      oldStart: hunk.oldStart,
      newStart: hunk.newStart,
      rows
    })
    selectable.push({
      id: hunkId,
      header: hunk.header,
      oldStart: hunk.oldStart,
      newStart: hunk.newStart,
      lines
    })
  }
  issued.set(id, {
    id,
    cwd,
    ...(selection.contextId ? { contextId: selection.contextId } : {}),
    filePath,
    direction,
    fence: after,
    mode:
      parsed.header.newFileMode ??
      parsed.header.deletedFileMode ??
      parsed.header.indexMode ??
      '100644',
    sourceNewFile: !!parsed.header.newFileMode,
    sourceDeleted: !!parsed.header.deletedFileMode,
    hunks
  })
  while (issued.size > ISSUED_LIMIT) {
    issued.delete(issued.keys().next().value!)
  }
  document.id = id
  document.hunks = selectable
}

export function getIssuedGitSelection(id: string | undefined): IssuedGitSelection {
  const entry = id ? issued.get(id) : undefined
  if (!entry) {
    throw new GitMutationError(
      'stale',
      'Diff selection expired; reload the exact diff before writing'
    )
  }
  return entry
}

/** Refuses a selection whose file content, HEAD or index no longer matches the issued rows. */
export async function assertIssuedSelectionFresh(
  entry: IssuedGitSelection,
  options: GetStatusOptions
): Promise<void> {
  const current = await readContentFence(entry.cwd, { filePath: entry.filePath }, options)
  if (current !== entry.fence) {
    throw new GitMutationError(
      'stale',
      'File content, HEAD or index changed since this diff was issued; reload before writing'
    )
  }
}
