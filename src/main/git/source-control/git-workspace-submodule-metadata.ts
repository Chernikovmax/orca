import { lstat } from 'node:fs/promises'
import * as path from 'node:path'
import type { GetStatusOptions } from './get-status-options'
import { GitMutationError, isUnknownOutcome } from './git-workspace-mutation-error'
import { gitExecFileAsync } from '../runner'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { validateDiffPath } from './git-diff-path'
import { stripCredentialsFromMessage } from '../../../shared/git-remote-error'
import { FULL_OID } from './git-workspace-mutation-shared'

export const SUBMODULE_NETWORK_ENV = { GIT_ALLOW_PROTOCOL: 'file:ssh:https:http:git' }

export function redactUrl(value: string): string {
  try {
    const parsed = new URL(value)
    if (parsed.username || parsed.password) {
      parsed.username = '***'
      parsed.password = '***'
    }
    for (const key of parsed.searchParams.keys()) {
      parsed.searchParams.set(key, '***')
    }
    return parsed.toString()
  } catch {
    return value
      .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1***:***@')
      .replace(/\b([^/\s:@]+):[^@\s/]+@(?=[^/\s]+:)/g, '$1:***@')
  }
}

export async function runSubmoduleGit(
  args: string[],
  options: Parameters<typeof gitExecFileAsync>[1]
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await gitExecFileAsync(args, options)
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string'
        ? error.stderr.trim()
        : ''
    const raw = stderr || (error instanceof Error ? error.message : String(error))
    const safe = stripCredentialsFromMessage(raw)
      .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, redactUrl)
      .replace(/\b([^/\s:@]+):[^@\s/]+@(?=[^/\s]+:)/g, '$1:***@')
    const unknownOutcome = isUnknownOutcome(error, options?.signal)
    throw new GitMutationError(unknownOutcome ? 'unknown-outcome' : 'git-error', safe, {
      unknownOutcome
    })
  }
}

export function validateSubmoduleUrl(value: string): string {
  if (!value || value.length > 4096 || /[\0\r\n]/.test(value) || value.startsWith('-')) {
    throw new GitMutationError('invalid', 'Submodule URL is invalid')
  }
  if (
    value.startsWith('./') ||
    value.startsWith('../') ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    (!/^[a-z][a-z0-9+.-]*:/i.test(value) && /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:.+/.test(value))
  ) {
    return value
  }
  try {
    const parsed = new URL(value)
    if (
      !value.includes('://') ||
      !['https:', 'http:', 'ssh:', 'git:', 'file:'].includes(parsed.protocol)
    ) {
      throw new Error('unsupported protocol')
    }
    return value
  } catch {
    throw new GitMutationError(
      'invalid',
      'Submodule URL must use a supported Git transport or repository path'
    )
  }
}

export async function defaultRemote(
  cwd: string,
  options: GetStatusOptions
): Promise<string | undefined> {
  try {
    const { stdout } = await gitExecFileAsync(['remote'], gitOptionsForWorktree(cwd, options))
    const remotes = stdout.trim().split(/\r?\n/).filter(Boolean)
    if (!remotes.length) {
      return undefined
    }
    const branch = await gitExecFileAsync(
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      gitOptionsForWorktree(cwd, options)
    )
      .then((result) => result.stdout.trim())
      .catch(() => '')
    const configured = branch
      ? await gitExecFileAsync(
          ['config', '--get', `branch.${branch}.remote`],
          gitOptionsForWorktree(cwd, options)
        )
          .then((result) => result.stdout.trim())
          .catch(() => '')
      : ''
    const remote =
      configured && configured !== '.' && remotes.includes(configured)
        ? configured
        : remotes.includes('origin')
          ? 'origin'
          : remotes[0]
    return remote
  } catch {
    return undefined
  }
}

