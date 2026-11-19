import { ClientControlError } from './errors.js'

function unsupported(reason) {
  // Never attach source text to diagnostics: the caller may persist the error.
  throw new ClientControlError(`Unsupported Windows reply view: ${reason}`, {
    code: 'UNSUPPORTED_REPLY_VIEW'
  })
}

function normalize(text) {
  // Match existing display Normalize without importing session/log readers.
  return text.replace(/\s+/g, ' ').trim()
}

function isWord(character) {
  return Boolean(character && /[\p{L}\p{N}]/u.test(character))
}

function codeEnd(text, start) {
  if (text[start + 1] === '`') unsupported('complex code span delimiter')
  const end = text.indexOf('`', start + 1)
  if (end < 0 || text[end + 1] === '`') unsupported('unclosed or complex code span')
  const body = text.slice(start + 1, end)
  // CommonMark trims padded spans specially; decline rather than erase whitespace.
  if (/^\s[\s\S]*\s$/.test(body)) unsupported('padded code span')
  return end
}

function simpleLink(text, start) {
  let close = start + 1
  for (; close < text.length && text[close] !== ']'; close += 1) {
    if (text[close] === '`') close = codeEnd(text, close)
    else if (text[close] === '[') unsupported('complex link label')
  }
  if (close === text.length) {
    if (text.slice(start).includes('(')) unsupported('unclosed link label')
    return null
  }
  if (text[close + 1] !== '(') return null
  const end = text.indexOf(')', close + 2)
  if (end < 0) unsupported('unclosed link destination')
  let destination = text.slice(close + 2, end)
  if (destination.startsWith('<') && destination.endsWith('>')) {
    destination = destination.slice(1, -1)
  }
  if (!destination || /[\s()<>\\`"'\[\]]/.test(destination)) {
    unsupported('complex link destination')
  }
  const label = text.slice(start + 1, close)
  if (!label.trim()) unsupported('empty link label')
  // Validate only syntax boundaries. Never expose/execute the destination or claim identity.
  return { label, end: end + 1 }
}

function emphasisEnd(text, start, delimiter, linkLabels) {
  for (let index = start + delimiter.length; index < text.length; index += 1) {
    if (text[index] === '`') {
      index = codeEnd(text, index)
      continue
    }
    if (linkLabels && text[index] === '[') {
      const link = simpleLink(text, index)
      if (link) {
        index = link.end - 1
        continue
      }
    }
    if (!text.startsWith(delimiter, index)) continue
    const before = text[index - 1]
    const after = text[index + delimiter.length]
    if (delimiter === '*' && (text[index + 1] === '*' || before === '*')) continue
    if (delimiter === '_' && isWord(after)) continue
    if (/\s/.test(before)) unsupported('ambiguous emphasis boundary')
    return index
  }
  unsupported('unclosed emphasis')
}

