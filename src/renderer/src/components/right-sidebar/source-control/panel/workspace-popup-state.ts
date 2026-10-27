export type ContextPopupState = {
  query: string
  favorites: string[]
  recent: string[]
  inspected: string | null
}

const empty = (): ContextPopupState => ({ query: '', favorites: [], recent: [], inspected: null })

export function readContextPopupState(id: string): ContextPopupState {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`git-context-popup:${id}`) ?? 'null')
    if (!value || typeof value !== 'object') {
      return empty()
    }
    const strings = (input: unknown): string[] =>
      Array.isArray(input)
        ? input.filter((item): item is string => typeof item === 'string').slice(0, 100)
        : []
    return {
      query: 'query' in value && typeof value.query === 'string' ? value.query : '',
      favorites: strings('favorites' in value ? value.favorites : []),
      recent: strings('recent' in value ? value.recent : []),
      inspected:
        'inspected' in value && typeof value.inspected === 'string' ? value.inspected : null
    }
  } catch {
    return empty()
  }
}

export function writeContextPopupState(id: string, state: ContextPopupState) {
  try {
    localStorage.setItem(`git-context-popup:${id}`, JSON.stringify(state))
  } catch {
    /* Storage may be unavailable in ephemeral profiles. */
  }
}

export function contextColor(id: string) {
  let hash = 0
  for (let index = 0; index < id.length; index++) {
    hash = (Math.imul(hash, 31) + id.charCodeAt(index)) | 0
  }
  return `var(--git-graph-lane-${((hash >>> 0) % 5) + 1})`
}
