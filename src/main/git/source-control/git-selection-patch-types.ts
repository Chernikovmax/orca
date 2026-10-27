import type { SourceRow } from './git-selection-patch-text'

export type IssuedRow = SourceRow & { id?: string }
export type IssuedHunk = {
  id: string
  header: string
  oldStart: number
  newStart: number
  rows: IssuedRow[]
}
export type IssuedGitSelection = {
  id: string
  cwd: string
  contextId?: string
  filePath: string
  direction: 'stage' | 'unstage'
  fence: string
  mode: string
  sourceNewFile: boolean
  sourceDeleted: boolean
  hunks: IssuedHunk[]
}
