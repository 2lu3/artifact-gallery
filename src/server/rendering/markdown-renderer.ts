import MarkdownIt from 'markdown-it'
import {
  parseFragment,
  serialize,
  type DefaultTreeAdapterTypes,
} from 'parse5'

export interface MarkdownRenderResult {
  readonly html: string
  readonly text: string
  readonly title: string | null
}

export class MarkdownRenderError extends Error {
  readonly code = 'MARKDOWN_PARSE_FAILED' as const

  constructor(options?: ErrorOptions) {
    super('Markdown could not be parsed.', options)
    this.name = 'MarkdownRenderError'
  }
}

const ALLOWED_ELEMENTS = new Set([
  'a',
  'blockquote',
  'br',
  'code',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'ol',
  'p',
  'pre',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
])

const LINE_ELEMENTS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'pre'])

export class MarkdownRenderer {
  private readonly parser: MarkdownIt

  constructor() {
    this.parser = new MarkdownIt({
      html: false,
      linkify: false,
      typographer: false,
    })
    // Parse links into the AST first; the independent sanitizer below owns URL policy.
    this.parser.validateLink = () => true
  }

  render(markdown: string): MarkdownRenderResult {
    if (markdown.includes('\0')) throw new MarkdownRenderError()

    try {
      const document = sanitizeDocument(this.parser.render(markdown))
      return {
        html: serialize(document),
        text: extractDocumentText(document),
        title: firstHeadingText(document),
      }
    } catch (error) {
      if (error instanceof MarkdownRenderError) throw error
      throw new MarkdownRenderError({ cause: error })
    }
  }
}

function sanitizeDocument(html: string): DefaultTreeAdapterTypes.DocumentFragment {
  const document = parseFragment(html)
  sanitizeChildren(document)
  return document
}

function sanitizeChildren(parent: DefaultTreeAdapterTypes.ParentNode): void {
  const sanitized: DefaultTreeAdapterTypes.ChildNode[] = []
  for (const child of parent.childNodes) {
    if (!isElement(child)) {
      sanitized.push(child)
      continue
    }

    sanitizeChildren(child)
    if (!ALLOWED_ELEMENTS.has(child.tagName)) {
      for (const grandchild of child.childNodes) {
        grandchild.parentNode = parent
        sanitized.push(grandchild)
      }
      continue
    }

    child.attrs = sanitizeAttributes(child)
    sanitized.push(child)
  }
  parent.childNodes = sanitized
}

function sanitizeAttributes(
  element: DefaultTreeAdapterTypes.Element,
): DefaultTreeAdapterTypes.Element['attrs'] {
  if (element.tagName === 'a') {
    const href = element.attrs.find(({ name }) => name === 'href')?.value
    const safe = href === undefined ? null : safeHref(href)
    return safe === null ? [] : [{ name: 'href', value: safe }]
  }
  if (element.tagName === 'code') {
    const className = element.attrs.find(({ name }) => name === 'class')?.value
    return className && /^language-[a-z\d_-]+$/iu.test(className)
      ? [{ name: 'class', value: className }]
      : []
  }
  if (element.tagName === 'ol') {
    const start = element.attrs.find(({ name }) => name === 'start')?.value
    return start && /^\d+$/u.test(start) ? [{ name: 'start', value: start }] : []
  }
  return []
}

function safeHref(rawHref: string): string | null {
  const candidate = rawHref.trim()
  if (candidate.startsWith('#')) return candidate
  if (candidate === '' || candidate.startsWith('/') || candidate.startsWith('\\')) return null
  if (/^[a-z][a-z\d+.-]*:/iu.test(candidate) || candidate.startsWith('//')) return null

  let decoded = candidate
  for (let depth = 0; depth < 8; depth += 1) {
    const path = decoded.split(/[?#]/u, 1)[0] ?? ''
    if (path.split('/').includes('..') || decoded.includes('\\') || decoded.includes('\0')) {
      return null
    }
    try {
      const next = decodeURIComponent(decoded)
      if (next === decoded) return candidate
      decoded = next
    } catch {
      return null
    }
  }
  return null
}

function extractDocumentText(document: DefaultTreeAdapterTypes.DocumentFragment): string {
  const lines: string[] = []
  collectLines(document, lines)
  return lines
    .map((line) => normalizeExtractedLine(line))
    .filter(Boolean)
    .join('\n')
}

function collectLines(node: DefaultTreeAdapterTypes.ParentNode, lines: string[]): void {
  for (const child of node.childNodes) {
    if (!isElement(child)) continue

    if (child.tagName === 'table') {
      for (const row of descendantsWithTag(child, 'tr')) {
        const cells = row.childNodes.filter(
          (cell): cell is DefaultTreeAdapterTypes.Element =>
            isElement(cell) && (cell.tagName === 'th' || cell.tagName === 'td'),
        )
        lines.push(cells.map((cell) => nodeText(cell)).join('\t'))
      }
      continue
    }

    if (child.tagName === 'ul' || child.tagName === 'ol') {
      for (const item of child.childNodes) {
        if (isElement(item) && item.tagName === 'li') lines.push(nodeText(item))
      }
      continue
    }

    if (LINE_ELEMENTS.has(child.tagName)) {
      lines.push(nodeText(child))
      continue
    }

    collectLines(child, lines)
  }
}

function normalizeExtractedLine(value: string): string {
  return value
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n[ \t]+/gu, '\n')
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/\n+$/u, '')
    .trim()
}

function nodeText(node: DefaultTreeAdapterTypes.Node): string {
  if (node.nodeName === '#text' && 'value' in node) return node.value
  if (isElement(node) && node.tagName === 'br') return '\n'
  if (!('childNodes' in node)) return ''
  return node.childNodes.map((child) => nodeText(child)).join('')
}

function firstHeadingText(document: DefaultTreeAdapterTypes.DocumentFragment): string | null {
  const queue: DefaultTreeAdapterTypes.Node[] = [...document.childNodes]
  while (queue.length > 0) {
    const node = queue.shift()
    if (!node) break
    if (isElement(node) && node.tagName === 'h1') {
      const title = normalizeExtractedLine(nodeText(node))
      return title || null
    }
    if ('childNodes' in node) queue.unshift(...node.childNodes)
  }
  return null
}

function descendantsWithTag(
  root: DefaultTreeAdapterTypes.Element,
  tagName: string,
): DefaultTreeAdapterTypes.Element[] {
  const matches: DefaultTreeAdapterTypes.Element[] = []
  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    if (isElement(node) && node.tagName === tagName) matches.push(node)
    if ('childNodes' in node) {
      for (const child of node.childNodes) visit(child)
    }
  }
  visit(root)
  return matches
}

function isElement(node: DefaultTreeAdapterTypes.Node): node is DefaultTreeAdapterTypes.Element {
  return 'tagName' in node
}
