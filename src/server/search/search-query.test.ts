import { describe, expect, it } from 'vitest'

import {
  buildFts5Query,
  normalizePathSegments,
  normalizeSearchQuery,
  normalizeSearchText,
  parseSearchQuery,
  searchableCharacterCount,
} from './search-query.js'

describe('search query normalization', () => {
  it('normalizes compatibility characters and lowercases ASCII without case-folding other Unicode', () => {
    expect(normalizeSearchText('ＡＢＣ Straße Ω')).toBe('abc straße Ω')
    expect(normalizeSearchQuery('  ＡＢＣ\tReport  ')).toBe('abc report')
  })

  it('indexes path components as separated normalized terms', () => {
    expect(normalizePathSegments('C:\\Projects/Artifact Gallery/Release-Notes.md')).toBe(
      'c projects artifact gallery release notes md',
    )
  })

  it('combines whitespace-delimited terms with AND', () => {
    expect(buildFts5Query('Alpha beta')).toBe('"alpha" AND "beta"')
  })

  it('keeps quoted text as a phrase and safely quotes punctuation', () => {
    expect(buildFts5Query('"Alpha beta" node.js C++ foo:bar')).toBe(
      '"alpha beta" AND "node.js" AND "c++" AND "foo:bar"',
    )
  })

  it('preserves whether each normalized query part is an unquoted term or quoted phrase', () => {
    expect(parseSearchQuery('A "猫 犬" Ｂ')).toEqual([
      { value: 'a', phrase: false },
      { value: '猫 犬', phrase: true },
      { value: 'b', phrase: false },
    ])
  })

  it('counts normalized query content by Unicode code point without quote or whitespace syntax', () => {
    expect(searchableCharacterCount(' "猫" ')).toBe(1)
    expect(searchableCharacterCount('ＡI')).toBe(2)
    expect(searchableCharacterCount('"東京 cafe"')).toBe(6)
  })

  it('produces no FTS expression for an empty normalized query', () => {
    expect(buildFts5Query(' \t "" ')).toBeNull()
  })
})
