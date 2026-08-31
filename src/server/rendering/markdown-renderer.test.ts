import { describe, expect, it } from 'vitest'

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
    expect(result.html).toContain('<blockquote><p>Quoted note</p></blockquote>')
    expect(result.html).toContain('<ul><li>first</li><li>second</li></ul>')
    expect(result.html).toContain('<ol><li>ordered one</li><li>ordered two</li></ol>')
  })

  it('renders tables and fenced code with escaped content', () => {
    const result = renderer.render(`| Name | Value |
| --- | ---: |
| safe | <tag> |

\`\`\`ts
const value = "<safe>";
\`\`\``)

    expect(result.html).toContain(
      '<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>safe</td><td>&lt;tag&gt;</td></tr></tbody></table>',
    )
    expect(result.html).toContain(
      '<pre><code class="language-ts">const value = &quot;&lt;safe&gt;&quot;;</code></pre>',
    )
    expect(result.text).toBe('Name\tValue\nsafe\t<tag>\nconst value = "<safe>";')
  })

  it('disables raw HTML and strips active or external link capabilities', () => {
    const result = renderer.render(`<script>alert(1)</script>

<img src="https://tracker.invalid/pixel" onerror="steal()">

[script](javascript:alert(1)) [external](https://example.invalid/x) [anchor](#safe)`)

    expect(result.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(result.html).toContain(
      '&lt;img src=&quot;https://tracker.invalid/pixel&quot; onerror=&quot;steal()&quot;&gt;',
    )
    expect(result.html).toContain('<a>script</a>')
    expect(result.html).toContain('<a>external</a>')
    expect(result.html).toContain('<a href="#safe">anchor</a>')
    expect(result.html).not.toMatch(/<(script|img|iframe|embed|object)\b/i)
    expect(result.html).not.toContain('https://example.invalid')
  })

  it('rejects NUL input as a structured Markdown parse failure', () => {
    expect(() => renderer.render('before\0after')).toThrowError(
      expect.objectContaining({ code: 'MARKDOWN_PARSE_FAILED' }),
    )
  })
})
