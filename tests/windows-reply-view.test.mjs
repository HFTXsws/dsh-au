import assert from 'node:assert/strict'
import test from 'node:test'
import { ClientControlError } from '../lib/client-control/errors.js'
import { projectWindowsReplyView } from '../lib/client-control/windows-reply-view.js'

// These expected tokens are hand-authored display contracts, not another parser's output.
const textCases = [
  {
    name: 'adjacent inline decoration never inserts spaces into filenames',
    source: 'file**.**cs(-1) **粗体**，_斜体_/*italic*；`a_b.cs`🙂',
    expected: [{ type: 'text', text: 'file.cs(-1) 粗体，斜体/italic；a_b.cs🙂' }]
  },
  {
    name: 'minus signs quotes emoji and bare paths remain exact display text',
    source: '"-1"、“负数 -42”，foo-bar.cs /tmp/a_b.cs C:\\work\\file.cs https://example.test/a-b?q=-1 🧑🏽‍💻🚀',
    expected: [{ type: 'text', text: '"-1"、“负数 -42”，foo-bar.cs /tmp/a_b.cs C:\\work\\file.cs https://example.test/a-b?q=-1 🧑🏽‍💻🚀' }]
  },
  {
    name: 'headings paragraphs and soft lines merge only at display block boundaries',
    source: '  # 标题 **一** #\r\n\r\n段落\t甲\r\n继续\r\n\r\n   ### ###\r\n## 标题二\r\n结尾\u00a0 🙂',
    expected: [{ type: 'text', text: '标题 一 段落 甲 继续 标题二 结尾 🙂' }]
  },
  {
    name: 'code span protects markdown-looking paths and keeps inline adjacency',
    source: 'pre`a**b**_[x](url)|$x$`post，**x _y_ z**',
    expected: [{ type: 'text', text: 'prea**b**_[x](url)|$x$post，x y z' }]
  },
  {
    name: 'empty whitespace produces no text token',
    source: ' \t\r\n\u00a0\n',
    expected: []
  }
]

for (const { name, source, expected } of textCases) {
  test(name, () => assert.deepEqual(projectWindowsReplyView(source), expected))
}

test('ordered and unordered lists preserve depth ordinal sequence and repeated bodies', () => {
  const source = '7. same\n8. same\n   - child\n     + child\n   - child\n9. final\n\n- same\n- same'
  assert.deepEqual(projectWindowsReplyView(source), [
    { type: 'list_start', kind: 'ordered', depth: 0 },
    { type: 'item_start', depth: 0, ordinal: 7 },
    { type: 'text', text: 'same' },
    { type: 'item_end', depth: 0 },
    { type: 'item_start', depth: 0, ordinal: 8 },
    { type: 'text', text: 'same' },
    { type: 'list_start', kind: 'unordered', depth: 1 },
    { type: 'item_start', depth: 1, ordinal: null },
    { type: 'text', text: 'child' },
    { type: 'list_start', kind: 'unordered', depth: 2 },
    { type: 'item_start', depth: 2, ordinal: null },
    { type: 'text', text: 'child' },
    { type: 'item_end', depth: 2 },
    { type: 'list_end', depth: 2 },
    { type: 'item_end', depth: 1 },
    { type: 'item_start', depth: 1, ordinal: null },
    { type: 'text', text: 'child' },
    { type: 'item_end', depth: 1 },
    { type: 'list_end', depth: 1 },
    { type: 'item_end', depth: 0 },
    { type: 'item_start', depth: 0, ordinal: 9 },
    { type: 'text', text: 'final' },
    { type: 'item_end', depth: 0 },
    { type: 'list_end', depth: 0 },
    { type: 'list_start', kind: 'unordered', depth: 0 },
    { type: 'item_start', depth: 0, ordinal: null },
    { type: 'text', text: 'same' },
    { type: 'item_end', depth: 0 },
    { type: 'item_start', depth: 0, ordinal: null },
    { type: 'text', text: 'same' },
    { type: 'item_end', depth: 0 },
    { type: 'list_end', depth: 0 }
  ])
})

test('empty repeated list items keep their boundaries without manufacturing empty text', () => {
  assert.deepEqual(projectWindowsReplyView('-\n-'), [
    { type: 'list_start', kind: 'unordered', depth: 0 },
    { type: 'item_start', depth: 0, ordinal: null },
    { type: 'item_end', depth: 0 },
    { type: 'item_start', depth: 0, ordinal: null },
    { type: 'item_end', depth: 0 },
    { type: 'list_end', depth: 0 }
  ])
})

