import { createHash } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import * as path from 'node:path'
import type { GitContextRef } from '../../../shared/git-workspace-types'
import { resolveGitMetadataPath } from '../../../shared/git-metadata-path'
import type { GetStatusOptions } from './get-status-options'
import { resolveWorktreeFilesystemPath } from './worktree-filesystem-path'
import { workspaceGitRead } from './git-workspace-discovery'
import { GitWorkspaceReadError } from './git-workspace-error'

export async function readWorkspacePointer(file: string): Promise<string> {
  const info = await lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024) {
    throw new GitWorkspaceReadError(
      'access-denied',
      'Git metadata pointer must be a bounded regular file, not a symlink.'
    )
  }
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(16 * 1024 + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 16 * 1024) {
      throw new GitWorkspaceReadError('limit', 'Git metadata pointer is too large.')
    }
    return new TextDecoder('utf-8', { fatal: true })
      .decode(buffer.subarray(0, bytesRead))
      .replace(/\r?\n$/, '')
  } finally {
    await handle.close()
  }
}

export function workspacePathWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  )
}

export async function authorizeWorkspaceChild(
  parent: GitContextRef,
  relativePath: string,
  root: GitContextRef,
  options: GetStatusOptions
): Promise<string> {
  // Git paths use '/', even on Windows. Reject alternate platform spellings before normalization.
  if (
    !relativePath ||
    relativePath.includes('\0') ||
    relativePath.includes('\\') ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    relativePath
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
  ) {
    throw new GitWorkspaceReadError(
      'access-denied',
      'Submodule path is not a safe relative checkout path.'
    )
  }
  let checkout = parent.checkoutPath
  for (const segment of relativePath.split('/')) {
    checkout = path.join(checkout, segment)
    try {
      const info = await lstat(checkout)
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new GitWorkspaceReadError(
          'access-denied',
          'Submodule checkout path crosses a symlink or non-directory.'
        )
      }
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        throw new GitWorkspaceReadError(
          'unavailable',
          'Submodule checkout has not been initialized.'
        )
      }
      throw error
    }
  }
  const canonical = await realpath(checkout)
  if (!workspacePathWithin(root.checkoutPath, canonical) || canonical === root.checkoutPath) {
    throw new GitWorkspaceReadError(
      'access-denied',
      'Submodule checkout escapes the authorized root.'
    )
  }
  const marker = path.join(canonical, '.git')
  let markerStat
  try {
    markerStat = await lstat(marker)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new GitWorkspaceReadError('unavailable', 'Submodule checkout has not been initialized.')
    }
    throw error
  }
  if (markerStat.isSymbolicLink()) {
    throw new GitWorkspaceReadError('access-denied', 'Submodule .git symlink was not followed.')
  }
  let gitDir: string
  if (markerStat.isDirectory()) {
    gitDir = await realpath(marker)
  } else {
    const pointer = await readWorkspacePointer(marker)
    if (!pointer.startsWith('gitdir: ')) {
      throw new GitWorkspaceReadError('invalid-metadata', 'Submodule .git pointer is invalid.')
    }
    const resolved = resolveGitMetadataPath(canonical, pointer.slice(8), options)
    if (!resolved) {
      throw new GitWorkspaceReadError('invalid-metadata', 'Submodule .git pointer is empty.')
    }
    // Check lexical authority before realpath, which itself would read an outside path.
    if (
      !workspacePathWithin(root.commonGitDir, resolved) &&
      !workspacePathWithin(root.gitDir, resolved) &&
      !workspacePathWithin(canonical, resolved)
    ) {
      throw new GitWorkspaceReadError(
        'access-denied',
        'Submodule Git metadata points outside authorized metadata directories.'
      )
    }
    gitDir = await realpath(resolved)
  }
  if (
    !workspacePathWithin(root.commonGitDir, gitDir) &&
    !workspacePathWithin(root.gitDir, gitDir) &&
    !workspacePathWithin(canonical, gitDir)
  ) {
    throw new GitWorkspaceReadError(
      'access-denied',
      'Submodule Git metadata escapes authorized directories through a symlink.'
    )
  }
  try {
    const commonPointer = await readWorkspacePointer(path.join(gitDir, 'commondir'))
    const common = resolveGitMetadataPath(gitDir, commonPointer, options)
    if (
      !common ||
      (!workspacePathWithin(root.commonGitDir, common) &&
        !workspacePathWithin(root.gitDir, common) &&
        !workspacePathWithin(canonical, common))
    ) {
      throw new GitWorkspaceReadError(
        'access-denied',
        'Submodule common Git directory escapes authorized metadata.'
      )
    }
    const realCommon = await realpath(common)
    if (
      !workspacePathWithin(root.commonGitDir, realCommon) &&
      !workspacePathWithin(root.gitDir, realCommon) &&
      !workspacePathWithin(canonical, realCommon)
    ) {
      throw new GitWorkspaceReadError(
        'access-denied',
        'Submodule common Git directory crosses an unauthorized symlink.'
      )
    }
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      throw error
    }
  }
  return canonical
}

