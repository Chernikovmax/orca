import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BoundedFileReader from '../../shared/node-bounded-file-reader'
import path from 'node:path'
import {
  createBoundedFileReaderModuleMock,
  createFsPromisesModuleMock,
  createGitRunnerModuleMock
} from './status-test-harness'

const {
  gitExecFileAsyncMock,
  gitExecFileAsyncBufferMock,
  gitStreamOptionsMock,
  lstatMock,
  realpathMock,
  readFileMock,
  statMock,
  rmMock,
  existsSyncMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileAsyncBufferMock: vi.fn(),
  gitStreamOptionsMock: vi.fn(),
  lstatMock: vi.fn(),
  realpathMock: vi.fn(),
  readFileMock: vi.fn(),
  statMock: vi.fn(),
  rmMock: vi.fn(),
  existsSyncMock: vi.fn()
}))

vi.mock('./runner', () =>
  createGitRunnerModuleMock({
    gitExecFileAsyncMock,
    gitExecFileAsyncBufferMock,
    gitStreamOptionsMock
  })
)

vi.mock('fs/promises', () =>
  createFsPromisesModuleMock({ lstatMock, realpathMock, readFileMock, statMock, rmMock })
)

vi.mock('fs', () => ({
  existsSync: existsSyncMock
}))

vi.mock('../../shared/node-bounded-file-reader', async (importOriginal) =>
  createBoundedFileReaderModuleMock(await importOriginal<typeof BoundedFileReader>(), {
    readFileMock,
    statMock
  })
)

import {
  clearSubmodulePathsCacheForTests,
  listSubmodulePaths,
  resolveSubmoduleWorktreePath
} from './status'


describe('resolveSubmoduleWorktreePath', () => {
  it('resolves a relative submodule path inside the worktree', () => {
    expect(resolveSubmoduleWorktreePath('/repo', 'flutter_mine')).toBe(
      path.resolve('/repo', 'flutter_mine')
    )
  })

  it('rejects absolute and escaping submodule paths', () => {
    expect(() => resolveSubmoduleWorktreePath('/repo', path.resolve('/etc'))).toThrow(
      'Access denied'
    )
    expect(() => resolveSubmoduleWorktreePath('/repo', '../outside')).toThrow('Access denied')
  })
})

describe('listSubmodulePaths', () => {
  beforeEach(() => {
    clearSubmodulePathsCacheForTests()
    gitExecFileAsyncMock.mockReset()
  })

  it('keeps cached .gitmodules paths separate per WSL distro', async () => {
    gitExecFileAsyncMock.mockImplementation((_args: string[], options?: { wslDistro?: string }) =>
      Promise.resolve({
        stdout:
          options?.wslDistro === 'debian'
            ? 'submodule.lib.path debian-lib\n'
            : 'submodule.lib.path ubuntu-lib\n'
      })
    )

    await expect(listSubmodulePaths('/repo', { wslDistro: 'ubuntu' })).resolves.toEqual([
      'ubuntu-lib'
    ])
    await expect(listSubmodulePaths('/repo', { wslDistro: 'debian' })).resolves.toEqual([
      'debian-lib'
    ])

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })
})
