import type {
  GitSubmoduleLifecyclePreview,
  GitWorkspaceMutationRequest
} from '../../../shared/git-workspace-mutation'
import { GitMutationError } from './git-workspace-mutation-error'

export type ChildRemoteReview = {
  contextId: string
  checkoutPath: string
  name: string
  url: string
}
export type SubmodulePreviewToken = {
  preview: GitSubmoduleLifecyclePreview
  args: string
  metadataFence: string
  childRemote?: ChildRemoteReview
  resolvedUrl?: string
  expiresAt: number
}
export const previews = new Map<string, SubmodulePreviewToken>()
export const TOKEN_TTL_MS = 5 * 60_000

export function operationFor(
  action: GitWorkspaceMutationRequest['action']
): GitSubmoduleLifecyclePreview['operation'] | undefined {
  switch (action) {
    case 'previewSubmoduleInitialize':
      return 'initialize'
    case 'previewSubmoduleCheckout':
      return 'checkout'
    case 'previewSubmoduleSyncUrl':
      return 'syncUrl'
    case 'previewSubmoduleAdd':
      return 'add'
    case 'previewSubmoduleRemove':
      return 'remove'
    default:
      return undefined
  }
}

export function storeSubmodulePreview(token: SubmodulePreviewToken): void {
  for (const [id, current] of previews) {
    if (current.expiresAt < Date.now()) {
      previews.delete(id)
    }
  }
  if (previews.size >= 128) {
    throw new GitMutationError(
      'busy',
      'Too many pending submodule previews; retry after they expire'
    )
  }
  previews.set(token.preview.previewId, token)
}

type ReviewedSubmoduleMetadata = {
  declaredUrl?: string
  effectiveUrl?: string
  parentRemote?: string
  indexOid?: string
  childContextId?: string
  headOid?: string
}
export function submodulePreviewArguments(
  request: GitWorkspaceMutationRequest,
  filePath: string,
  metadata: ReviewedSubmoduleMetadata
): string {
  return JSON.stringify({
    action: request.action.replace(/^submodule/, 'previewSubmodule'),
    filePath,
    url: request.url,
    recursive: request.recursive === true,
    targetOid: request.childOid ?? request.refName,
    metadata
  })
}
