import { describe, expect, it } from 'vitest'
import type { GitHistoryResult } from '../../../../../../shared/git-history'
import {
  appendWorkspaceHistoryPage,
  EMPTY_WORKSPACE_HISTORY,
  startWorkspaceHistory
} from './workspace-log-model'

function result(overrides: Partial<GitHistoryResult> = {}): GitHistoryResult {
  return {
    items: [],
    hasIncomingChanges: false,
    hasOutgoingChanges: false,
    hasMore: false,
    limit: 2,
    generation: 'gen-1',
    tipOid: 'a'.repeat(40),
    empty: false,
    ...overrides
  }
}

function item(id: string) {
  return { id, parentIds: [], subject: id, message: id }
}

describe('workspace history pages', () => {
  it('start replaces the list and pins the tip and cursor', () => {
    const state = startWorkspaceHistory(
      result({
        items: [item('a'), item('b')],
        hasMore: true,
        nextCursor: { tipOid: 'a'.repeat(40), offset: 2 }
      })
    )
    expect(state.items.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(state.generation).toBe('gen-1')
    expect(state.cursor).toEqual({ tipOid: 'a'.repeat(40), offset: 2 })
    expect(state.hasMore).toBe(true)
    expect(state.empty).toBe(false)
  })

  it('appends only a page of the same generation and pinned tip, without duplicate commits', () => {
    const first = startWorkspaceHistory(result({ items: [item('a'), item('b')] }))
    const appended = appendWorkspaceHistoryPage(
      { ...first, hasMore: true, cursor: { tipOid: first.tipOid, offset: 2 } },
      result({
        items: [item('b'), item('c')],
        hasMore: true,
        nextCursor: { tipOid: first.tipOid, offset: 3 }
      })
    )
    expect(appended.outcome).toBe('appended')
    expect(appended.state.items.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
    expect(appended.state.cursor?.offset).toBe(3)
  })

  it('refuses a page from another generation or another pinned tip', () => {
    const first = startWorkspaceHistory(result({ items: [item('a')] }))
    const otherGeneration = appendWorkspaceHistoryPage(
      first,
      result({ items: [item('b')], generation: 'gen-2' })
    )
    expect(otherGeneration.outcome).toBe('restart')
    expect(otherGeneration.state).toBe(first)

    const otherTip = appendWorkspaceHistoryPage(
      first,
      result({ items: [item('c')], tipOid: 'b'.repeat(40) })
    )
    expect(otherTip.outcome).toBe('restart')
    expect(otherTip.state).toBe(first)
  })

  it('ignores a continuation when no first page was pinned', () => {
    const applied = appendWorkspaceHistoryPage(
      EMPTY_WORKSPACE_HISTORY,
      result({ items: [item('a')] })
    )
    expect(applied.outcome).toBe('ignored')
    expect(applied.state.items).toEqual([])
  })
})
