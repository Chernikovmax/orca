import type { GitConflictOperation } from '../../../shared/git-status-types'
import type { GetStatusOptions } from './get-status-options'
import { workspaceGitRead } from './git-workspace-discovery'

export async function readConflictRenamePaths(
  cwd: string,
  filePath: string,
  operation: GitConflictOperation,
  options: GetStatusOptions
): Promise<string[]> {
  if (operation === 'unknown') {
    return []
  }
  const marker =
    operation === 'merge'
      ? 'MERGE_HEAD'
      : operation === 'rebase'
        ? 'REBASE_HEAD'
        : 'CHERRY_PICK_HEAD'
  const incoming = (
    await workspaceGitRead(cwd, ['rev-parse', '--verify', '--quiet', marker], options, true)
  ).trim()
  if (!incoming || incoming.includes('\n')) {
    return []
  }
  const base =
    operation === 'merge'
      ? (await workspaceGitRead(cwd, ['merge-base', 'HEAD', incoming], options)).trim()
      : (await workspaceGitRead(cwd, ['rev-list', '--parents', '-n', '1', incoming], options))
          .trim()
          .split(' ')[1]
  if (!base) {
    return []
  }
  const related = new Set<string>()
  for (const target of ['HEAD', incoming]) {
    const fields = (
      await workspaceGitRead(
        cwd,
        [
          'diff-tree',
          '--no-commit-id',
          '--name-status',
          '-r',
          '-M',
          '-l200',
          '-z',
          base,
          target,
          '--'
        ],
        options
      )
    ).split('\0')
    for (let index = 0; index < fields.length && fields[index];) {
      const status = fields[index++]
      const oldPath = fields[index++]
      if (!status.startsWith('R') && !status.startsWith('C')) {
        continue
      }
      const newPath = fields[index++]
      if (oldPath === filePath && newPath) {
        related.add(newPath)
      }
      if (newPath === filePath && oldPath) {
        related.add(oldPath)
      }
    }
  }
  return [...related]
}
