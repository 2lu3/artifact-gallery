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

interface ParsedBlocks {
  readonly html: string[]
  readonly text: string[]
  readonly firstH1: string | null
}

interface InlineResult {
  readonly html: string
  readonly text: string
}

export class MarkdownRenderer {
  render(markdown: string): MarkdownRenderResult {
    if (markdown.includes('\0')) throw new MarkdownRenderError()

    try {
      const parsed = parseBlocks(markdown.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n'))
      return {
        html: parsed.html.join(''),
        text: parsed.text.join('\n'),
        title: parsed.firstH1,
      }
    } catch (error) {
      if (error instanceof MarkdownRenderError) throw error
      throw new MarkdownRenderError({ cause: error })
    }
  }
}

function parseBlocks(lines: readonly string[]): ParsedBlocks {
  const html: string[] = []
  const text: string[] = []
  let firstH1: string | null = null
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '') {
      index += 1
      continue
    }

    const fence = /^ {0,3}```\s*([\w-]*)\s*$/u.exec(line)
    if (fence) {
      const codeLines: string[] = []
      index += 1
      while (index < lines.length && !/^ {0,3}```\s*$/u.test(lines[index] ?? '')) {
        codeLines.push(lines[index] ?? '')
        index += 1
      }
      if (index < lines.length) index += 1
      const code = codeLines.join('\n')
      const language = fence[1]
      const className = language ? ` class="language-${escapeAttribute(language)}"` : ''
      html.push(`<pre><code${className}>${escapeHtml(code)}</code></pre>`)
      text.push(code)
      continue
    }

    const heading = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/u.exec(line)
    if (heading) {
      const level = heading[1]?.length ?? 1
      const content = (heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/u, '').trim()
      const inline = renderInline(content)
      html.push(`<h${level}>${inline.html}</h${level}>`)
      text.push(inline.text)
      if (level === 1 && firstH1 === null) firstH1 = inline.text
      index += 1
      continue
    }

    const nextLine = lines[index + 1]
    if (nextLine !== undefined && /^(?: {0,3})(?:=+|-+)\s*$/u.test(nextLine) && line.trim()) {
      const level = nextLine.trim().startsWith('=') ? 1 : 2
      const inline = renderInline(line.trim())
      html.push(`<h${level}>${inline.html}</h${level}>`)
      text.push(inline.text)
      if (level === 1 && firstH1 === null) firstH1 = inline.text
      index += 2
      continue
    }

    if (isTableHeader(lines, index)) {
      const headerCells = splitTableRow(line)
      const rows: string[][] = []
      index += 2
      while (index < lines.length && isTableDataRow(lines[index] ?? '')) {
        rows.push(splitTableRow(lines[index] ?? ''))
        index += 1
      }
      const renderedHeader = headerCells.map(renderInline)
      const renderedRows = rows.map((row) => row.map(renderInline))
      html.push(
        `<table><thead><tr>${renderedHeader.map((cell) => `<th>${cell.html}</th>`).join('')}</tr></thead>` +
          `<tbody>${renderedRows
            .map((row) => `<tr>${row.map((cell) => `<td>${cell.html}</td>`).join('')}</tr>`)
            .join('')}</tbody></table>`,
      )
      text.push(renderedHeader.map((cell) => cell.text).join('\t'))
      text.push(...renderedRows.map((row) => row.map((cell) => cell.text).join('\t')))
      continue
    }

    if (/^ {0,3}>/u.test(line)) {
      const quoteLines: string[] = []
      while (index < lines.length && /^ {0,3}>/u.test(lines[index] ?? '')) {
        quoteLines.push((lines[index] ?? '').replace(/^ {0,3}> ?/u, ''))
        index += 1
      }
      const quote = parseBlocks(quoteLines)
      html.push(`<blockquote>${quote.html.join('')}</blockquote>`)
      text.push(...quote.text)
      if (firstH1 === null) firstH1 = quote.firstH1
      continue
    }

    const listMatch = /^ {0,3}([-+*]|\d+[.)])[ \t]+(.+)$/u.exec(line)
    if (listMatch) {
      const ordered = /^\d/u.test(listMatch[1] ?? '')
      const items: InlineResult[] = []
      while (index < lines.length) {
        const item = /^ {0,3}([-+*]|\d+[.)])[ \t]+(.+)$/u.exec(lines[index] ?? '')
        if (!item || /^\d/u.test(item[1] ?? '') !== ordered) break
        items.push(renderInline(item[2] ?? ''))
        index += 1
      }
      const tag = ordered ? 'ol' : 'ul'
      html.push(`<${tag}>${items.map((item) => `<li>${item.html}</li>`).join('')}</${tag}>`)
      text.push(...items.map((item) => item.text))
      continue
    }

    const paragraphLines = [line.trim()]
    index += 1
    while (index < lines.length && !startsBlock(lines, index)) {
      paragraphLines.push((lines[index] ?? '').trim())
      index += 1
    }
    const inline = renderInline(paragraphLines.join(' '))
    html.push(`<p>${inline.html}</p>`)
    text.push(inline.text)
  }

  return { html, text, firstH1 }
}

