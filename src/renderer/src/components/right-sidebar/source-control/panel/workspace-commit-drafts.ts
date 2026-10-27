const STORAGE_KEY = 'orca.git-workspace.commit-drafts.v1'
const memory = new Map<string, string>()

function readAll(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return {}
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    )
  } catch {
    return {}
  }
}

function persistAll(drafts: Record<string, string>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts))
  } catch {
    // Why: storage can be unavailable in hardened profiles; the in-memory copy still isolates contexts.
  }
}

/** Commit message draft for one host-issued Git context (root and every child separately). */
export function readWorkspaceCommitDraft(contextId: string): string {
  const stored = readAll()[contextId]
  return stored ?? memory.get(contextId) ?? ''
}

export function writeWorkspaceCommitDraft(contextId: string, value: string): void {
  memory.set(contextId, value)
  const drafts = readAll()
  if (value) {
    drafts[contextId] = value
  } else {
    delete drafts[contextId]
  }
  persistAll(drafts)
}

/** Only clears the draft when it still matches what was just committed. */
export function clearWorkspaceCommitDraftIfUnchanged(contextId: string, committed: string): void {
  if (readWorkspaceCommitDraft(contextId).trim() !== committed.trim()) {
    return
  }
  memory.delete(contextId)
  const drafts = readAll()
  delete drafts[contextId]
  persistAll(drafts)
}
