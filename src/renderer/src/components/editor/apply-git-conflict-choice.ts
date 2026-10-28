import { findGitConflictBlocks } from './monaco-conflict-decorations'
import { forEachLine } from './text-line-offsets'

export type GitConflictChoice = 'ours' | 'theirs' | 'both'

export function applyGitConflictChoice(
  content: string,
  blockIndex: number,
  choice: GitConflictChoice
): string {
  const block = findGitConflictBlocks(content)[blockIndex]
  if (!block) {
    throw new Error('The selected conflict block is no longer available')
  }
  let start = 0
  let end = content.length
  let oursStart = 0
  let oursEnd = 0
  let theirsStart = 0
  let theirsEnd = 0
  forEachLine(content, (lineStart, _lineEnd, lineNumber) => {
    if (lineNumber === block.startLine) {
      start = lineStart
    }
    if (lineNumber === block.startLine + 1) {
      oursStart = lineStart
    }
    if (lineNumber === (block.baseLine ?? block.separatorLine)) {
      oursEnd = lineStart
    }
    if (lineNumber === block.separatorLine + 1) {
      theirsStart = lineStart
    }
    if (lineNumber === block.endLine) {
      theirsEnd = lineStart
      const newline = content.indexOf('\n', lineStart)
      end = newline === -1 ? content.length : newline + 1
      return false
    }
    return undefined
  })
  const ours = choice !== 'theirs' ? content.slice(oursStart, oursEnd) : ''
  const theirs = choice !== 'ours' ? content.slice(theirsStart, theirsEnd) : ''
  return content.slice(0, start) + ours + theirs + content.slice(end)
}