export async function remoteUrl(
  cwd: string,
  options: GetStatusOptions
): Promise<string | undefined> {
  const remote = await defaultRemote(cwd, options)
  if (!remote) {
    return undefined
  }
  return (
    await gitExecFileAsync(['remote', 'get-url', remote], gitOptionsForWorktree(cwd, options))
  ).stdout.trim()
}
export async function remoteTrackingCommit(
  checkoutPath: string,
  selection: string,
  options: GetStatusOptions
): Promise<string> {
  const gitOptions = {
    ...gitOptionsForWorktree(checkoutPath, options),
    env: { GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' }
  }
  if (/^refs\/remotes\/[A-Za-z0-9._/-]+$/.test(selection)) {
    await runSubmoduleGit(['check-ref-format', selection], gitOptions)
    const target = (
      await runSubmoduleGit(['rev-parse', '--verify', `${selection}^{commit}`], gitOptions)
    ).stdout.trim()
    if (!FULL_OID.test(target)) {
      throw new GitMutationError('invalid', 'Remote-tracking revision did not resolve to a commit')
    }
    return target
  }
  if (FULL_OID.test(selection)) {
    const refs = (
      await runSubmoduleGit(['for-each-ref', '--format=%(objectname)', 'refs/remotes/'], gitOptions)
    ).stdout
      .trim()
      .split(/\r?\n/)
    if (refs.includes(selection)) {
      return selection
    }
  }
  throw new GitMutationError(
    'invalid',
    'Choose an available remote-tracking ref or its current commit OID'
  )
}

export async function declaration(cwd: string, filePath: string, options: GetStatusOptions) {
  const { stdout } = await gitExecFileAsync(
    ['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.(path|url)$'],
    gitOptionsForWorktree(cwd, options)
  ).catch(() => ({ stdout: '' }))
  const entries = new Map<string, { path?: string; url?: string }>()
  for (const row of stdout.split(/\r?\n/)) {
    const match = row.match(/^submodule\.(.*)\.(path|url)\s+(.+)$/)
    if (!match) {
      continue
    }
    const [, name, field, value] = match
    const current = entries.get(name) ?? {}
    if (field === 'path') {
      current.path = value
    } else {
      current.url = value
    }
    entries.set(name, current)
  }
  for (const [name, value] of entries) {
    if (value.path === filePath) {
      return { name, ...value }
    }
  }
  return undefined
}

export async function localSubmoduleUrl(
  cwd: string,
  name: string | undefined,
  options: GetStatusOptions
): Promise<string | undefined> {
  if (!name) {
    return undefined
  }
  try {
    return (
      await gitExecFileAsync(
        ['config', '--get', `submodule.${name}.url`],
        gitOptionsForWorktree(cwd, options)
      )
    ).stdout.trim()
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 1) {
      return undefined
    }
    throw error
  }
}

export async function assertSafeSubmodulePath(
  root: string,
  filePath: string,
  mode: 'required' | 'absent' | 'optional'
): Promise<void> {
  let current = root
  const parts = validateDiffPath(filePath).split('/')
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index])
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) {
        throw new GitMutationError(
          'access-denied',
          'Submodule path crosses a symlink or non-directory'
        )
      }
      if (index === parts.length - 1) {
        if (mode === 'absent') {
          throw new GitMutationError('invalid', 'Submodule destination already exists')
        }
        if (!info.isDirectory()) {
          throw new GitMutationError('invalid', 'Submodule destination is not a directory')
        }
      }
    } catch (error) {
      if (error instanceof GitMutationError) {
        throw error
      }
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        if (mode === 'required') {
          throw new GitMutationError('incomplete', 'Submodule checkout is not initialized')
        }
        return
      }
      throw new GitMutationError('access-denied', 'Submodule path could not be verified safely')
    }
  }
}

export async function assertSafeGitmodules(root: string, required: boolean): Promise<void> {
  try {
    const info = await lstat(path.join(root, '.gitmodules'))
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new GitMutationError('access-denied', '.gitmodules must be a regular file')
    }
  } catch (error) {
    if (error instanceof GitMutationError) {
      throw error
    }
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT' &&
      !required
    ) {
      return
    }
    throw new GitMutationError('access-denied', '.gitmodules could not be verified safely')
  }
}