function inlineText(text, linkLabels = false, depth = 0) {
  if (depth > 16) unsupported('excessive inline nesting')
  let result = ''
  for (let index = 0; index < text.length;) {
    const character = text[index]
    const rest = text.slice(index)
    if (character === '`') {
      const end = codeEnd(text, index)
      result += text.slice(index + 1, end)
      index = end + 1
      continue
    }
    if (linkLabels && character === '[') {
      const link = simpleLink(text, index)
      if (link) {
        // Labels use the existing inline rules; nested links remain unsupported.
        result += inlineText(link.label, false, depth + 1)
        index = link.end
        continue
      }
    }
    if (character === '<' || character === '$' || character === '|'
      || rest.startsWith('![') || rest.startsWith('~~')
      || (character === '&' && /^&(?:#\d+|#[xX][\da-fA-F]+|[a-zA-Z][\da-zA-Z]+);/.test(rest))
      || (character === '[' && (/\][ \t]*(?:\(|\[)/.test(rest) || rest.startsWith('[^')))
      || (character === '\\' && (!text[index + 1] || /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(text[index + 1])))) {
      unsupported('non-text inline syntax')
    }
    if (character === '*' || character === '_') {
      const run = rest.match(/^(\*+|_+)/)[0]
      if (run.length > 2 || run === '__') unsupported('complex emphasis')
      // Intraword underscores are filenames/plain text, never guessed as emphasis.
      if (character === '_' && isWord(text[index - 1])) {
        result += run
        index += run.length
        continue
      }
      if (run.length === 1 && (!text[index + 1] || /\s/.test(text[index + 1]))) {
        result += character
        index += 1
        continue
      }
      if (/\s/.test(text[index + run.length] ?? ' ')) unsupported('ambiguous emphasis boundary')
      const end = emphasisEnd(text, index, run, linkLabels)
      const body = text.slice(index + run.length, end)
      if (!body || text[end + run.length] === character) unsupported('complex emphasis')
      result += inlineText(body, linkLabels, depth + 1)
      index = end + run.length
      continue
    }
    result += character
    index += 1
  }
  return result
}

function thematicRule(body) {
  return /^(?:-{3,}|\*{3,}|_{3,})$/.test(body.replace(/[ \t]/g, ''))
}

function listMarker(body, indent) {
  const match = body.match(/^([-+*]|\d{1,9}\.)(?:([ ]+)(.*)|$)/)
  if (!match) {
    if (/^(?:\d+[.)]|[-+*])[ \t]+/.test(body)) unsupported('unsupported list marker')
    return null
  }
  const padding = match[2] ?? ' '
  if (padding.length > 4 || match[3]?.startsWith('\t')) {
    unsupported('indented list code or ambiguous marker padding')
  }
  const ordered = match[1].endsWith('.')
  return {
    indent,
    contentIndent: indent + match[1].length + padding.length,
    kind: ordered ? 'ordered' : 'unordered',
    bullet: ordered ? '.' : match[1],
    ordinal: ordered ? Number(match[1].slice(0, -1)) : null,
    body: match[3] ?? ''
  }
}

/**
 * Project a deliberately limited Markdown source into the Windows display contract.
 * Pure and memory-only: no session access, UI actions, logging, or request-state writes.
 * Ordered source numbering sets the list start; later markers display start + index.
 * Ambiguous/lazy continuation and code blocks fail closed instead of losing content.
 * linkLabels is an explicit visible-body mode, matching renderedText's label-only boundary;
 * it does not prove destinations or select a control target. Strict is the default.
 */
export function projectWindowsReplyView(markdown, { linkLabels = false } = {}) {
  if (typeof linkLabels !== 'boolean') unsupported('unknown display mode')
  if (typeof markdown !== 'string') unsupported('source must be a string')
  const tokens = []
  const stack = []
  const root = {}
  let blank = true
  let previousParagraph = null

  function closeList() {
    const frame = stack.pop()
    tokens.push({ type: 'item_end', depth: frame.depth })
    tokens.push({ type: 'list_end', depth: frame.depth })
  }

  function displayBlock(body, scope) {
    if (/^(?:`{3,}|~{3,}|>|\[[^\]]+\]:|\[[ xX]\](?:\s|$))/.test(body)
      || /^=+[ \t]*$/.test(body) || /^#{7,}(?:\s|$)/.test(body)) {
      unsupported('unsupported block syntax')
    }
    if (thematicRule(body)) {
      if (/^-+[ \t]*$/.test(body) && previousParagraph === scope) {
        unsupported('ambiguous setext heading')
      }
      tokens.push({ type: 'rule' })
      previousParagraph = null
      return
    }
    const heading = body.match(/^#{1,6}(?:[ \t]+(.*)|$)/)
    const content = heading ? (heading[1] ?? '').replace(/(?:^|[ \t]+)#+[ \t]*$/, '') : body
    // Join inline pieces before normalization: file**.**cs stays file.cs, not file . cs.
    const text = normalize(inlineText(content, linkLabels))
    if (text) {
      const previous = tokens.at(-1)
      if (previous?.type === 'text') previous.text += ` ${text}`
      else tokens.push({ type: 'text', text })
    }
    previousParagraph = heading || !text ? null : scope
  }

  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) {
      blank = true
      previousParagraph = null
      continue
    }
    const indent = line.match(/^ */)[0].length
    const body = line.slice(indent)
    if (body.startsWith('\t')) unsupported('tab indentation')
    const rule = thematicRule(body)
    const marker = rule ? null : listMarker(body, indent)

    if (marker) {
      // Dedent closes children, never discards their items or repeated text.
      let dedented = false
      while (stack.length && marker.indent < stack.at(-1).indent) {
        if (stack.length === 1) unsupported('inconsistent root list indentation')
        closeList()
        dedented = true
      }
      let frame = stack.at(-1)
      if (frame && marker.indent > frame.indent) {
        if (dedented || marker.indent < frame.contentIndent || marker.indent >= frame.contentIndent + 4) {
          unsupported('ambiguous nested list indentation')
        }
        if (!blank && previousParagraph === frame
          && ((marker.kind === 'ordered' && marker.ordinal !== 1) || !marker.body)) {
          unsupported('nested list cannot interrupt paragraph')
        }
        frame = null
      } else if (frame) {
        if (marker.kind !== frame.kind || marker.bullet !== frame.bullet) {
          closeList()
          frame = null
        } else {
          tokens.push({ type: 'item_end', depth: frame.depth })
          frame.contentIndent = marker.contentIndent
        }
      } else {
        if (marker.indent > 3) unsupported('indented code block')
        if (!blank && previousParagraph === root
          && (marker.ordinal !== null && marker.ordinal !== 1 || !marker.body)) {
          unsupported('list cannot interrupt paragraph')
        }
      }
      if (!frame) {
        frame = { ...marker, depth: stack.length, nextOrdinal: marker.ordinal }
        stack.push(frame)
        tokens.push({ type: 'list_start', kind: frame.kind, depth: frame.depth })
      }
      tokens.push({ type: 'item_start', depth: frame.depth, ordinal: frame.nextOrdinal })
      if (frame.kind === 'ordered') frame.nextOrdinal += 1
      previousParagraph = null
      displayBlock(marker.body, frame)
      blank = false
      continue
    }

    // Only explicit content indentation proves a continuation belongs to an item.
    while (stack.length && indent < stack.at(-1).contentIndent) {
      if (!blank && !rule && !/^#{1,6}(?:\s|$)/.test(body)) {
        unsupported('lazy or ambiguous list continuation')
      }
      closeList()
    }
    const scope = stack.at(-1) ?? root
    const relativeIndent = indent - (scope === root ? 0 : scope.contentIndent)
    if (relativeIndent >= 4) unsupported('indented code block')
    // Up to three syntactic indentation spaces do not hide a heading/unsupported block.
    displayBlock(body, scope)
    blank = false
  }
  while (stack.length) closeList()
  return tokens
}
