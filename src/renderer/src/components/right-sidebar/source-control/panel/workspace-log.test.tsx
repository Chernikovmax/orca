// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { GitHistoryResult } from '../../../../../../shared/git-history'
import type { RepositoryState } from '../../../../../../shared/git-workspace-types'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'

const mocks = vi.hoisted(() => ({
  history: vi.fn(),
  compare: vi.fn(),
  openCommitDiff: vi.fn(),
  openCommitAllDiffs: vi.fn()
}))

vi.mock('@/runtime/runtime-git-status-client', () => ({
  getRuntimeGitHistory: mocks.history
}))
vi.mock('@/runtime/runtime-git-diff-client', () => ({
  getRuntimeGitCommitCompare: mocks.compare
}))
vi.mock('@/lib/language-detect', () => ({ detectLanguage: () => 'text' }))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))
vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (state: Record<string, unknown>) => T): T =>
    selector({ openCommitDiff: mocks.openCommitDiff, openCommitAllDiffs: mocks.openCommitAllDiffs })
}))

import { SourceControlWorkspaceLog } from './workspace-log'
import { deferred } from '../../source-control-hook-test-harness'

const PARENT_ONE = '1'.repeat(40)
const PARENT_TWO = '2'.repeat(40)
const MERGE = '3'.repeat(40)


function historyResult(overrides: Partial<GitHistoryResult> = {}): GitHistoryResult {
  return {
    items: [
      {
        id: MERGE,
        parentIds: [PARENT_ONE, PARENT_TWO],
        subject: 'merge commit',
        message: 'merge commit\n\nbody',
        author: 'Tester',
        timestamp: 1_700_000_000_000
      }
    ],
    currentRef: { id: 'refs/heads/main', name: 'main', revision: MERGE, category: 'branches' },
    hasIncomingChanges: false,
    hasOutgoingChanges: false,
    hasMore: false,
    limit: 50,
    generation: 'gen-1',
    tipOid: MERGE,
    empty: false,
    ...overrides
  }
}

function compareResult(baseOid: string | null) {
  return {
    summary: {
      commitOid: MERGE,
      parentOid: baseOid,
      compareRef: MERGE.slice(0, 7),
      baseRef: baseOid ? baseOid.slice(0, 7) : 'empty tree',
      changedFiles: 1,
      status: 'ready' as const
    },
    entries: [{ path: 'file.txt', status: 'modified' as const }]
  }
}

function repository(head = MERGE): RepositoryState {
  return {
    context: {
      id: 'ctx-1',
      executionHostId: 'local',
      rootWorktreePath: '/repo',
      checkoutPath: '/repo/sub',
      gitDir: '/repo/sub/.git',
      commonGitDir: '/repo/.git'
    },
    head,
    branch: 'main',
    unborn: false,
    detached: false,
    conflictOperation: 'unknown',
    dirty: false,
    conflicted: false,
    incomplete: false,
    expectedState: 'state-1',
    entries: [],
    refs: [{ name: 'refs/heads/main', oid: head }]
  }
}

const context: RuntimeGitContext = {
  target: { kind: 'local' },
  worktreeId: 'wt-1',
  worktreePath: '/repo'
}

function renderLog(current: RepositoryState) {
  return render(
    <SourceControlWorkspaceLog
      repository={current}
      context={context}
      label="one"
      isRoot={false}
    />
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.history.mockResolvedValue(historyResult())
  mocks.compare.mockImplementation(async (_context, _oid, options: { baseOid?: string | null }) =>
    compareResult(options.baseOid ?? null)
  )
})

afterEach(() => {
  cleanup()
})

