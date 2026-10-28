import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { WorkspaceCatalogModel } from './use-workspace-catalog'
import { contextColor } from './workspace-popup-state'
import { ContextRefs } from './workspace-popup-refs'

type Props = {
  model: WorkspaceCatalogModel
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanges: () => void
  onLog: () => void
}

export function SourceControlWorkspacePopup({
  model,
  open,
  onOpenChange,
  onChanges,
  onLog
}: Props) {
  const { snapshot, selected, setSelected, requestRefs } = model
  const [repositoryQuery, setRepositoryQuery] = useState('')
  const [tree, setTree] = useState(() => localStorage.getItem('git-context-popup:tree') !== 'false')
  const [collapsed, setCollapsed] = useState<string[]>([])
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const repositorySearch = useRef<HTMLInputElement>(null)
  const refsSearch = useRef<HTMLInputElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const focusRefs = useRef(false)
  const root = snapshot?.repositories.find((item) => item.context.id === snapshot.rootContextId)
  const rows = [
    ...(root
      ? [
          {
            key: root.context.id,
            path: '.',
            name: 'Root',
            parent: '',
            repository: root,
            module: undefined
          }
        ]
      : []),
    ...(snapshot?.submodules.map((module) => ({
      key: module.contextId ?? `${module.parentContextId}:${module.path}`,
      path: module.path,
      name: module.name,
      parent: module.parentContextId,
      repository: snapshot.repositories.find((item) => item.context.id === module.contextId),
      module
    })) ?? [])
  ]
  const chosen = rows.find((item) => item.key === (unavailable ?? selected))
  const filtered = rows
    .filter((row) => {
      if (repositoryQuery) {
        return `${row.name} ${row.path}`.toLowerCase().includes(repositoryQuery.toLowerCase())
      }
      if (!tree) {
        return true
      }
      return !rows.some(
        (parent) =>
          collapsed.includes(parent.key) &&
          parent.path !== row.path &&
          (parent.path === '.' || row.path.startsWith(`${parent.path}/`))
      )
    })
    .sort((a, b) => (a.path === '.' ? -1 : b.path === '.' ? 1 : a.path.localeCompare(b.path)))

  useEffect(() => {
    if (open && selected && !unavailable) {
      requestRefs(selected)
    }
  }, [open, selected, unavailable, requestRefs])

  useEffect(() => {
    if (focusRefs.current) {
      refsSearch.current?.focus()
      focusRefs.current = false
    }
  }, [chosen?.key])

  function enterContext(key: string) {
    focusRefs.current = true
    choose(key)
    refsSearch.current?.focus()
  }

  function choose(key: string) {
    const row = rows.find((item) => item.key === key)
    if (row?.repository) {
      setUnavailable(null)
      setSelected(key)
    } else {
      setUnavailable(key)
    }
  }

  function navigate(event: KeyboardEvent<HTMLElement>, side: 'repositories' | 'refs') {
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) {
      return
    }
    // Why: native selects and multiline controls keep their own arrow keys.
    if (event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) {
      return
    }
    const pane = event.currentTarget
    const items = Array.from(pane.querySelectorAll<HTMLButtonElement>('[data-navigation-item]'))
    const fromSearch = event.target === refsSearch.current
    // Why: action buttons sit above the refs list. Arrow-down from the search box
    // must reach the first ref, not an action, while arrow-up from a ref may still
    // land on the actions.
    const pool = fromSearch
      ? items.filter((item) => !item.hasAttribute('data-navigation-action'))
      : items
    const index =
      document.activeElement instanceof HTMLButtonElement
        ? pool.indexOf(document.activeElement)
        : -1
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const next =
        event.key === 'ArrowDown' ? index + 1 : index === -1 ? pool.length - 1 : index - 1
      if (pool[next]) {
        event.preventDefault()
        pool[next].focus()
        pool[next].scrollIntoView({ block: 'nearest' })
      }
    } else if (
      event.key === 'ArrowRight' &&
      side === 'repositories' &&
      event.target instanceof HTMLButtonElement
    ) {
      event.preventDefault()
      if (event.target.dataset.contextKey) {
        enterContext(event.target.dataset.contextKey)
      }
    } else if (
      event.key === 'ArrowLeft' &&
      side === 'refs' &&
      (!(event.target instanceof HTMLInputElement) ||
        (event.target.selectionStart === 0 && event.target.selectionEnd === 0))
    ) {
      event.preventDefault()
      repositorySearch.current?.focus()
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-4xl p-0 gap-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          returnFocus.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null
          repositorySearch.current?.focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (returnFocus.current?.isConnected) {
            returnFocus.current.focus()
          }
        }}
      >
        <div className="border-b border-border p-3 pr-12">
          <DialogTitle size="compact">Git contexts and branches</DialogTitle>
          <DialogDescription size="compact">
            Browse contexts and refs; checkout, new branch, fetch, push and integration run only
            when you activate them. Selecting a ref never changes Git.
          </DialogDescription>
        </div>
        <div
          className="grid grid-cols-2 grid-rows-[minmax(0,1fr)] min-h-80 max-h-[70vh]"
          data-testid="git-workspace-popup"
        >
          <section
            aria-label="Repository picker"
            className="flex min-h-0 min-w-0 flex-col border-r border-border p-2 gap-2"
            onKeyDown={(event) => navigate(event, 'repositories')}
          >
            <div className="flex gap-2">
              <Input
                ref={repositorySearch}
                aria-label="Search repositories"
                placeholder="Name or path…"
                value={repositoryQuery}
                onChange={(event) => setRepositoryQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && filtered[0]) {
                    event.preventDefault()
                    enterContext(filtered[0].key)
                  }
                }}
              />
              <Button
                variant="outline"
                size="sm"
                aria-pressed={tree}
                onClick={() => {
                  setTree(!tree)
                  localStorage.setItem('git-context-popup:tree', String(!tree))
                }}
              >
                {tree ? 'Tree' : 'Flat'}
              </Button>
            </div>
            {model.loading && (
              <p role="status" className="text-xs text-muted-foreground">
                Refreshing Git contexts…
              </p>
            )}
            {model.error && (
              <p role="alert" className="text-xs text-destructive">
                {model.error}
              </p>
            )}
            <div
              className="min-h-0 flex-1 overflow-auto overscroll-contain scrollbar-sleek space-y-1"
              role="group"
              aria-label="Repository results"
            >
              {filtered.map((row) => (
                <div
                  key={row.key}
                  className="flex items-start gap-1"
                  style={{
                    paddingLeft:
                      tree && !repositoryQuery
                        ? (row.path === '.' ? 0 : row.path.split('/').length) * 12
                        : 0
                  }}
                >
                  {tree && rows.some((item) => item.parent === row.key) && (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`${collapsed.includes(row.key) ? 'Expand' : 'Collapse'} ${row.path}`}
                      onClick={() =>
                        setCollapsed((value) =>
                          value.includes(row.key)
                            ? value.filter((key) => key !== row.key)
                            : [...value, row.key]
                        )
                      }
                    >
                      {collapsed.includes(row.key) ? '▸' : '▾'}
                    </Button>
                  )}
                  <button
                    type="button"
                    data-navigation-item
                    data-context-key={row.key}
                    aria-pressed={chosen?.key === row.key}
                    className="flex-1 min-w-0 rounded-md p-2 text-left text-xs hover:bg-accent aria-pressed:bg-accent focus-visible:ring-2 focus-visible:ring-ring outline-none"
                    onClick={() => choose(row.key)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        enterContext(row.key)
                      }
                    }}
                  >
                    <span className="flex items-center gap-2 font-semibold">
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: contextColor(row.key) }}
                      />
                      {row.name}
                    </span>
                    <span className="block break-all font-mono text-muted-foreground">
                      {row.path}
                    </span>
                    <span className="block break-all">
                      {row.repository?.branch?.replace(/^refs\/heads\//, '') ??
                        (row.repository
                          ? row.repository.unborn
                            ? 'unborn'
                            : `detached ${row.repository.head?.slice(0, 8)}`
                          : row.module?.availability)}{' '}
                      ·{' '}
                      {row.repository?.conflicted || row.module?.conflicted
                        ? 'conflicts'
                        : row.repository?.dirty
                          ? 'dirty'
                          : row.repository
                            ? 'clean'
                            : 'status unknown'}
                    </span>
                  </button>
                </div>
              ))}
              {filtered.length === 0 && (
                <p className="p-2 text-xs text-muted-foreground">No matching repositories.</p>
              )}
            </div>
          </section>
          <section
            aria-label="Context refs"
            className="min-h-0 min-w-0 overflow-auto overscroll-contain scrollbar-sleek p-3 space-y-3"
            onKeyDown={(event) => navigate(event, 'refs')}
          >
            <Button variant="ghost" size="xs" onClick={() => repositorySearch.current?.focus()}>
              ← Repositories
            </Button>
            <h3 className="text-sm font-semibold break-all">
              {chosen?.name ?? 'Select a context'} · {chosen?.path}
            </h3>
            {chosen?.repository && model.context ? (
              <ContextRefs
                key={chosen.key}
                repository={chosen.repository}
                context={model.context}
                loading={model.loading}
                inputRef={refsSearch}
                onRefresh={model.refresh}
                onChanges={() => {
                  setSelected(chosen.key)
                  onOpenChange(false)
                  onChanges()
                }}
                onLog={() => {
                  setSelected(chosen.key)
                  onOpenChange(false)
                  onLog()
                }}
              />
            ) : (
              <>
                <Input
                  ref={refsSearch}
                  aria-label="Search refs"
                  disabled
                  placeholder="Refs unavailable"
                />
                <p className="text-xs">
                  {chosen?.module?.availability ?? 'Loading catalog'} —{' '}
                  {chosen?.module?.error?.message ??
                    (chosen?.repository
                      ? 'This execution host cannot run Git commands for the selected context.'
                      : 'No initialized checkout is available.')}
                </p>
                {chosen?.module?.descendants !== 'complete' && (
                  <p className="text-xs text-muted-foreground">
                    Descendants: {chosen?.module?.descendants ?? 'unknown'}. Initialization is not
                    available in this stage.
                  </p>
                )}
              </>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
