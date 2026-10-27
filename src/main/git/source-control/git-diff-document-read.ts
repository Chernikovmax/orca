import { createHash } from 'node:crypto'
import { lstat, open, readlink } from 'node:fs/promises'
import * as path from 'node:path'
import type {
  GitDiffSelection,
  GitDiffSide,
  GitDiffSideInfo
} from '../../../shared/git-diff-document'
import type { GitDiffResult } from '../../../shared/git-diff-compare-types'
import type { GetStatusOptions } from './get-status-options'
import { gitReadOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsyncBuffer, gitOptionalLocksDisabledEnv } from '../runner'
import { workspaceGitRead } from './git-workspace-discovery'
import { resolveWorktreeFilesystemPath } from './worktree-filesystem-path'
import { buildDiffResult } from './diff-result'
import { isBinaryBuffer } from '../../../shared/binary-buffer'
import { readWorktreeDiffStamp } from './worktree-diff-stamp'
import { PREVIEWABLE_BINARY_MIME_TYPES } from './previewable-binary-mime-types'
import { issueGitSelection } from './git-selection-patch'
import { validateDiffPath } from './git-diff-path'

export { validateDiffPath } from './git-diff-path'

const CONTENT_LIMIT = 8 * 1024 * 1024
export type DiffSideRead = {
  info: GitDiffSideInfo
  content: string
  binary: boolean
  special?: 'large' | 'encoding' | 'conflict'
}

function decodeSide(info: GitDiffSideInfo, buffer: Buffer): DiffSideRead {
  info.bytes = buffer.length
  if ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff)) {
    return { info, content: '', binary: false, special: 'encoding' }
  }
  if (isBinaryBuffer(buffer)) {
    return {
      info,
      content: PREVIEWABLE_BINARY_MIME_TYPES[path.extname(info.path).toLowerCase()]
        ? buffer.toString('base64')
        : '',
      binary: true
    }
  }
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer)
  } catch {
    return { info, content: '', binary: false, special: 'encoding' }
  }
  info.finalNewline = content.endsWith('\n')
  const crlf = content.includes('\r\n')
  const lf = /(^|[^\r])\n/.test(content)
  info.lineEndings = crlf ? (lf ? 'mixed' : 'CRLF') : lf ? 'LF' : 'none'
  return { info, content, binary: false }
}

