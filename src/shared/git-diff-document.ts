import type { GitSelectableHunk } from './git-workspace-mutation'

export type GitDiffSide =
  | { kind: 'head' | 'index' | 'worktree' | 'empty' }
  | { kind: 'commit'; oid: string }

export type GitDiffSelection = {
  contextId?: string
  oldPath?: string
  left: GitDiffSide
  right: GitDiffSide
}

export type GitDiffSideInfo = {
  source: GitDiffSide
  path: string
  exists: boolean
  oid?: string
  mode?: string
  bytes?: number
  finalNewline?: boolean
  lineEndings?: 'LF' | 'CRLF' | 'mixed' | 'none'
}

export type GitDiffDocument = {
  id?: string
  hunks?: GitSelectableHunk[]
  partialUnavailable?: string
  contextId?: string
  left: GitDiffSideInfo
  right: GitDiffSideInfo
  special?: 'gitlink' | 'symlink' | 'mode' | 'large' | 'encoding' | 'conflict'
  message?: string
  childContextId?: string
  generation: string
  stale: boolean
}
