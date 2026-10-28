export type GitConflictResolution = 'result' | 'ours' | 'theirs' | 'delete' | 'gitlink'

export type GitConflictContent =
  | { kind: 'text'; content: string }
  | { kind: 'binary'; bytes: number }
  | { kind: 'absent' }
  | { kind: 'gitlink' }
  | { kind: 'symlink'; content: string }
  | { kind: 'large'; bytes: number }

export type GitConflictStage = {
  oid?: string
  mode?: string
  content: GitConflictContent
}

export type GitWorkspaceConflictDocument = {
  documentId: string
  contextId: string
  filePath: string
  operation: 'merge' | 'rebase' | 'cherry-pick' | 'unknown'
  kind: 'text' | 'binary' | 'add-add' | 'modify-delete' | 'rename' | 'gitlink' | 'symlink'
  relatedPaths: string[]
  base: GitConflictStage
  ours: GitConflictStage
  theirs: GitConflictStage
  result: GitConflictContent
  editable: boolean
  labels: { base: string; ours: string; theirs: string; result: string }
}
