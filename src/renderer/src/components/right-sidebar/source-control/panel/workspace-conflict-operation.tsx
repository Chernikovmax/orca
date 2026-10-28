import { Button } from '@/components/ui/button'
import type { RepositoryState } from '../../../../../../shared/git-workspace-types'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import { useWorkspaceBranchActions } from './use-workspace-branch-actions'

export function WorkspaceConflictOperation({
  repository,
  context,
  onRefresh
}: {
  repository: RepositoryState
  context: RuntimeGitContext
  onRefresh: () => void
}) {
  const actions = useWorkspaceBranchActions({ repository, context, onRefresh })
  const operation = repository.conflictOperation
  const supported = operation === 'merge' || operation === 'rebase' || operation === 'cherry-pick'
  const unresolved = repository.entries.filter(
    (entry) => entry.conflictStatus === 'unresolved'
  ).length
  return (
    <section
      aria-label="Conflict operation"
      className="space-y-1 rounded border border-border p-2"
      data-testid="git-conflict-operation"
    >
      <p>
        {operation === 'unknown' ? 'Git operation' : operation} unfinished · {unresolved} unresolved
        index path(s).
      </p>
      <p className="text-muted-foreground">
        Save writes only the result. Mark Resolved records the index; Continue asks Git to finish.
        No marker removal is treated as proof.
      </p>
      <div className="flex gap-1">
        <Button
          size="xs"
          variant="outline"
          disabled={actions.busy !== null || !supported || unresolved > 0}
          onClick={actions.continueOperation}
        >
          Continue {operation}
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={actions.busy !== null || !supported}
          onClick={actions.abortOperation}
        >
          Abort {operation}
        </Button>
      </div>
      {actions.notice && (
        <p
          role={actions.notice.tone === 'error' ? 'alert' : 'status'}
          className={actions.notice.tone === 'error' ? 'text-destructive' : undefined}
        >
          {actions.notice.text}
        </p>
      )}
    </section>
  )
}
