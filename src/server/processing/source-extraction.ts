import { parse as parseHtml, type DefaultTreeAdapterTypes } from 'parse5'

import type { MarkdownRenderResult } from '../rendering/markdown-renderer.js'

const EXTRACTOR_VERSION = 'commonmark-safe-1'

export interface SourceExtraction {
  readonly html: string
  readonly text: string
  readonly documentTitle: string | null
  readonly extractorVersion: string
}

export function extractMarkdownResult(result: MarkdownRenderResult): SourceExtraction {
  return {
    html: result.html,
    text: result.text,
    documentTitle: result.title,
    extractorVersion: EXTRACTOR_VERSION,
  }
}

export function extractHtmlSource(html: string): SourceExtraction {
  const document = parseHtml(html)
  let title: string | null = null
  const text: string[] = []
  const visit = (node: DefaultTreeAdapterTypes.Node, ignored: boolean): void => {
    const elementName = 'tagName' in node ? node.tagName : null
    const ignoreChildren = ignored || elementName === 'script' || elementName === 'style'
    if (!ignoreChildren && node.nodeName === '#text' && 'value' in node) {
      const value = node.value.replace(/\s+/gu, ' ').trim()
      if (value) text.push(value)
    }
    if (title === null && elementName === 'title' && 'childNodes' in node) {
      title = node.childNodes
        .filter((child): child is DefaultTreeAdapterTypes.TextNode => child.nodeName === '#text')
        .map((child) => child.value)
        .join('')
        .trim()
    }
    if ('childNodes' in node) {
      for (const child of node.childNodes) visit(child, ignoreChildren || elementName === 'title')
    }
    if (elementName === 'template' && 'content' in node) visit(node.content, ignoreChildren)
  }
  visit(document, false)
  return {
    html,
    text: text.join('\n'),
    documentTitle: normalizeTitle(title),
    extractorVersion: 'html-safe-text-1',
  }
}

function normalizeTitle(title: string | null | undefined): string | null {
  const normalized = title?.trim()
  return normalized ? normalized : null
}
