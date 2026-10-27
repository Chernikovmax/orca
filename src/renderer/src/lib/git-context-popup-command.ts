export const GIT_CONTEXT_POPUP_EVENT = 'orca:open-git-context-popup'
let pending = false

export function requestGitContextPopup() {
  pending = true
  window.dispatchEvent(new Event(GIT_CONTEXT_POPUP_EVENT))
}

export function consumeGitContextPopupRequest() {
  const requested = pending
  pending = false
  return requested
}
