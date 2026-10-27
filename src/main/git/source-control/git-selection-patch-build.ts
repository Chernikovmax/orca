import type { GitWorkspaceMutationRequest } from '../../../shared/git-workspace-mutation'
import { GitMutationError } from './git-workspace-mutation-error'
import { headerPath, type RowKind, type SourceRow } from './git-selection-patch-text'
import type { IssuedGitSelection, IssuedHunk, IssuedRow } from './git-selection-patch-types'

type HunkBody = {
  body: string[]
  oldCount: number
  newCount: number
  changed: boolean
  allSelected: boolean
}

function buildHunkBody(
  entry: IssuedGitSelection,
  hunk: IssuedHunk,
  selected: Set<string>
): HunkBody {
  const body: string[] = []
  let oldCount = 0
  let newCount = 0
  let changed = false
  let changeRows = 0
  let selectedRows = 0
  const push = (row: SourceRow, kind: RowKind): void => {
    body.push(`${kind}${row.text}`)
    if (row.noNewline) {
      body.push('\\ No newline at end of file')
    }
    if (kind !== '+') {
      oldCount++
    }
    if (kind !== '-') {
      newCount++
    }
  }
  for (const row of hunk.rows) {
    if (row.kind === ' ') {
      push(row, ' ')
      continue
    }
    const picked = !!row.id && selected.has(row.id)
    changeRows++
    if (picked) {
      selectedRows++
      changed = true
    }
    if (entry.direction === 'stage') {
      if (row.kind === '-') {
        push(row, picked ? '-' : ' ')
      } else if (picked) {
        push(row, '+')
      }
      continue
    }
    // Unstage: the issued diff is HEAD -> index, but the patch transforms index -> partial index.
    if (row.kind === '-') {
      if (picked) {
        push(row, '+')
      }
    } else {
      push(row, picked ? '-' : ' ')
    }
  }
  return {
    body,
    oldCount,
    newCount,
    changed,
    allSelected: changeRows > 0 && selectedRows === changeRows
  }
}

/**
 * A replacement pair (old line plus its new line) and any block touching a missing
 * final newline must move together: staging only one side would duplicate a line or
 * produce a patch whose newline boundary is impossible. Pure addition and pure
 * deletion blocks keep per-line granularity.
 */
function expandSelection(entry: IssuedGitSelection, selected: Set<string>): void {
  for (const hunk of entry.hunks) {
    const blocks: IssuedRow[][] = []
    let block: IssuedRow[] = []
    for (const row of hunk.rows) {
      if (row.kind === ' ') {
        if (block.length) {
          blocks.push(block)
          block = []
        }
        continue
      }
      block.push(row)
    }
    if (block.length) {
      blocks.push(block)
    }
    for (const rows of blocks) {
      const ids = rows.map((row) => row.id).filter((id): id is string => !!id)
      if (!ids.some((id) => selected.has(id))) {
        continue
      }
      if (rows.some((row) => row.noNewline)) {
        for (const id of ids) {
          selected.add(id)
        }
        continue
      }
      const deletions = rows.filter((row) => row.kind === '-' && row.id).map((row) => row.id!)
      const additions = rows.filter((row) => row.kind === '+' && row.id).map((row) => row.id!)
      const pairs = Math.min(deletions.length, additions.length)
      for (let index = 0; index < pairs; index++) {
        if (selected.has(deletions[index]) || selected.has(additions[index])) {
          selected.add(deletions[index])
          selected.add(additions[index])
        }
      }
    }
  }
}

/**
 * Builds the host patch for the selected rows, always applied forward to the real
 * index. Selection ids address exactly the issued rows, so a stale choice can
 * never be applied to a similar fragment of new content.
 */
export function selectedGitPatch(
  entry: IssuedGitSelection,
  request: GitWorkspaceMutationRequest
): { patch?: Buffer; wholeFile: boolean } {
  const selected = new Set<string>()
  const known = new Set<string>()
  for (const hunk of entry.hunks) {
    for (const row of hunk.rows) {
      if (row.id) {
        known.add(row.id)
      }
    }
  }
  for (const lineId of request.lineIds ?? []) {
    if (!known.has(lineId)) {
      throw new GitMutationError('invalid', 'Selection does not belong to this diff; reload it')
    }
    selected.add(lineId)
  }
  for (const hunkId of request.hunkIds ?? []) {
    const hunk = entry.hunks.find((item) => item.id === hunkId)
    if (!hunk) {
      throw new GitMutationError('invalid', 'Unknown hunk selection; reload the diff')
    }
    for (const row of hunk.rows) {
      if (row.id) {
        selected.add(row.id)
      }
    }
  }
  if (!selected.size) {
    throw new GitMutationError('invalid', 'Select at least one line or hunk to stage')
  }
  expandSelection(entry, selected)
  const hunks: string[] = []
  const body: string[] = []
  let delta = 0
  let allChangesSelected = true
  let anyChange = false
  for (const hunk of entry.hunks) {
    const built = buildHunkBody(entry, hunk, selected)
    if (!built.allSelected) {
      allChangesSelected = false
    }
    if (!built.changed) {
      continue
    }
    anyChange = true
    const oldStart = entry.direction === 'stage' ? hunk.oldStart : hunk.newStart
    hunks.push(
      `@@ -${oldStart},${built.oldCount} +${oldStart + delta},${built.newCount} @@`,
      ...built.body
    )
    body.push(...built.body)
    delta += built.newCount - built.oldCount
  }
  if (!anyChange) {
    throw new GitMutationError('invalid', 'No file changes are selectable')
  }
  if (allChangesSelected) {
    return { wholeFile: true }
  }
  const newEmpty = !body.some((line) => line.startsWith(' ') || line.startsWith('+'))
  const oldExists = entry.direction === 'stage' ? !entry.sourceNewFile : !entry.sourceDeleted
  const newExists = entry.direction === 'stage' ? !entry.sourceDeleted || !newEmpty : true
  if (!oldExists && !newExists) {
    throw new GitMutationError(
      'invalid',
      'The selection would neither add, change nor delete content'
    )
  }
  const header = [`diff --git a/${headerPath(entry.filePath)} b/${headerPath(entry.filePath)}`]
  if (!oldExists) {
    header.push(`new file mode ${entry.mode}`)
  } else if (!newExists) {
    header.push(`deleted file mode ${entry.mode}`)
  }
  header.push(oldExists ? `--- a/${headerPath(entry.filePath)}` : '--- /dev/null')
  header.push(newExists ? `+++ b/${headerPath(entry.filePath)}` : '+++ /dev/null')
  return {
    wholeFile: false,
    patch: Buffer.from([...header, ...hunks, ''].join('\n'), 'latin1')
  }
}
