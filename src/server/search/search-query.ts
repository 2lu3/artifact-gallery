const ASCII_UPPERCASE = /[A-Z]/g
const QUERY_WHITESPACE = /\s+/gu
const PATH_BOUNDARY = /[^\p{L}\p{N}]+/gu

export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(ASCII_UPPERCASE, (character) => character.toLowerCase())
}

export function normalizeSearchQuery(value: string): string {
  return normalizeSearchText(value).replace(QUERY_WHITESPACE, ' ').trim()
}

export function normalizePathSegments(sourcePath: string): string {
  return normalizeSearchText(sourcePath).replace(PATH_BOUNDARY, ' ').trim()
}

export function searchableCharacterCount(value: string): number {
  return Array.from(
    parseSearchQuery(value)
      .map((term) => term.value)
      .join('')
      .replace(QUERY_WHITESPACE, ''),
  ).length
}

export function normalizeSearchNeedle(value: string): string {
  return parseSearchQuery(value).map((term) => term.value).join(' ')
}

export function buildFts5Query(value: string): string | null {
  const terms = parseSearchQuery(value)
  if (terms.length === 0) return null
  return terms.map(({ value }) => `"${value.replaceAll('"', '""')}"`).join(' AND ')
}

export interface SearchQueryPart {
  readonly value: string
  readonly phrase: boolean
}

export function parseSearchQuery(value: string): SearchQueryPart[] {
  const normalized = normalizeSearchQuery(value)
  const terms: SearchQueryPart[] = []
  let cursor = 0

  while (cursor < normalized.length) {
    while (normalized[cursor] === ' ') cursor += 1
    if (cursor >= normalized.length) break

    if (normalized[cursor] === '"') {
      cursor += 1
      let phrase = ''
      while (cursor < normalized.length && normalized[cursor] !== '"') {
        phrase += normalized[cursor]
        cursor += 1
      }
      if (normalized[cursor] === '"') cursor += 1
      const trimmed = phrase.trim()
      if (trimmed) terms.push({ value: trimmed, phrase: true })
      continue
    }

    let term = ''
    while (cursor < normalized.length && normalized[cursor] !== ' ') {
      term += normalized[cursor]
      cursor += 1
    }
    const trimmed = term.replaceAll('"', '').trim()
    if (trimmed) terms.push({ value: trimmed, phrase: false })
  }

  return terms
}
