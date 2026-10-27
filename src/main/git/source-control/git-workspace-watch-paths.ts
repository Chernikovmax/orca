import * as path from 'node:path'
import type { GitWorkspaceSnapshot } from '../../../shared/git-workspace-types'

const snapshots = new Map<string, { commonGitDir: string; expires: number; paths: string[] }>()
const listeners = new Set<() => void>()

export function onGitWorkspaceWatchPathsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function rememberGitWorkspaceWatchPaths(snapshot: GitWorkspaceSnapshot): void {
  const root = snapshot.repositories.find(
    (repository) => repository.context.id === snapshot.rootContextId
  )
  if (!root) {
    return
  }
  const paths = new Set<string>()
  for (const repository of snapshot.repositories) {
    const { gitDir, commonGitDir } = repository.context
    for (const name of ['HEAD', 'index', 'config', 'logs/HEAD']) {
      paths.add(path.join(gitDir, name))
    }
    for (const name of ['config', 'packed-refs']) {
      paths.add(path.join(commonGitDir, name))
    }
    if (
      repository.branch?.startsWith('refs/heads/') &&
      !repository.branch.split('/').includes('..')
    ) {
      paths.add(path.join(commonGitDir, repository.branch))
    }
  }
  snapshots.delete(root.context.checkoutPath)
  snapshots.set(root.context.checkoutPath, {
    commonGitDir: root.context.commonGitDir,
    expires: Date.now() + 45_000,
    paths: [...paths]
  })
  while (snapshots.size > 8) {
    const oldest = snapshots.keys().next().value
    if (oldest === undefined) {
      break
    }
    snapshots.delete(oldest)
  }
  for (const listener of listeners) {
    listener()
  }
}

export function getGitWorkspaceWatchPaths(commonGitDir: string): string[] {
  const paths = new Set<string>()
  for (const [key, snapshot] of snapshots) {
    if (snapshot.expires <= Date.now()) {
      snapshots.delete(key)
      continue
    }
    if (snapshot.commonGitDir === commonGitDir) {
      for (const file of snapshot.paths) {
        paths.add(file)
      }
    }
  }
  return [...paths]
}