describe('workspace Log', () => {
  it('loads a pinned page, selects a merge parent explicitly and opens the existing commit diff', async () => {
    renderLog(repository())
    await screen.findByTestId('git-history-row')
    expect(mocks.history).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ contextId: 'ctx-1', limit: 50 })
    )
    await waitFor(() =>
      expect(mocks.compare).toHaveBeenCalledWith(context, MERGE, {
        contextId: 'ctx-1',
        baseOid: PARENT_ONE
      })
    )
    const parentTwo = await screen.findByRole('button', { name: /Parent 2/ })
    parentTwo.click()
    await waitFor(() =>
      expect(mocks.compare).toHaveBeenCalledWith(context, MERGE, {
        contextId: 'ctx-1',
        baseOid: PARENT_TWO
      })
    )
    const file = await screen.findByTestId('git-log-file')
    file.click()
    expect(mocks.openCommitDiff).toHaveBeenCalledWith(
      'wt-1',
      '/repo/sub',
      expect.objectContaining({ path: 'file.txt' }),
      expect.objectContaining({ commitOid: MERGE, parentOid: PARENT_TWO }),
      'text',
      expect.objectContaining({
        gitDiffRootPath: '/repo/sub',
        gitDiffSelection: {
          contextId: 'ctx-1',
          left: { kind: 'commit', oid: PARENT_TWO },
          right: { kind: 'commit', oid: MERGE }
        }
      })
    )
  })

  it('moves the selected commit with the keyboard', async () => {
    mocks.history.mockResolvedValueOnce(
      historyResult({
        items: [
          {
            id: MERGE,
            parentIds: [PARENT_ONE],
            subject: 'newest commit',
            message: 'newest commit'
          },
          {
            id: PARENT_ONE,
            parentIds: [],
            subject: 'older commit',
            message: 'older commit'
          }
        ]
      })
    )
    renderLog(repository())
    const rows = await screen.findAllByTestId('git-history-row')
    expect(rows[0]?.getAttribute('aria-current')).toBe('true')
    fireEvent.keyDown(screen.getByRole('group', { name: 'Commit history' }), {
      key: 'ArrowDown'
    })
    await waitFor(() => expect(rows[1]?.getAttribute('aria-current')).toBe('true'))
    expect(rows[0]?.getAttribute('aria-current')).toBeNull()
  })

  it('drops a late first-page response after the refs signature changed', async () => {
    const first = deferred<GitHistoryResult>()
    const second = deferred<GitHistoryResult>()
    mocks.history.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { rerender } = renderLog(repository())
    rerender(
      <SourceControlWorkspaceLog
        repository={repository(PARENT_ONE)}
        context={context}
        label="one"
        isRoot={false}
      />
    )
    second.resolve(
      historyResult({
        items: [{ id: PARENT_ONE, parentIds: [], subject: 'newest commit', message: 'newest commit' }],
        generation: 'gen-2',
        tipOid: PARENT_ONE
      })
    )
    await screen.findAllByText('newest commit')
    first.resolve(historyResult({ generation: 'gen-1' }))
    await waitFor(() => expect(mocks.history).toHaveBeenCalledTimes(2))
    expect(screen.queryAllByText('merge commit')).toHaveLength(0)
    expect(screen.getAllByText('newest commit').length).toBeGreaterThan(0)
  })

  it('pins the next page to the loaded cursor and refuses to append another generation', async () => {
    const pageOne = historyResult({
      hasMore: true,
      nextCursor: { tipOid: MERGE, offset: 1 }
    })
    mocks.history.mockResolvedValueOnce(pageOne)
    renderLog(repository())
    await screen.findByTestId('git-history-row')
    const nextPage = deferred<GitHistoryResult>()
    mocks.history.mockReturnValueOnce(nextPage.promise)
    screen.getByRole('button', { name: 'Load more commits' }).click()
    await waitFor(() =>
      expect(mocks.history).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ cursor: { tipOid: MERGE, offset: 1 } })
      )
    )
    nextPage.resolve(
      historyResult({
        items: [{ id: PARENT_ONE, parentIds: [], subject: 'fresh refs commit', message: 'fresh refs commit' }],
        generation: 'gen-2',
        tipOid: PARENT_ONE
      })
    )
    await waitFor(() =>
      expect(
        screen.getByText(/Refs changed since this history was loaded/)
      ).toBeTruthy()
    )
    expect(screen.queryAllByText('fresh refs commit')).toHaveLength(0)
    expect(mocks.history).toHaveBeenCalledTimes(3)
  })
})