function startsBlock(lines: readonly string[], index: number): boolean {
  const line = lines[index] ?? ''
  if (line.trim() === '') return true
  if (/^ {0,3}(?:```|#{1,6}(?:[ \t]+|$)|>|[-+*][ \t]+|\d+[.)][ \t]+)/u.test(line)) {
    return true
  }
  const next = lines[index + 1]
  return (
    (next !== undefined && /^(?: {0,3})(?:=+|-+)\s*$/u.test(next)) ||
    isTableHeader(lines, index)
  )
}

function isTableHeader(lines: readonly string[], index: number): boolean {
  const header = lines[index] ?? ''
  const delimiter = lines[index + 1]
  if (delimiter === undefined || !header.includes('|')) return false
  const cells = splitTableRow(delimiter)
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell))
}

function isTableDataRow(line: string): boolean {
  return line.trim() !== '' && line.includes('|')
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/u, '').replace(/\|$/u, '')
  return trimmed.split(/(?<!\\)\|/u).map((cell) => cell.trim().replaceAll('\\|', '|'))
}

function renderInline(source: string): InlineResult {
  let html = ''
  let text = ''
  let index = 0

  while (index < source.length) {
    if (source[index] === '\\' && index + 1 < source.length) {
      const character = source[index + 1] ?? ''
      html += escapeHtml(character)
      text += character
      index += 2
      continue
    }

    const code = /^`([^`]+)`/u.exec(source.slice(index))
    if (code) {
      const content = code[1] ?? ''
      html += `<code>${escapeHtml(content)}</code>`
      text += content
      index += code[0].length
      continue
    }

    const link = /^\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/u.exec(source.slice(index))
    if (link) {
      const label = renderInline(link[1] ?? '')
      const href = safeHref(link[2] ?? '')
      html += href === null ? `<a>${label.html}</a>` : `<a href="${escapeAttribute(href)}">${label.html}</a>`
      text += label.text
      index += link[0].length
      continue
    }

    const strong = /^(?:\*\*|__)(.+?)(?:\*\*|__)/u.exec(source.slice(index))
    if (strong) {
      const content = renderInline(strong[1] ?? '')
      html += `<strong>${content.html}</strong>`
      text += content.text
      index += strong[0].length
      continue
    }

    const emphasis = /^(?:\*|_)([^*_]+?)(?:\*|_)/u.exec(source.slice(index))
    if (emphasis) {
      const content = renderInline(emphasis[1] ?? '')
      html += `<em>${content.html}</em>`
      text += content.text
      index += emphasis[0].length
      continue
    }

    const specialIndex = nextInlineSpecial(source, index + 1)
    const end = specialIndex === -1 ? source.length : specialIndex
    const literal = source.slice(index, end)
    html += escapeHtml(literal)
    text += literal
    index = end
  }

  return { html, text }
}

function nextInlineSpecial(source: string, start: number): number {
  for (let index = start; index < source.length; index += 1) {
    if ('\\`[*_'.includes(source[index] ?? '')) return index
  }
  return -1
}

function safeHref(rawHref: string): string | null {
  const candidate = rawHref.trim()
  if (candidate.startsWith('#')) return candidate
  if (candidate === '' || candidate.startsWith('/') || candidate.startsWith('\\')) return null
  if (/^[a-z][a-z\d+.-]*:/iu.test(candidate) || candidate.startsWith('//')) return null
  let decoded = candidate
  for (let depth = 0; depth < 8; depth += 1) {
    const path = decoded.split(/[?#]/u, 1)[0] ?? ''
    if (path.split('/').includes('..') || decoded.includes('\\') || decoded.includes('\0')) return null
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

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function escapeAttribute(value: string): string {
  return escapeHtml(value)
}
