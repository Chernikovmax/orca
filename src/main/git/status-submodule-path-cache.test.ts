import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))
vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileAsyncBuffer: vi.fn(),
  gitStreamStdout: vi.fn(),
  gitOptionalLocksDisabledEnv: (env: NodeJS.ProcessEnv = process.env) => ({
    ...env,
    GIT_OPTIONAL_LOCKS: '0'
  })
}))

import {
  MAX_SUBMODULE_PATHS_CACHE_ENTRIES,
  clearSubmodulePathsCacheForTests,
  getSubmodulePathsCacheCountForTests,
  listSubmodulePaths
} from './status'
import { checkoutBranch } from './checkout'

const execute = promisify(execFile)
let directory = ''
type ReadOptions = { cwd?: string; env?: NodeJS.ProcessEnv }

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
  return execute('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
      GIT_CONFIG_GLOBAL: path.join(directory, 'global.config'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0'
    }
  })
}

async function writeModules(root: string, modulePath: string) {
  await writeFile(path.join(root, '.gitmodules'), `[submodule "library"]\n\tpath = ${modulePath}\n`)
}

async function metadataRoot(name: string, modulePath: string) {
  const root = path.join(directory, name)
  await mkdir(root)
  await writeModules(root, modulePath)
  return root
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'orca-submodule-path-cache-'))
  clearSubmodulePathsCacheForTests()
  gitExecFileAsyncMock.mockReset()
  gitExecFileAsyncMock.mockImplementation((args: string[], options: ReadOptions = {}) =>
    git(options.cwd ?? directory, args, options.env)
  )
})

afterEach(async () => {
  vi.useRealTimers()
  clearSubmodulePathsCacheForTests()
  await rm(directory, { recursive: true, force: true })
})

describe('submodule path cache with real filesystem metadata and Git parsing', () => {
  it('expires old metadata and prunes unrelated expired worktrees', async () => {
    const first = await metadataRoot('first', 'old-library')
    const second = await metadataRoot('second', 'other-library')
    const third = await metadataRoot('third', 'third-library')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    expect(await listSubmodulePaths(first)).toEqual(['old-library'])
    expect(await listSubmodulePaths(second)).toEqual(['other-library'])
    await writeModules(first, 'new-library')
    expect(await listSubmodulePaths(first)).toEqual(['old-library'])
    vi.setSystemTime(5_001)
    expect(await listSubmodulePaths(third)).toEqual(['third-library'])
    expect(getSubmodulePathsCacheCountForTests()).toBe(1)
    expect(await listSubmodulePaths(first)).toEqual(['new-library'])
  })

  it('bounds worktree churn and retains a recently reused entry over an older one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
    const roots: string[] = []
    for (let index = 0; index < MAX_SUBMODULE_PATHS_CACHE_ENTRIES; index++) {
      const root = await metadataRoot(`repo-${index}`, `library-${index}`)
      roots.push(root)
      await listSubmodulePaths(root)
    }
    expect(await listSubmodulePaths(roots[0])).toEqual(['library-0'])
    for (const name of ['overflow-one', 'overflow-two']) {
      const root = await metadataRoot(name, name)
      await listSubmodulePaths(root)
    }
    expect(getSubmodulePathsCacheCountForTests()).toBe(MAX_SUBMODULE_PATHS_CACHE_ENTRIES)
    await writeModules(roots[0], 'hot-entry-changed-on-disk')
    await writeModules(roots[1], 'evicted-entry-changed-on-disk')
    expect(await listSubmodulePaths(roots[0])).toEqual(['library-0'])
    expect(await listSubmodulePaths(roots[1])).toEqual(['evicted-entry-changed-on-disk'])
  }, 120_000)

  it('does not let an in-flight pre-invalidation read refill the cache', async () => {
    const root = await metadataRoot('pending', 'old-library')
    let releaseRead: (() => void) | undefined
    let enteredRead: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    const entered = new Promise<void>((resolve) => {
      enteredRead = resolve
    })
    gitExecFileAsyncMock.mockImplementationOnce(async (args: string[], options: ReadOptions) => {
      const result = await git(options.cwd ?? directory, args, options.env)
      if (!enteredRead) {
        throw new Error('Read notification gate was not initialized')
      }
      enteredRead()
      await gate
      return result
    })
    const oldRead = listSubmodulePaths(root)
    await entered
    clearSubmodulePathsCacheForTests()
    await writeModules(root, 'new-library')
    if (!releaseRead) {
      throw new Error('Read release gate was not initialized')
    }
    releaseRead()
    expect(await oldRead).toEqual(['old-library'])
    expect(getSubmodulePathsCacheCountForTests()).toBe(0)
    expect(await listSubmodulePaths(root)).toEqual(['new-library'])
  })

  it('invalidates a missing-file result when metadata becomes available', async () => {
    const root = path.join(directory, 'initially-absent')
    await mkdir(root)
    expect(await listSubmodulePaths(root)).toEqual([])
    await writeModules(root, 'newly-declared-library')
    clearSubmodulePathsCacheForTests()
    expect(await listSubmodulePaths(root)).toEqual(['newly-declared-library'])
  })

  it('keeps runtime namespace cache entries independent', async () => {
    const root = await metadataRoot('namespaced', 'first-runtime-library')
    expect(await listSubmodulePaths(root, { wslDistro: 'Ubuntu' })).toEqual([
      'first-runtime-library'
    ])
    await writeModules(root, 'second-runtime-library')
    expect(await listSubmodulePaths(root, { wslDistro: 'Debian' })).toEqual([
      'second-runtime-library'
    ])
    expect(await listSubmodulePaths(root, { wslDistro: 'Ubuntu' })).toEqual([
      'first-runtime-library'
    ])
  })

  it('reads the checked-out branch metadata instead of cached previous-branch paths', async () => {
    const root = await metadataRoot('checkout', 'main-library')
    await git(root, ['init', '-q'])
    await git(root, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    await git(root, ['add', '.gitmodules'])
    const commit = [
      '-c',
      'user.name=Cache Test',
      '-c',
      'user.email=cache@example.invalid',
      'commit',
      '-qm'
    ]
    await git(root, [...commit, 'main metadata'])
    await git(root, ['checkout', '-qb', 'feature'])
    await writeModules(root, 'feature-library')
    await git(root, ['add', '.gitmodules'])
    await git(root, [...commit, 'feature metadata'])
    await git(root, ['checkout', '-q', 'main'])
    expect(await listSubmodulePaths(root)).toEqual(['main-library'])
    await checkoutBranch(root, 'feature')
    expect((await git(root, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim()).toBe('feature')
    expect(await listSubmodulePaths(root)).toEqual(['feature-library'])
  })
})