async function readSide(
  cwd: string,
  filePath: string,
  source: GitDiffSide,
  options: GetStatusOptions
): Promise<DiffSideRead> {
  const info: GitDiffSideInfo = { source, path: filePath, exists: false }
  const empty = { info, content: '', binary: false }
  if (source.kind === 'empty') {
    return empty
  }
  if (source.kind === 'worktree') {
    const root = resolveWorktreeFilesystemPath(cwd, options)
    let target = root
    const parts = filePath.split('/')
    for (const [index, part] of parts.entries()) {
      target = path.join(target, part)
      let stat
      try {
        stat = await lstat(target)
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
          return empty
        }
        throw error
      }
      if (index < parts.length - 1) {
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error('Access denied: diff path crosses a symlink or non-directory')
        }
        continue
      }
      info.exists = true
      info.mode = stat.isSymbolicLink()
        ? '120000'
        : stat.isDirectory()
          ? '160000'
          : stat.mode & 0o111
            ? '100755'
            : '100644'
      info.bytes = stat.size
      if (stat.isSymbolicLink()) {
        return { info, content: await readlink(target), binary: false }
      }
      if (stat.isDirectory()) {
        return empty
      }
      if (!stat.isFile()) {
        throw new Error('Unsupported filesystem entry in diff')
      }
      if (stat.size > CONTENT_LIMIT) {
        return { ...empty, special: 'large' }
      }
      const handle = await open(target, 'r')
      try {
        const opened = await handle.stat()
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
          throw new Error('Diff file changed identity while opening; refresh required')
        }
        const buffer = Buffer.alloc(Math.min(stat.size + 1, CONTENT_LIMIT + 1))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
        if (bytesRead > CONTENT_LIMIT || bytesRead > stat.size) {
          return { ...empty, special: 'large' }
        }
        return decodeSide(info, buffer.subarray(0, bytesRead))
      } finally {
        await handle.close()
      }
    }
    return empty
  }
  let record: string
  if (source.kind === 'index') {
    const records = (
      await workspaceGitRead(
        cwd,
        ['ls-files', '--stage', '-z', '--', `:(literal)${filePath}`],
        options
      )
    )
      .split('\0')
      .filter(Boolean)
    record =
      records.find(
        (row) =>
          row.slice(row.indexOf('\t') + 1) === filePath &&
          row.slice(0, row.indexOf('\t')).endsWith(' 0')
      ) ?? ''
    if (!record && records.length) {
      return { ...empty, special: 'conflict' }
    }
  } else {
    const revision = source.kind === 'head' ? 'HEAD' : source.kind === 'commit' ? source.oid : ''
    if (source.kind === 'commit' && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(source.oid)) {
      throw new Error('Expected a full commit object id')
    }
    const oid = (
      await workspaceGitRead(
        cwd,
        ['rev-parse', '--verify', '--quiet', `${revision}^{commit}`],
        options,
        source.kind === 'head'
      )
    ).trim()
    if (!oid) {
      return empty
    }
    const records = (
      await workspaceGitRead(cwd, ['ls-tree', '-z', oid, '--', `:(literal)${filePath}`], options)
    ).split('\0')
    record = records.find((row) => row.slice(row.indexOf('\t') + 1) === filePath) ?? ''
  }
  if (!record) {
    return empty
  }
  const metadata = record.slice(0, record.indexOf('\t')).split(' ')
  info.mode = metadata[0]
  info.oid = source.kind === 'index' ? metadata[1] : metadata[2]
  info.exists = true
  if (info.mode === '160000') {
    return empty
  }
  const bytes = Number((await workspaceGitRead(cwd, ['cat-file', '-s', info.oid!], options)).trim())
  info.bytes = bytes
  if (!Number.isSafeInteger(bytes) || bytes > CONTENT_LIMIT) {
    return { ...empty, special: 'large' }
  }
  const { stdout } = await gitExecFileAsyncBuffer(['cat-file', 'blob', info.oid!], {
    ...gitReadOptionsForWorktree(cwd, options),
    env: { ...gitOptionalLocksDisabledEnv(), GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' },
    maxBuffer: CONTENT_LIMIT,
    timeout: 15_000
  })
  return decodeSide(info, stdout)
}

export async function readFileDiffDocument(
  cwd: string,
  filePath: string,
  selection: GitDiffSelection,
  options: GetStatusOptions
): Promise<GitDiffResult> {
  validateDiffPath(filePath)
  const oldPath = validateDiffPath(selection.oldPath ?? filePath)
  const before = await readWorktreeDiffStamp(
    cwd,
    filePath,
    selection.left.kind === 'worktree' || selection.right.kind === 'worktree',
    options
  )
  const [left, right] = await Promise.all([
    readSide(cwd, oldPath, selection.left, options),
    readSide(cwd, filePath, selection.right, options)
  ])
  const after = await readWorktreeDiffStamp(
    cwd,
    filePath,
    selection.left.kind === 'worktree' || selection.right.kind === 'worktree',
    options
  )
  const special =
    left.special ??
    right.special ??
    (left.info.mode === '160000' || right.info.mode === '160000'
      ? 'gitlink'
      : left.info.mode === '120000' || right.info.mode === '120000'
        ? 'symlink'
        : left.info.mode && right.info.mode && left.info.mode !== right.info.mode
          ? 'mode'
          : undefined)
  const result = buildDiffResult(left.content, right.content, left.binary, right.binary, filePath)
  if (result.kind === 'binary' && !right.info.exists) {
    result.modifiedDeleted = true
  }
  const documentResult: GitDiffResult = {
    ...result,
    document: {
      contextId: selection.contextId,
      left: left.info,
      right: right.info,
      special,
      generation: createHash('sha256')
        .update(JSON.stringify([before, left.info, right.info]))
        .digest('hex'),
      stale: !before || !after || before.value !== after.value
    }
  }
  await issueGitSelection(cwd, filePath, selection, documentResult, options)
  return documentResult
}