test('repeated source ordered markers use the rendered sequence rather than source numbering', () => {
  assert.deepEqual(projectWindowsReplyView('1. a\n1. b'), [
    { type: 'list_start', kind: 'ordered', depth: 0 },
    { type: 'item_start', depth: 0, ordinal: 1 },
    { type: 'text', text: 'a' },
    { type: 'item_end', depth: 0 },
    { type: 'item_start', depth: 0, ordinal: 2 },
    { type: 'text', text: 'b' },
    { type: 'item_end', depth: 0 },
    { type: 'list_end', depth: 0 }
  ])
})

test('explicitly indented item continuations and paragraphs retain all text around children', () => {
  assert.deepEqual(projectWindowsReplyView('- first\n  continued **word**\n\n  another paragraph\n\n  3. nested\n\n  tail\n- second\n\noutside'), [
    { type: 'list_start', kind: 'unordered', depth: 0 },
    { type: 'item_start', depth: 0, ordinal: null },
    { type: 'text', text: 'first continued word another paragraph' },
    { type: 'list_start', kind: 'ordered', depth: 1 },
    { type: 'item_start', depth: 1, ordinal: 3 },
    { type: 'text', text: 'nested' },
    { type: 'item_end', depth: 1 },
    { type: 'list_end', depth: 1 },
    { type: 'text', text: 'tail' },
    { type: 'item_end', depth: 0 },
    { type: 'item_start', depth: 0, ordinal: null },
    { type: 'text', text: 'second' },
    { type: 'item_end', depth: 0 },
    { type: 'list_end', depth: 0 },
    { type: 'text', text: 'outside' }
  ])
})

test('changing unordered bullet or list kind starts a distinct list without deduplication', () => {
  assert.deepEqual(projectWindowsReplyView('- same\n* same\n+ same\n1. same'), [
    { type: 'list_start', kind: 'unordered', depth: 0 },
    { type: 'item_start', depth: 0, ordinal: null },
    { type: 'text', text: 'same' },
    { type: 'item_end', depth: 0 },
    { type: 'list_end', depth: 0 },
    { type: 'list_start', kind: 'unordered', depth: 0 },
    { type: 'item_start', depth: 0, ordinal: null },
    { type: 'text', text: 'same' },
    { type: 'item_end', depth: 0 },
    { type: 'list_end', depth: 0 },
    { type: 'list_start', kind: 'unordered', depth: 0 },
    { type: 'item_start', depth: 0, ordinal: null },
    { type: 'text', text: 'same' },
    { type: 'item_end', depth: 0 },
    { type: 'list_end', depth: 0 },
    { type: 'list_start', kind: 'ordered', depth: 0 },
    { type: 'item_start', depth: 0, ordinal: 1 },
    { type: 'text', text: 'same' },
    { type: 'item_end', depth: 0 },
    { type: 'list_end', depth: 0 }
  ])
})

test('standalone thematic breaks are structural while inline hyphens remain literal', () => {
  assert.deepEqual(projectWindowsReplyView('literal --- and `---`\n\n---\n\n***\n\n_ _ _\n\n- item\n\n  ---\n\n  after'), [
    { type: 'text', text: 'literal --- and ---' },
    { type: 'rule' },
    { type: 'rule' },
    { type: 'rule' },
    { type: 'list_start', kind: 'unordered', depth: 0 },
    { type: 'item_start', depth: 0, ordinal: null },
    { type: 'text', text: 'item' },
    { type: 'rule' },
    { type: 'text', text: 'after' },
    { type: 'item_end', depth: 0 },
    { type: 'list_end', depth: 0 }
  ])
})

const linkDisplayCases = [
  {
    name: 'explicit label mode keeps inline filename adjacency and omits the destination',
    source: '前[file**.**cs(-1)](./hidden-target.cs)后🙂',
    expected: [{ type: 'text', text: '前file.cs(-1)后🙂' }]
  },
  {
    name: 'explicit label mode preserves inline code paths within list structure',
    source: '- [`C:\\work\\file[0].cs`](<F:/hidden-target.cs#L2>)\n  continued **text**',
    expected: [
      { type: 'list_start', kind: 'unordered', depth: 0 },
      { type: 'item_start', depth: 0, ordinal: null },
      { type: 'text', text: 'C:\\work\\file[0].cs continued text' },
      { type: 'item_end', depth: 0 },
      { type: 'list_end', depth: 0 }
    ]
  }
]

