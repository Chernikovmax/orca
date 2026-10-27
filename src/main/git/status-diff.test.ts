import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from './runner'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))
vi.mock('./runner', async (importOriginal) => ({
  ...await importOriginal<typeof GitRunner>(),
  gitExecFileAsync: gitExecFileAsyncMock
}))
import { getStagedCommitContext } from './status'

describe('getStagedCommitContext', () => {
  beforeEach(() => gitExecFileAsyncMock.mockReset())

  it('preserves staged context without prompt truncation at the Git boundary', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature/ai\n' })
      .mockResolvedValueOnce({ stdout: 'M\tREADME.md\n' })
      .mockResolvedValueOnce({ stdout: 'diff --git a/README.md b/README.md\n+hello\n' })
    expect(await getStagedCommitContext('/repo')).toEqual({
      branch: 'feature/ai', stagedSummary: 'M\tREADME.md', stagedPatch: 'diff --git a/README.md b/README.md\n+hello\n'
    })
  })

  it('falls back to file summary only for a staged patch output overflow', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature/ai\n' })
      .mockResolvedValueOnce({ stdout: 'A\thuge.jsonl\n' })
      .mockRejectedValueOnce(Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ENOBUFS' }))
    expect(await getStagedCommitContext('/repo')).toEqual({
      branch: 'feature/ai', stagedSummary: 'A\thuge.jsonl', stagedPatch: ''
    })
  })

  it('does not hide non-overflow Git failures', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature/ai\n' })
      .mockResolvedValueOnce({ stdout: 'M\tREADME.md\n' })
      .mockRejectedValueOnce(new Error('fatal: bad revision'))
    await expect(getStagedCommitContext('/repo')).rejects.toThrow('fatal: bad revision')
  })
})