export async function readWorkspaceContext(
  checkout: string,
  options: GetStatusOptions,
  rootWorktreePath?: string
): Promise<GitContextRef> {
  const checkoutPath = await realpath(resolveWorktreeFilesystemPath(checkout, options))
  try {
    await lstat(path.join(checkoutPath, '.git'))
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new GitWorkspaceReadError('unavailable', 'Checkout has not been initialized.')
    }
    throw error
  }
  const prefix = await workspaceGitRead(checkoutPath, ['rev-parse', '--show-prefix'], options)
  if (prefix !== '\n' && prefix !== '') {
    throw new GitWorkspaceReadError('access-denied', 'Checkout is not a repository root.')
  }
  const rawGitDir = (
    await workspaceGitRead(checkoutPath, ['rev-parse', '--absolute-git-dir'], options)
  ).replace(/\r?\n$/, '')
  const rawCommonDir = (
    await workspaceGitRead(checkoutPath, ['rev-parse', '--git-common-dir'], options)
  ).replace(/\r?\n$/, '')
  const mappedGitDir = resolveGitMetadataPath(checkoutPath, rawGitDir, options)
  const mappedCommonDir = resolveGitMetadataPath(checkoutPath, rawCommonDir, options)
  if (!mappedGitDir || !mappedCommonDir) {
    throw new GitWorkspaceReadError(
      'invalid-metadata',
      'Git did not report its metadata directories.'
    )
  }
  const gitDir = await realpath(mappedGitDir)
  const commonGitDir = await realpath(mappedCommonDir)
  const executionHostId = options.executionHostId ?? 'local'
  const root = rootWorktreePath ?? checkoutPath
  const rawTopLevel = (
    await workspaceGitRead(checkoutPath, ['rev-parse', '--show-toplevel'], options)
  ).replace(/\r?\n$/, '')
  const topLevel = resolveWorktreeFilesystemPath(rawTopLevel, options)
  if ((await realpath(topLevel)) !== checkoutPath) {
    throw new GitWorkspaceReadError('access-denied', 'Git metadata belongs to another checkout.')
  }
  const id = createHash('sha256')
    .update(
      JSON.stringify([
        executionHostId,
        options.wslDistro ?? null,
        root,
        checkoutPath,
        gitDir,
        commonGitDir
      ])
    )
    .digest('hex')
  return { id, executionHostId, rootWorktreePath: root, checkoutPath, gitDir, commonGitDir }
}

export async function verifyWorkspaceContext(
  context: GitContextRef,
  options: GetStatusOptions
): Promise<void> {
  const current = await readWorkspaceContext(
    context.checkoutPath,
    options,
    context.rootWorktreePath
  )
  if (current.id !== context.id) {
    throw new GitWorkspaceReadError(
      'unavailable',
      'Checkout identity changed during discovery; refresh required.'
    )
  }
}
