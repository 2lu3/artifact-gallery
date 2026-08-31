import { describe, expect, it } from 'vitest'
import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5'

import { MarkdownRenderer } from './markdown-renderer.js'

const renderer = new MarkdownRenderer()

describe('MarkdownRenderer', () => {
  it('extracts the first H1 and renders CommonMark containers and inline emphasis', () => {
    const result = renderer.render(`# Gallery title

Intro with **strong**, *emphasis*, and [a local link](./details.html).

> Quoted note

- first
- second

1. ordered one
2. ordered two`)

    expect(result.title).toBe('Gallery title')
    expect(result.text).toBe(
      'Gallery title\nIntro with strong, emphasis, and a local link.\nQuoted note\nfirst\nsecond\nordered one\nordered two',
    )
    expect(result.html).toContain('<h1>Gallery title</h1>')
    expect(result.html).toContain('<strong>strong</strong>')
    expect(result.html).toContain('<em>emphasis</em>')
    expect(result.html).toContain('<a href="./details.html">a local link</a>')
    const compact = compactElementWhitespace(result.html)
    expect(compact).toContain('<blockquote><p>Quoted note</p></blockquote>')
    expect(compact).toContain('<ul><li>first</li><li>second</li></ul>')
    expect(compact).toContain('<ol><li>ordered one</li><li>ordered two</li></ol>')
  })

  it('renders tables and fenced code with escaped content', () => {
    const result = renderer.render(`| Name | Value |
| --- | ---: |
| safe | <tag> |

\`\`\`ts
const value = "<safe>";
\`\`\``)

    expect(compactElementWhitespace(result.html)).toContain(
      '<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>safe</td><td>&lt;tag&gt;</td></tr></tbody></table>',
    )
    expect(result.html).toContain(
      '<pre><code class="language-ts">const value = "&lt;safe&gt;";\n</code></pre>',
    )
    expect(result.text).toBe('Name\tValue\nsafe\t<tag>\nconst value = "<safe>";')
  })

  it('supports CommonMark list continuations, tilde fences, and indented code blocks', () => {
    const result = renderer.render(`- first line
  continued line
- second item

~~~js
const fenced = "safe";
~~~

    const indented = true;`)

    expect(result.html).toMatch(/<li>first line\s+continued line<\/li>/u)
    expect(result.html).toContain('<li>second item</li>')
    expect(result.html).toContain(
      '<pre><code class="language-js">const fenced = "safe";\n</code></pre>',
    )
    expect(result.html).toContain(
      '<pre><code>const indented = true;\n</code></pre>',
    )
    expect(result.text).toContain('first line\ncontinued line')
    expect(result.text).toContain('const fenced = "safe";')
    expect(result.text).toContain('const indented = true;')
  })

  it('disables raw HTML and strips active or external link capabilities', () => {
    const result = renderer.render(`<script>alert(1)</script>

<img src="https://tracker.invalid/pixel" onerror="steal()">

[script](javascript:alert(1)) [external](https://example.invalid/x) [anchor](#safe)`)

    expect(result.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(result.html).toContain(
      '&lt;img src="https://tracker.invalid/pixel" onerror="steal()"&gt;',
    )
    expect(result.html).toContain('<a>script</a>')
    expect(result.html).toContain('<a>external</a>')
    expect(result.html).toContain('<a href="#safe">anchor</a>')
    expect(result.html).not.toMatch(/<(script|img|iframe|embed|object)\b/i)
    expect(result.html).not.toContain('https://example.invalid')
    expect(elementNames(result.html)).toEqual(['p', 'p', 'p', 'a', 'a', 'a'])
  })

  it('rejects NUL input as a structured Markdown parse failure', () => {
    expect(() => renderer.render('before\0after')).toThrowError(
      expect.objectContaining({ code: 'MARKDOWN_PARSE_FAILED' }),
    )
  })
})

function compactElementWhitespace(html: string): string {
  return html.replace(/>\s+</gu, '><').trim()
}

function elementNames(html: string): string[] {
  const names: string[] = []
  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    if ('tagName' in node) names.push(node.tagName)
    if ('childNodes' in node) {
      for (const child of node.childNodes) visit(child)
    }
  }
  visit(parseFragment(html))
  return names
}
