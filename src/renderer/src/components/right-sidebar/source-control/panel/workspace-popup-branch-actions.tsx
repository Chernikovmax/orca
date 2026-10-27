import { Button } from '@/components/ui/button'
import type { GitWorkspaceRef, RepositoryState } from '../../../../../../shared/git-workspace-types'
import type { WorkspaceBranchActions } from './use-workspace-branch-actions'

type Props = {
  repository: RepositoryState
  ref: GitWorkspaceRef
  actions: WorkspaceBranchActions
  /** Prefills the New Branch start point and moves focus to its input. */
  onUseStartPoint: (refName: string) => void
  disabled: boolean
}

function shortName(refName: string): string {
  return refName.replace(/^refs\/(?:heads|remotes|tags)\//, '')
}

function remoteParts(
  refName: string,
  remotes: string[]
): { remote: string; branch: string } | null {
  const rest = refName.slice('refs/remotes/'.length)
  const remote = [...remotes]
    .sort((left, right) => right.length - left.length)
    .find((name) => rest.startsWith(`${name}/`))
  return remote ? { remote, branch: rest.slice(remote.length + 1) } : null
}

function trackingSummary(ref: GitWorkspaceRef): string {
  if (ref.upstreamGone) {
    return `Upstream ${shortName(ref.upstream ?? '')} is gone locally`
  }
  if (!ref.upstream) {
    return 'No upstream configured'
  }
  const counts =
    ref.ahead === undefined || ref.behind === undefined
      ? ''
      : ` · ahead ${ref.ahead}, behind ${ref.behind}`
  return `Upstream ${shortName(ref.upstream)}${counts}`
}

export function BranchRefActions({ repository, ref, actions, onUseStartPoint, disabled }: Props) {
  const isCurrent = repository.branch === ref.name
  const isRemote = ref.name.startsWith('refs/remotes/')
  const isRemoteHead = isRemote && ref.name.endsWith('/HEAD')
  const fetchTarget = isRemote ? remoteParts(ref.name, repository.remotes ?? []) : null
  const busy = actions.busy !== null || disabled
  return (
    <div className="space-y-2" data-testid="git-ref-actions">
      <p className="text-muted-foreground">{trackingSummary(ref)}</p>
      <div className="flex flex-wrap gap-1">
        <Button
          variant="outline"
          size="xs"
          data-navigation-item
          data-navigation-action
          disabled={busy || isCurrent || isRemoteHead}
          onClick={() => actions.checkout(ref.name)}
        >
          Checkout
        </Button>
        <Button
          variant="outline"
          size="xs"
          data-navigation-item
          data-navigation-action
          disabled={busy}
          onClick={() => onUseStartPoint(ref.name)}
        >
          New branch from here
        </Button>
        {!isCurrent && (
          <>
            <Button
              variant="outline"
              size="xs"
              data-navigation-item
              data-navigation-action
              disabled={busy || repository.operationInProgress}
              onClick={() => actions.merge(ref.name)}
            >
              Merge into current
            </Button>
            <Button
              variant="outline"
              size="xs"
              data-navigation-item
              data-navigation-action
              disabled={busy || repository.operationInProgress}
              onClick={() => actions.rebase(ref.name)}
            >
              Rebase current onto this
            </Button>
          </>
        )}
        {fetchTarget && (
          <Button
            variant="outline"
            size="xs"
            data-navigation-item
            data-navigation-action
            disabled={busy}
            onClick={() => actions.fetch(fetchTarget.remote, fetchTarget.branch)}
          >
            Fetch this branch
          </Button>
        )}
      </div>
      {isCurrent && (
        <p className="text-muted-foreground">This branch is checked out in this worktree.</p>
      )}
      {isRemoteHead && (
        <p className="text-muted-foreground">
          A remote HEAD symbolic ref cannot be checked out; choose its branch instead.
        </p>
      )}
      {repository.operationInProgress && (
        <p className="text-muted-foreground">
          Merge and rebase start only after the unfinished operation is continued or aborted.
        </p>
      )}
    </div>
  )
}
