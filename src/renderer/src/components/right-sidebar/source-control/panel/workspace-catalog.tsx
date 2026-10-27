import { Button } from '@/components/ui/button'
import type { WorkspaceCatalogModel } from './use-workspace-catalog'
import { SourceControlWorkspaceChanges } from './workspace-changes'
import { WorkspaceSubmoduleActions } from './workspace-submodule-actions'
import { WorkspaceSubmoduleAdd } from './workspace-submodule-add'
import { WorkspaceBatchActions } from './workspace-batch-actions'

export function SourceControlWorkspaceCatalog({
  model,
  onOpenLog
}: {
  model: WorkspaceCatalogModel
  onOpenLog?: () => void
}) {
  const { snapshot, loading, error, selected, setSelected, refresh } = model

  const root = snapshot?.repositories.find(
    (repository) => repository.context.id === snapshot.rootContextId
  )
  const repository = snapshot?.repositories.find((item) => item.context.id === selected)
  const module = snapshot?.submodules.find((item) => item.contextId === selected)
  return (
    <section
      className="space-y-3 p-3 text-xs"
      aria-label="Git contexts"
      data-testid="git-workspace-catalog"
      aria-busy={loading}
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">Submodules</h2>
        <Button
          variant="outline"
          size="xs"
          onClick={refresh}
        >
          Refresh
        </Button>
      </div>
      <p role="status" className="text-muted-foreground">
        {loading
          ? 'Loading Git contexts…'
          : error
            ? 'Refresh failed; previous snapshot is stale.'
            : snapshot?.incomplete
              ? 'Incomplete discovery — unavailable descendants are unknown, not empty.'
              : 'Local snapshot — no fetch or clone.'}
      </p>
      {error && (
        <p role="alert" className="text-destructive break-words">
          {error}
        </p>
      )}
      {snapshot && (
        <>
          <ul aria-label="Repositories" className="space-y-1">
            {root && (
              <li>
                <Button
                  variant="ghost"
                  size="xs"
                  className="w-full justify-start"
                  aria-pressed={selected === root.context.id}
                  onClick={() => setSelected(root.context.id)}
                >
                  Root ·{' '}
                  {root.branch?.replace(/^refs\/heads\//, '') ??
                    (root.unborn ? 'unborn' : `detached ${root.head?.slice(0, 8)}`)}{' '}
                  · {root.conflicted ? 'conflicts' : root.dirty ? 'dirty' : 'clean'}
                </Button>
              </li>
            )}
            {snapshot.submodules.map((entry) => {
              const child = snapshot.repositories.find(
                (item) => item.context.id === entry.contextId
              )
              const parentRepository = snapshot.repositories.find(
                (item) => item.context.id === entry.parentContextId
              )
              return (
                <li
                  key={`${entry.parentContextId}:${entry.path}`}
                  className="rounded-md border border-border p-2 space-y-1"
                  data-testid="git-submodule-row"
                >
                  <Button
                    variant="ghost"
                    size="xs"
                    className="h-auto w-full justify-start whitespace-normal text-left break-all"
                    disabled={!child}
                    aria-pressed={!!child && selected === child.context.id}
                    onClick={() => child && setSelected(child.context.id)}
                  >
                    {entry.path}
                  </Button>
                  <p>
                    {entry.availability} ·{' '}
                    {child?.branch?.replace(/^refs\/heads\//, '') ??
                      (child
                        ? child.unborn
                          ? 'unborn'
                          : `detached ${child.head?.slice(0, 8)}`
                        : 'checkout unavailable')}
                  </p>
                  <p>
                    {[
                      entry.commitChanged && 'new HEAD',
                      entry.stagedGitlinkChanged && 'staged gitlink',
                      entry.dirty && 'dirty files',
                      entry.conflicted && 'conflicts'
                    ]
                      .filter(Boolean)
                      .join(' · ') || (child ? 'clean' : 'status unknown')}
                  </p>
                  <p className="font-mono break-all text-muted-foreground">
                    HEAD gitlink: {entry.headOid ?? 'none'}
                    <br />
                    Index gitlink:{' '}
                    {entry.indexOid ?? (entry.indexConflictOids.length ? 'unmerged' : 'none')}
                    <br />
                    Checkout: {entry.currentOid ?? 'unknown'}
                  </p>
                  {entry.descendants !== 'complete' && <p>Descendants: {entry.descendants}</p>}
                  {entry.declaredUrls.map((url) => (
                    <p key={url} className="break-all text-muted-foreground">
                      Declared: {url}
                    </p>
                  ))}
                  {entry.effectiveUrl && (
                    <p className="break-all text-muted-foreground">Local: {entry.effectiveUrl}</p>
                  )}
                  {entry.metadataIssues.map((issue) => (
                    <p key={issue} className="text-destructive">
                      {issue}
                    </p>
                  ))}
                  {entry.error && (
                    <p className="text-destructive">
                      {entry.error.category}: {entry.error.message}
                    </p>
                  )}
                  {model.context && parentRepository && (
                    <WorkspaceSubmoduleActions
                      entry={entry}
                      parent={parentRepository}
                      context={model.context}
                      workspaceRootPath={root?.context.checkoutPath ?? parentRepository.context.checkoutPath}
                      remoteRefs={child?.refs ?? []}
                      onLoadRemoteRefs={() => model.requestRefs(entry.contextId)}
                      onRefresh={refresh}
                    />
                  )}
                </li>
              )
            })}
          </ul>
          {snapshot.submodules.length === 0 && !snapshot.incomplete && (
            <p>No submodules declared in local metadata.</p>
          )}
          {snapshot.errors.map((detail, index) => (
            <p key={`${detail.path}:${index}`} className="text-destructive break-words">
              {detail.path}: {detail.error.message}
            </p>
          ))}
          {model.context && repository && (
            <WorkspaceSubmoduleAdd
              parent={repository}
              context={model.context}
              onRefresh={refresh}
            />
          )}
          {model.context && (
            <WorkspaceBatchActions
              snapshot={snapshot}
              context={model.context}
              onRefresh={refresh}
              onRequestRefs={model.requestRefs}
            />
          )}
          {repository && model.context && (
            <SourceControlWorkspaceChanges
              key={repository.context.id}
              repository={repository}
              context={model.context}
              label={module?.path ?? 'Root'}
              refreshGeneration={snapshot}
              submodules={snapshot.submodules}
              showCommit={repository.context.id !== snapshot.rootContextId}
              onRefresh={model.refresh}
              onOpenLog={onOpenLog}
            />
          )}
        </>
      )}
    </section>
  )
}
