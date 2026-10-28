import { describe, expect, it } from 'vitest'
import { applyGitConflictChoice } from './apply-git-conflict-choice'

const choices = ['ours', 'theirs', 'both'] as const

describe.each(['\n', '\r\n'])('conflict choices with %j line endings', (eol) => {
  it.each(choices)(
    'chooses %s without retaining diff3 ancestor or changing surrounding bytes',
    (choice) => {
      const content = [
        'before 😀',
        '<<<<<<< HEAD',
        'ours 修正',
        '||||||| ancestor',
        'old ancestor',
        '=======',
        'theirs résumé',
        '>>>>>>> incoming',
        'after'
      ].join(eol)
      const selected =
        choice === 'both'
          ? ['ours 修正', 'theirs résumé']
          : [choice === 'ours' ? 'ours 修正' : 'theirs résumé']
      expect(applyGitConflictChoice(content, 0, choice)).toBe(
        ['before 😀', ...selected, 'after'].join(eol)
      )
    }
  )
})

it('changes only the selected later block and retains the untouched first block', () => {
  const first = '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> incoming\n'
  const second = '<<<<<<< HEAD\nc\n=======\nd\n>>>>>>> incoming'
  expect(applyGitConflictChoice(`${first}middle\n${second}`, 1, 'theirs')).toBe(
    `${first}middle\nd\n`
  )
})

it('allows an empty chosen side while preserving the suffix without a terminal newline', () => {
  const content = 'prefix\n<<<<<<< HEAD\n=======\nadded\n>>>>>>> incoming\nsuffix'
  expect(applyGitConflictChoice(content, 0, 'ours')).toBe('prefix\nsuffix')
})

it('refuses a selection whose conflict block was removed by an intervening edit', () => {
  expect(() => applyGitConflictChoice('manually resolved\n', 0, 'both')).toThrow()
})
