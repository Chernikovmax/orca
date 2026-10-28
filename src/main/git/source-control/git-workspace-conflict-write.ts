import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, symlink, unlink } from 'node:fs/promises'
import * as path from 'node:path'
import type {
  GitMutationReceipt,
  GitWorkspaceMutationRequest
} from '../../../shared/git-workspace-mutation'
import type { GetStatusOptions } from './get-status-options'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync } from '../runner'
import { readContentFenceEntry } from './git-content-fence'
import { verifyWorkspaceContext } from './git-workspace-context'
import { workspaceGitRead } from './git-workspace-discovery'
import { GitMutationError } from './git-workspace-mutation-error'
import { FULL_OID, submoduleForPath, type ResolvedWorkspace } from './git-workspace-mutation-shared'
import { CONFLICT_CONTENT_LIMIT } from './git-workspace-conflict-content'
import { readGitBlobBytes } from './git-blob-read'
import { readConflictImpl } from './git-workspace-conflict-read'
import {
  assertConflictFresh,
  conflictFence,
  forgetConflict,
  getConflict,
  type IssuedConflict
} from './git-workspace-conflict-state'

async function writeConflictBytes(
  value: IssuedConflict,
  bytes: Buffer,
  mode: string,
  options: GetStatusOptions
): Promise<void> {
  const cwd = value.context.checkoutPath
  const filePath = value.document.filePath
  const target = path.join(cwd, filePath)
  await assertConflictFresh(value, options)
  const entry = await readContentFenceEntry(cwd, filePath, options)
  if (entry.kind === 'gitlink') {
    throw new GitMutationError('unsupported', 'Cannot replace a directory with a conflict file')
  }
  if (mode === '120000') {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (entry.kind !== 'absent') {
      await unlink(target)
    }
    await symlink(content, target)
    return
  }
  if (mode !== '100644' && mode !== '100755') {
    throw new GitMutationError('unsupported', 'Unsupported conflict file mode')
  }
  if (entry.kind === 'symlink') {
    await unlink(target)
  }
  if (entry.kind === 'absent') {
    await mkdir(path.dirname(target), { recursive: true })
    await readContentFenceEntry(cwd, filePath, options)
  }
  const handle = await open(
    target,
    constants.O_WRONLY |
      constants.O_NOFOLLOW |
      (entry.kind === 'file' ? 0 : constants.O_CREAT | constants.O_EXCL),
    mode === '100755' ? 0o755 : 0o644
  )
  try {
    const opened = await handle.stat()
    const current = await lstat(target)
    if (
      !opened.isFile() ||
      current.isSymbolicLink() ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino
    ) {
      throw new GitMutationError('stale', 'Conflict result changed identity before writing')
    }
    if (opened.nlink > 1) {
      throw new GitMutationError(
        'access-denied',
        'Conflict result has multiple hard links; replace the link and reload before saving'
      )
    }
    if (entry.kind === 'file') {
      await assertConflictFresh(value, options)
    }
    await handle.truncate(0)
    await handle.writeFile(bytes)
    await handle.chmod(mode === '100755' ? 0o755 : 0o644)
  } finally {
    await handle.close()
  }
}

export async function saveConflictImpl(
  workspace: ResolvedWorkspace,
  request: GitWorkspaceMutationRequest,
  options: GetStatusOptions
): Promise<GitMutationReceipt> {
  const value = getConflict(request.documentId, workspace.context)
  if (
    !value.document.editable ||
    typeof request.content !== 'string' ||
    Buffer.byteLength(request.content, 'utf8') > CONFLICT_CONTENT_LIMIT ||
    Buffer.from(request.content).toString('utf8') !== request.content
  ) {
    throw new GitMutationError('invalid', 'Save requires a bounded, editable UTF-8 conflict result')
  }
  const entry = await readContentFenceEntry(
    workspace.context.checkoutPath,
    value.document.filePath,
    options
  )
  const mode = entry.kind === 'file' ? entry.mode : '100644'
  await writeConflictBytes(value, Buffer.from(request.content, 'utf8'), mode, options)
  forgetConflict(value.document.documentId)
  return {
    action: request.action,
    outcome: 'succeeded',
    conflict: await readConflictImpl(
      workspace,
      {
        action: 'readConflict',
        contextId: workspace.context.id,
        filePath: value.document.filePath
      },
      options
    )
  }
}

