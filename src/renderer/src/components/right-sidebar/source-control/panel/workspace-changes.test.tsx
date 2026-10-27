// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitMutationReceipt } from '../../../../../../shared/git-workspace-mutation'
import type { RepositoryState } from '../../../../../../shared/git-workspace-types'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  openDiff: vi.fn(),
  setState: vi.fn()
}))

vi.mock('@/runtime/runtime-git-working-tree-client', () => ({
  mutateRuntimeGitWorkspace: mocks.mutate
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ openDiff: mocks.openDiff }),
    setState: (update: unknown) => mocks.setState(update)
  }
}))
vi.mock('@/lib/language-detect', () => ({ detectLanguage: () => 'typescript' }))

import { SourceControlWorkspaceChanges } from './workspace-changes'

const CHILD_OID = 'a'.repeat(40)

function receipt(overrides: Partial<GitMutationReceipt> = {}): GitMutationReceipt {
  return { action: 'stage', outcome: 'succeeded', contextId: 'ctx-1', expectedState: 'state-2', ...overrides }
}

function repository(): RepositoryState {
  return {
    context: {
      id: 'ctx-1',
      executionHostId: 'local',
      rootWorktreePath: '/repo',
      checkoutPath: '/repo',
      gitDir: '/repo/.git',
      commonGitDir: '/repo/.git'
    },
    head: 'head-1',
    branch: 'main',
    unborn: false,
    detached: false,
    conflictOperation: 'unknown',
    dirty: true,
    conflicted: false,
    incomplete: false,
    expectedState: 'state-1',
    entries: [
      { path: 'a.txt', status: 'modified', area: 'unstaged' },
      { path: 'b.txt', status: 'modified', area: 'staged' },
      { path: 'sub', status: 'modified', area: 'unstaged' },
      { path: 'new.txt', status: 'added', area: 'untracked' }
    ]
  }
}

const context: RuntimeGitContext = {
  target: { kind: 'local' },
  worktreeId: 'wt-1',
  worktreePath: '/repo'
}

function byPath(testId: string, filePath: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"][data-path="${filePath}"]`)
}

function entryNamed(text: string): HTMLElement {
  const entry = [...document.querySelectorAll<HTMLElement>('[data-testid="source-control-entry"]')].find(
    (candidate) => candidate.textContent?.includes(text)
  )
  if (!entry) {
    throw new Error(`no change row for ${text}`)
  }
  return entry
}

function renderChanges(showCommit = false): void {
  render(
    <SourceControlWorkspaceChanges
      repository={repository()}
      context={context}
      label="Root"
      refreshGeneration={{}}
      submodules={[
        {
          path: 'sub',
          name: 'sub',
          parentContextId: 'ctx-1',
          contextId: 'child-ctx',
          declaredUrls: [],
          indexConflictOids: [],
          headOid: CHILD_OID,
          indexOid: 'b'.repeat(40),
          currentOid: CHILD_OID,
          commitChanged: true,
          stagedGitlinkChanged: false,
          dirty: true,
          conflicted: false,
          availability: 'initialized',
          descendants: 'complete',
          metadataIssues: []
        }
      ]}
      showCommit={showCommit}
      onRefresh={() => {}}
    />
  )
}

beforeEach(() => {
  mocks.mutate.mockReset()
  mocks.mutate.mockResolvedValue(receipt())
  mocks.openDiff.mockReset()
  mocks.setState.mockReset()
})

afterEach(() => {
  cleanup()
})

describe('SourceControlWorkspaceChanges', () => {
  it('opens a diff with the host-issued context selection', () => {
    renderChanges()
    fireEvent.click(entryNamed('a.txt'))
    expect(mocks.openDiff).toHaveBeenCalledWith(
      'wt-1',
      '/repo/a.txt',
      'a.txt',
      'typescript',
      false,
      expect.objectContaining({
        gitDiffRootPath: '/repo',
        gitDiffSelection: {
          contextId: 'ctx-1',
          oldPath: undefined,
          left: { kind: 'index' },
          right: { kind: 'worktree' }
        }
      })
    )
  })

  it('stages a file through the host mutation contract', async () => {
    renderChanges()
    await act(async () => {
      fireEvent.click(byPath('stage-entry', 'a.txt')!)
    })
    expect(mocks.mutate).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        action: 'stage',
        contextId: 'ctx-1',
        expectedState: 'state-1',
        filePath: 'a.txt'
      })
    )
    expect(screen.getByTestId('git-mutation-notice').textContent).toContain('Stage completed')
  })

  it('previews a discard and confirms it with the host token', async () => {
    mocks.mutate.mockResolvedValueOnce(
      receipt({
        action: 'previewDiscard',
        preview: {
          contextId: 'ctx-1',
          expectedState: 'state-1',
          filePath: 'a.txt',
          previewId: 'preview-1',
          tracked: true,
          exists: true,
          recoveryAvailable: true,
          warning: 'kept copy'
        }
      })
    )
    renderChanges()
    await act(async () => {
      fireEvent.click(byPath('discard-entry', 'a.txt')!)
    })
    expect(mocks.mutate).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ action: 'previewDiscard', filePath: 'a.txt' })
    )
    expect(screen.getByTestId('git-discard-preview').textContent).toContain('Discard a.txt?')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm discard' }))
    })
    expect(mocks.mutate).toHaveBeenLastCalledWith(
      context,
      expect.objectContaining({
        action: 'discard',
        filePath: 'a.txt',
        previewId: 'preview-1'
      })
    )
  })

  it('stages the reviewed child commit and never a child file', async () => {
    renderChanges()
    await act(async () => {
      fireEvent.click(byPath('stage-gitlink', 'sub')!)
    })
    expect(mocks.mutate).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        action: 'stageGitlink',
        filePath: 'sub',
        childOid: CHILD_OID
      })
    )
    expect(mocks.mutate).not.toHaveBeenCalledWith(
      context,
      expect.objectContaining({ action: 'stage', filePath: 'sub' })
    )
  })

  it('previews and commits with the per-context draft and expected state', async () => {
    mocks.mutate.mockResolvedValue(
      receipt({
        action: 'previewCommit',
        preview: {
          contextId: 'ctx-1',
          expectedState: 'state-1',
          branch: 'main',
          unborn: false,
          detached: false,
          staged: [{ path: 'b.txt', status: 'modified' }],
          stagedFiles: 1,
          truncated: false,
          preservesHooks: true
        }
      })
    )
    renderChanges(true)
    fireEvent.change(screen.getByTestId('git-context-commit-message'), {
      target: { value: 'feat: scoped commit' }
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Preview staged set' }))
    })
    expect(screen.getByTestId('git-commit-preview').textContent).toContain('Branch main')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Commit$/ }))
    })
    expect(mocks.mutate).toHaveBeenLastCalledWith(
      context,
      expect.objectContaining({
        action: 'commit',
        expectedState: 'state-2',
        message: 'feat: scoped commit'
      })
    )
  })
})