for (const { name, source, expected } of linkDisplayCases) {
  test(name, () => assert.deepEqual(projectWindowsReplyView(source, { linkLabels: true }), expected))
}

const invalidLinkModes = [
  ['unclosed link destination', '[file](./hidden-target.cs', { linkLabels: true }],
  ['unclosed link label', '[file(./hidden-target.cs)', { linkLabels: true }],
  ['link title', '[file](./hidden-target.cs "title")', { linkLabels: true }],
  ['nested destination parentheses', '[file](./target(a).cs)', { linkLabels: true }],
  ['escaped destination', '[file](./target\\).cs)', { linkLabels: true }],
  ['empty destination', '[file]()', { linkLabels: true }],
  ['nested label', '[outer [inner]](./hidden-target.cs)', { linkLabels: true }],
  ['HTML label', '[<b>file</b>](./hidden-target.cs)', { linkLabels: true }],
  ['escaped label', '[file\\*](./hidden-target.cs)', { linkLabels: true }],
  ['reference link in label mode', '[file][ref]', { linkLabels: true }],
  ['explicit strict mode link', '[file](./hidden-target.cs)', { linkLabels: false }],
  ['unknown display mode', 'plain text', { linkLabels: 'labels' }]
]

for (const [name, source, options] of invalidLinkModes) {
  test(`${name} still fails closed in explicit display modes`, () => {
    assert.throws(() => projectWindowsReplyView(source, options), (error) => {
      assert.ok(error instanceof ClientControlError)
      assert.equal(error.code, 'UNSUPPORTED_REPLY_VIEW')
      assert.equal(error.message.includes('hidden-target'), false)
      return true
    })
  })
}

const unsupportedCases = [
  ['fenced code', '```js\n  x()\n```'],
  ['tilde fence', '~~~\ntext\n~~~'],
  ['indented code', '    x()'],
  ['tab indented code', '\tx()'],
  ['code inside list', '- item\n      x()'],
  ['table', '| a | b |\n| --- | --- |'],
  ['HTML', '<span>text</span>'],
  ['HTML entity', 'a &amp; b'],
  ['math', '$x+y$'],
  ['markdown escape', 'a\\*b'],
  ['unproven link destination', '[file](./a.cs)'],
  ['reference link', '[file][ref]'],
  ['image', '![alt](image.png)'],
  ['reference definition', '[ref]: https://example.test'],
  ['blockquote', '> text'],
  ['strikethrough', '~~text~~'],
  ['task item', '- [ ] task'],
  ['unclosed emphasis', '**text'],
  ['ambiguous combined emphasis', '***text***'],
  ['unclosed code span', 'a `code'],
  ['complex code delimiter', '``code``'],
  ['padded code span', 'a` code `b'],
  ['setext heading', 'text\n---'],
  ['setext equals heading', 'text\n==='],
  ['lazy item continuation', '- item\nunindented continuation'],
  ['misaligned nesting', '1. item\n  - child'],
  ['indented top level list', '    - item'],
  ['oversized ordered marker', '1234567890. item'],
  ['indented blockquote', '   > text'],
  ['indented reference definition', '  [ref]: destination'],
  ['tab after marker padding', '- \ttext'],
  ['indented setext heading', 'text\n ---'],
  ['ordered paragraph interruption', 'text\n7. item'],
  ['empty nested paragraph interruption', '- item\n  -'],
  ['nested lazy continuation', '- outer\n  - child\n  ambiguous tail'],
  ['inconsistent nested indentation', '- outer\n    - child\n   - ambiguous sibling']
]

for (const [name, source] of unsupportedCases) {
  test(`${name} fails closed instead of dropping or guessing content`, () => {
    assert.throws(() => projectWindowsReplyView(source), (error) => {
      assert.ok(error instanceof ClientControlError)
      assert.equal(error.code, 'UNSUPPORTED_REPLY_VIEW')
      // Diagnostics must not echo even synthetic source text into persisted logs.
      assert.equal(error.message.includes(source), false)
      return true
    })
  })
}