export async function resolveConflictImpl(
  workspace: ResolvedWorkspace,
  request: GitWorkspaceMutationRequest,
  options: GetStatusOptions
): Promise<GitMutationReceipt> {
  const value = getConflict(request.documentId, workspace.context)
  const { document } = value
  const cwd = workspace.context.checkoutPath
  const filePath = document.filePath
  const gitOptions = {
    ...gitOptionsForWorktree(cwd, options),
    admissionTier: 'interactive' as const,
    env: { GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' }
  }
  let oid: string | undefined
  let mode: string | undefined
  let bytes: Buffer | undefined
  let deleting = request.resolution === 'delete'
  if (request.resolution === 'ours' || request.resolution === 'theirs') {
    const side = document[request.resolution]
    oid = side.oid
    mode = side.mode
    deleting = side.content.kind === 'absent'
    if (oid && mode !== '160000') {
      bytes = await readGitBlobBytes(cwd, oid, options, CONFLICT_CONTENT_LIMIT)
    }
  } else if (request.resolution === 'gitlink') {
    if (document.kind !== 'gitlink' || !FULL_OID.test(request.childOid ?? '')) {
      throw new GitMutationError('invalid', 'Gitlink resolution requires a full child commit id')
    }
    oid = request.childOid
    mode = '160000'
    if (
      ![document.ours, document.theirs].some((side) => side.mode === '160000' && side.oid === oid)
    ) {
      const entry = submoduleForPath(workspace.workspace, workspace.context, filePath)
      const child = workspace.workspace.repositories.find(
        (item) => item.context.id === entry?.contextId
      )
      if (!child) {
        throw new GitMutationError(
          'access-denied',
          'Resulting child commit requires an authorized local child checkout'
        )
      }
      await verifyWorkspaceContext(child.context, options)
      const verified = (
        await workspaceGitRead(
          child.context.checkoutPath,
          ['rev-parse', '--verify', `${oid}^{commit}`],
          options
        )
      ).trim()
      if (verified !== oid) {
        throw new GitMutationError('invalid', 'Resulting child commit is unavailable locally')
      }
    }
  } else if (request.resolution === 'result') {
    if (!document.editable) {
      throw new GitMutationError(
        'unsupported',
        'Choose an explicit side, deletion or gitlink for this conflict'
      )
    }
    const entry = await readContentFenceEntry(cwd, filePath, options)
    if (entry.kind !== 'file' || !entry.digest) {
      throw new GitMutationError('unsupported', 'Result must be a bounded regular file')
    }
    mode = entry.mode
  } else if (!deleting) {
    throw new GitMutationError('invalid', 'Choose an explicit conflict resolution')
  }
  await assertConflictFresh(value, options)
  if (deleting) {
    const entry = await readContentFenceEntry(cwd, filePath, options)
    if (entry.kind === 'file' || entry.kind === 'symlink') {
      await unlink(path.join(cwd, filePath))
    }
    const remaining = await readContentFenceEntry(cwd, filePath, options)
    if (
      (entry.kind === 'gitlink' ? remaining.kind !== 'gitlink' : remaining.kind !== 'absent') ||
      value.fence.index !== (await conflictFence(value.context, filePath, options)).index
    ) {
      throw new GitMutationError('stale', 'Conflict index changed before recording deletion')
    }
    await gitExecFileAsync(['update-index', '--force-remove', '--', filePath], gitOptions)
  } else {
    const originalEntry = await readContentFenceEntry(cwd, filePath, options)
    if (bytes && mode) {
      await writeConflictBytes(value, bytes, mode, options)
    }
    if (!oid) {
      const hashed = await gitExecFileAsync(
        ['hash-object', '-w', `--path=${filePath}`, '--', filePath],
        gitOptions
      )
      oid = hashed.stdout.trim()
    }
    if (!oid || !FULL_OID.test(oid) || !mode) {
      throw new GitMutationError('invalid', 'Invalid resolved index entry')
    }
    const currentEntry = await readContentFenceEntry(cwd, filePath, options)
    const expectedEntry = bytes
      ? mode === '120000'
        ? { kind: 'symlink', target: bytes.toString('utf8') }
        : {
            kind: 'file',
            mode,
            size: bytes.length,
            digest: createHash('sha256').update(bytes).digest('hex')
          }
      : originalEntry
    if (
      JSON.stringify(currentEntry) !== JSON.stringify(expectedEntry) ||
      value.fence.index !== (await conflictFence(value.context, filePath, options)).index
    ) {
      throw new GitMutationError(
        'stale',
        'Conflict changed before recording its resolution; reopen it'
      )
    }
    await gitExecFileAsync(
      ['update-index', '--add', '--cacheinfo', `${mode},${oid},${filePath}`],
      gitOptions
    )
  }
  const records = (
    await workspaceGitRead(
      cwd,
      ['ls-files', '--stage', '-z', '--', `:(literal)${filePath}`],
      options
    )
  )
    .split('\0')
    .filter(Boolean)
  if (
    deleting
      ? records.length !== 0
      : records.length !== 1 || records[0] !== `${mode} ${oid} 0\t${filePath}`
  ) {
    throw new GitMutationError('git-error', 'Git did not record the explicit conflict resolution')
  }
  forgetConflict(document.documentId)
  return { action: request.action, outcome: 'succeeded' }
}
