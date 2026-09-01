export const MAX_ARTIFACT_TITLE_CODE_POINTS = 256

const graphemeSegmenter = new Intl.Segmenter('und', { granularity: 'grapheme' })

export function normalizeArtifactTitle(value: string | null | undefined): string | null {
  const normalized = value?.trim()
  if (!normalized) return null
  let codePoints = 0
  let result = ''
  for (const { segment } of graphemeSegmenter.segment(normalized)) {
    const segmentCodePoints = Array.from(segment).length
    if (codePoints + segmentCodePoints > MAX_ARTIFACT_TITLE_CODE_POINTS) break
    result += segment
    codePoints += segmentCodePoints
  }
  return result || null
}

export function artifactTitleCodePointLength(value: string): number {
  return Array.from(value).length
}
