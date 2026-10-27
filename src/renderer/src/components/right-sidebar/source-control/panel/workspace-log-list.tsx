import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { GitHistoryItem } from '../../../../../../shared/git-history'
import type { GitHistoryItemViewModel } from '../../../../../../shared/git-history-graph'
import { GitHistoryRow } from '../sync/git-history-row'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

const ROW_HEIGHT = 28
const OVERSCAN = 6
const FALLBACK_VIEWPORT = 240

/**
 * Virtualized commit list. Only rows inside the viewport (plus a small overscan)
 * are mounted, while the full graph model keeps every lane so a later page keeps
 * its connections. Keyboard selection reuses the same row buttons.
 */
export function WorkspaceLogList({
  viewModels,
  selectedId,
  onSelect,
  empty,
  loading,
  hasMore,
  loadingMore,
  onLoadMore
}: {
  viewModels: GitHistoryItemViewModel[]
  selectedId: string | null
  onSelect: (item: GitHistoryItem) => void
  empty: boolean
  loading: boolean
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: FALLBACK_VIEWPORT })
  const focusRows = useRef(false)

  useEffect(() => {
    const element = scrollRef.current
    if (!element) {
      return
    }
    const readViewport = () =>
      setViewport({ top: element.scrollTop, height: element.clientHeight || FALLBACK_VIEWPORT })
    readViewport()
    element.addEventListener('scroll', readViewport, { passive: true })
    window.addEventListener('resize', readViewport)
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(readViewport)
    observer?.observe(element)
    return () => {
      element.removeEventListener('scroll', readViewport)
      window.removeEventListener('resize', readViewport)
      observer?.disconnect()
    }
  }, [])

  useEffect(() => {
    if (!focusRows.current) {
      return
    }
    focusRows.current = false
    const frame = requestAnimationFrame(() => {
      scrollRef.current?.querySelector<HTMLButtonElement>('[data-selected="true"]')?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [selectedId, viewport])

  const start = useMemo(
    () => Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN),
    [viewport.top]
  )
  const end = useMemo(
    () => Math.min(viewModels.length, Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + OVERSCAN),
    [viewModels.length, viewport.height, viewport.top]
  )

  function moveBy(delta: number): void {
    if (!viewModels.length) {
      return
    }
    const current = viewModels.findIndex((viewModel) => viewModel.historyItem.id === selectedId)
    const next = Math.min(viewModels.length - 1, Math.max(0, (current === -1 ? 0 : current + delta)))
    focusRows.current = true
    onSelect(viewModels[next]!.historyItem)
    const element = scrollRef.current
    if (element) {
      const top = next * ROW_HEIGHT
      if (top < element.scrollTop) {
        element.scrollTop = top
      } else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) {
        element.scrollTop = top + ROW_HEIGHT - element.clientHeight
      }
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) {
      return
    }
    const page = Math.max(1, Math.floor(viewport.height / ROW_HEIGHT) - 1)
    const action: Record<string, () => void> = {
      ArrowDown: () => moveBy(1),
      ArrowUp: () => moveBy(-1),
      PageDown: () => moveBy(page),
      PageUp: () => moveBy(-page),
      Home: () => moveBy(-viewModels.length),
      End: () => moveBy(viewModels.length)
    }
    const run = action[event.key]
    if (!run) {
      return
    }
    event.preventDefault()
    run()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="git-log-list">
      <div
        ref={scrollRef}
        tabIndex={0}
        role="group"
        aria-label="Commit history"
        className="relative min-h-[140px] flex-1 overflow-auto scrollbar-sleek outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onKeyDown={onKeyDown}
      >
        {loading && !viewModels.length && (
          <p role="status" className="p-3 text-xs text-muted-foreground">
            Loading history…
          </p>
        )}
        {!loading && empty && (
          <p role="status" className="p-3 text-xs text-muted-foreground">
            No commits in this checkout yet.
          </p>
        )}
        <div style={{ height: viewModels.length * ROW_HEIGHT, position: 'relative' }}>
          {viewModels.slice(start, end).map((viewModel, offset) => {
            const index = start + offset
            const selected = viewModel.historyItem.id === selectedId
            return (
              <div
                key={`${viewModel.kind}:${viewModel.historyItem.id}`}
                style={{
                  position: 'absolute',
                  top: index * ROW_HEIGHT,
                  left: 0,
                  right: 0,
                  height: ROW_HEIGHT
                }}
              >
                <GitHistoryRow
                  viewModel={viewModel}
                  onOpenCommit={onSelect}
                  data-selected={selected ? 'true' : 'false'}
                  aria-current={selected ? 'true' : undefined}
                  className={cn('h-full py-0', selected && 'bg-accent')}
                />
              </div>
            )
          })}
        </div>
      </div>
      {(hasMore || loadingMore) && (
        <div className="flex items-center gap-2 border-t border-border px-2 py-1">
          <Button variant="outline" size="xs" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? 'Loading more…' : 'Load more commits'}
          </Button>
          <span className="text-[10px] text-muted-foreground">
            History is pinned to the loaded commits; new refs reload the list.
          </span>
        </div>
      )}
    </div>
  )
}
