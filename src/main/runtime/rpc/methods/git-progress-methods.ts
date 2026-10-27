import { defineStreamingMethod } from '../core'
import { GitMutationProgressParams } from '../../../../shared/rpc-contract/git-params'
import { subscribeGitWorkspaceProgress } from '../../../git/source-control/git-workspace-progress'

export const GIT_PROGRESS_METHODS = [
  defineStreamingMethod({
    name: 'git.mutationProgress',
    permission: 'workspace',
    params: GitMutationProgressParams,
    handler: async (params, { signal }, emit) => {
      // Why: an explicit fetch/push streams parsed meter records for one progress id.
      // The subscription ends with the operation's `done` frame or when the caller
      // unsubscribes; no stderr text crosses this boundary.
      const { promise, resolve } = Promise.withResolvers<void>()
      let settled = false
      let unsubscribe: (() => void) | undefined
      const finish = () => {
        if (settled) {
          return
        }
        settled = true
        unsubscribe?.()
        signal?.removeEventListener('abort', finish)
        resolve()
      }
      unsubscribe = subscribeGitWorkspaceProgress(params.progressId, (event) => {
        emit(event)
        if (event.done) {
          finish()
        }
      })
      if (settled || signal?.aborted) {
        finish()
        return promise
      }
      signal?.addEventListener('abort', finish, { once: true })
      return promise
    }
  })
]
