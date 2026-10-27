import { Button } from '@/components/ui/button'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import type { SubmoduleEntry } from '../../../../../../shared/git-workspace-types'

const keyOf = (entry: GitStatusEntry) => `${entry.area}:${entry.path}`

function shortOid(oid: string | undefined): string {
  return oid ? oid.slice(0, 10) : 'unknown'
}

export type WorkspaceChangesListProps = {
  groups: { name: string; entries: GitStatusEntry[] }[]
  tree: boolean
  collapsed: string[]
  selected: string
  busy: boolean
  onToggleDirectory: (key: string) => void
  onOpen: (entry: GitStatusEntry) => void
  onStage: (entry: GitStatusEntry) => void
  onUnstage: (entry: GitStatusEntry) => void
  onDiscard: (entry: GitStatusEntry) => void
  onStageGitlink: (entry: GitStatusEntry, module: SubmoduleEntry) => void
  gitlinkFor: (entry: GitStatusEntry) => SubmoduleEntry | undefined
}

/** The four change groups with their file actions; all writes are host-authorized. */
export function WorkspaceChangesList({
  groups,
  tree,
  collapsed,
  selected,
  busy,
  onToggleDirectory,
  onOpen,
  onStage,
  onUnstage,
  onDiscard,
  onStageGitlink,
  gitlinkFor
}: WorkspaceChangesListProps) {
  return (
    <>
      {groups.map((group) => (
        <section key={group.name} aria-label={group.name}>
          <h4 className="font-semibold">
            {group.name} ({group.entries.length})
          </h4>
          <ul className="space-y-1">
            {group.entries
              .toSorted((a, b) => a.path.localeCompare(b.path))
              .map((entry, index, sorted) => {
                const directory = entry.path.includes('/')
                  ? entry.path.slice(0, entry.path.lastIndexOf('/'))
                  : ''
                const previousDirectory = index
                  ? sorted[index - 1].path.slice(0, sorted[index - 1].path.lastIndexOf('/'))
                  : undefined
                const directoryKey = `${group.name}:${directory}`
                const module = gitlinkFor(entry)
                const discardable =
                  entry.area === 'unstaged' &&
                  !module &&
                  !entry.oldPath &&
                  (entry.status === 'modified' || entry.status === 'deleted')
                return (
                  <li key={keyOf(entry)}>
                    {tree && directory && directory !== previousDirectory && (
                      <Button
                        variant="ghost"
                        size="xs"
                        aria-expanded={!collapsed.includes(directoryKey)}
                        onClick={() => onToggleDirectory(directoryKey)}
                      >
                        {directory}
                      </Button>
                    )}
                    {(!tree || !collapsed.includes(directoryKey)) && (
                      <div className="flex flex-wrap items-center gap-1">
                        <Button
                          variant="ghost"
                          size="xs"
                          className="h-auto max-w-full justify-start whitespace-pre-wrap break-all text-left"
                          data-testid="source-control-entry"
                          aria-pressed={selected === keyOf(entry)}
                          onClick={() => onOpen(entry)}
                        >
                          {entry.conflictStatus === 'unresolved' ? 'conflict' : entry.area} ·{' '}
                          {entry.status} {entry.oldPath ? `${entry.oldPath} → ` : ''}
                          {tree ? entry.path.slice(entry.path.lastIndexOf('/') + 1) : entry.path}
                        </Button>
                        {(entry.area === 'unstaged' || entry.area === 'untracked') &&
                          (module ? (
                            <Button
                              variant="outline"
                              size="xs"
                              disabled={busy || !module.currentOid || !module.contextId}
                              data-testid="stage-gitlink"
                              data-path={entry.path}
                              title="Records the reviewed child commit in the parent index; child files are not staged"
                              onClick={() => onStageGitlink(entry, module)}
                            >
                              Stage gitlink {shortOid(module.currentOid)}
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              size="xs"
                              disabled={busy || entry.conflictStatus === 'unresolved'}
                              data-testid="stage-entry"
                              data-path={entry.path}
                              onClick={() => onStage(entry)}
                            >
                              Stage
                            </Button>
                          ))}
                        {entry.area === 'staged' && (
                          <Button
                            variant="outline"
                            size="xs"
                            disabled={busy}
                            data-testid="unstage-entry"
                            data-path={entry.path}
                            onClick={() => onUnstage(entry)}
                          >
                            Unstage
                          </Button>
                        )}
                        {discardable && (
                          <Button
                            variant="ghost"
                            size="xs"
                            disabled={busy}
                            data-testid="discard-entry"
                            data-path={entry.path}
                            onClick={() => onDiscard(entry)}
                          >
                            Discard
                          </Button>
                        )}
                        {module && entry.area === 'unstaged' && module.dirty && (
                          <span className="text-muted-foreground">
                            child has uncommitted changes not included
                          </span>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
          </ul>
        </section>
      ))}
    </>
  )
}
