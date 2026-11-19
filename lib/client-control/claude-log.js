import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { ClientControlError, assertControl } from './errors.js'

export function textContent(message = {}) {
  const content = message.content ?? []
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

export function isMainHuman(record) {
  const content = record?.message?.content ?? []
  const hasToolResult = Array.isArray(content)
    && content.some((block) => block?.type === 'tool_result')
  return record?.type === 'user'
    && record?.message?.role === 'user'
    && !record?.isSidechain
    && !hasToolResult
}

export function loadClaudeLog(filePath) {
  const raw = readFileSync(filePath)
  const finalNewline = raw.lastIndexOf(0x0a)
  const complete = finalNewline < 0 ? Buffer.alloc(0) : raw.subarray(0, finalNewline + 1)
  const nodes = new Map()
  const records = []

  for (const [index, line] of complete.toString('utf8').split(/\n/).entries()) {
    if (!line.trim()) continue
    let record
    try {
      record = JSON.parse(line)
    } catch (cause) {
      throw new ClientControlError(`Invalid complete JSONL record at line ${index + 1}`, {
        code: 'INVALID_LOG',
        cause
      })
    }
    assertControl(record && typeof record === 'object' && !Array.isArray(record),
      `Non-object JSONL record at line ${index + 1}`, 'INVALID_LOG')
    if (record.uuid) {
      const existing = nodes.get(record.uuid)
      if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new ClientControlError(`Conflicting duplicate record UUID: ${record.uuid}`, {
          code: 'INVALID_LOG'
        })
      }
      if (!existing) nodes.set(record.uuid, record)
    }
    records.push(record)
  }
  return { raw, nodes, records }
}

function chainTo(nodes, leafUuid, userUuid) {
  const reverse = []
  const seen = new Set()
  let cursor = leafUuid
  while (cursor && nodes.has(cursor)) {
    if (seen.has(cursor)) {
      throw new ClientControlError('Cycle in conversation parentUuid chain', { code: 'INVALID_LOG' })
    }
    seen.add(cursor)
    const record = nodes.get(cursor)
    if (record.isSidechain) return null
    reverse.push(record)
    if (cursor === userUuid) return reverse.reverse()
    if (isMainHuman(record)) return null
    cursor = record.parentUuid
  }
  return null
}

// Use the same uniquely completed chain for raw replies and UI identity metadata.
export function completedReplyChain(nodes, userUuid, { requireCheckpoint = true } = {}) {
  assertControl(nodes.has(userUuid) && isMainHuman(nodes.get(userUuid)),
    'Target UUID is not a main-chain human user message', 'INVALID_TARGET')
  const completed = []

  for (const [uuid, record] of nodes) {
    const checkpoint = record.type === 'system'
      && record.subtype === 'stop_hook_summary'
      && record.preventedContinuation === false
    const terminal = !requireCheckpoint
      && record.type === 'assistant'
      && record.message?.stop_reason === 'end_turn'
    if (!checkpoint && !terminal) continue
    const chain = chainTo(nodes, uuid, userUuid)
    if (!chain) continue
    const assistants = chain.filter((item) => item.type === 'assistant'
      && item.message?.role === 'assistant')
    if (assistants.length && assistants.at(-1).message?.stop_reason === 'end_turn') {
      completed.push(chain)
    }
  }

  const leaves = completed.filter((chain) => !completed.some((other) => other !== chain
    && other.slice(0, -1).some((item) => item.uuid === chain.at(-1).uuid)))
  if (!leaves.length) return null
  assertControl(leaves.length === 1,
    'Ambiguous terminal reply branches; no text was selected', 'AMBIGUOUS_REPLY')
  return leaves[0]
}

export function replyFor(nodes, userUuid, options) {
  const chain = completedReplyChain(nodes, userUuid, options)
  if (chain === null) return null
  return chain
    .filter((item) => item.type === 'assistant' && item.message?.role === 'assistant')
    .map((item) => textContent(item.message))
    .join('')
}

export function latestHuman(records) {
  const users = records.filter(isMainHuman)
  assertControl(users.length > 0, 'No human turn found in the specified session log', 'NO_HUMAN_TURN')
  return users.at(-1)
}

export function viewNormalize(value) {
  return String(value).replace(/\s+/g, ' ').trim()
}

export function renderedText(value) {
  return viewNormalize(String(value)
    .replace(/^\s*(?:\d+\.\s+|#{1,6}\s+|>\s?)/gm, '')
    .replace(/^```[^\n]*\n?/gm, '')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replaceAll('**', '')
    .replaceAll('`', ''))
}

export function verifyClaudeSource(filePath) {
  const absolutePath = resolve(filePath)
  const { raw, nodes, records } = loadClaudeLog(absolutePath)
  const sessionId = basename(absolutePath, '.jsonl')
  const user = latestHuman(records)
  assertControl(user.sessionId === sessionId,
    'Session log filename and user sessionId disagree', 'SESSION_MISMATCH')
  const reply = replyFor(nodes, user.uuid)
  assertControl(reply !== null,
    'Previous turn is not complete; do not send another request', 'INCOMPLETE_TURN')

  const signature = [viewNormalize(textContent(user.message)), renderedText(reply)]
  for (const name of readdirSync(dirname(absolutePath))) {
    if (!name.endsWith('.jsonl')) continue
    const siblingPath = resolve(dirname(absolutePath), name)
    if (siblingPath === absolutePath) continue
    const sibling = loadClaudeLog(siblingPath)
    const siblingUsers = sibling.records.filter(isMainHuman)
    if (!siblingUsers.length) continue
    const siblingUser = siblingUsers.at(-1)
    // A fork can copy the human UUID. Do not let the raw UIA anchor certify two sessions,
    // even if their prompt or eventual reply was edited and their text signatures differ.
    assertControl(siblingUser.uuid !== user.uuid,
      'Sibling session shares the latest human UUID; UI identity is ambiguous', 'AMBIGUOUS_SESSION')
    if (viewNormalize(textContent(siblingUser.message)) !== signature[0]) continue
    const siblingReply = replyFor(sibling.nodes, siblingUser.uuid, { requireCheckpoint: false })
    if (siblingReply === null) {
      throw new ClientControlError('A sibling session has the same pending prompt; identity is ambiguous', {
        code: 'AMBIGUOUS_SESSION'
      })
    }
    if (renderedText(siblingReply) === signature[1]) {
      throw new ClientControlError('Indistinguishable sibling sessions; target cannot be proven safely', {
        code: 'AMBIGUOUS_SESSION'
      })
    }
  }
  const assistantRecords = completedReplyChain(nodes, user.uuid)
    .filter((record) => record.type === 'assistant' && record.message?.role === 'assistant')
  const assistantMessageIds = [...new Set(assistantRecords
    .map((record) => record.message.id)
    .filter((id) => typeof id === 'string' && id))]
  const displayBlocks = []
  let previousMessageId
  for (const record of assistantRecords) {
    const text = textContent(record.message)
    if (!text) continue
    if (displayBlocks.length && record.message.id === previousMessageId) {
      displayBlocks[displayBlocks.length - 1] += text
    } else {
      displayBlocks.push(text)
      previousMessageId = record.message.id
    }
  }
  // Distinct assistant messages are separate display blocks; chunks of one ID stay inline.
  // This projection source is memory-only and must never alter replyFor's original bytes.
  const replyViewSource = displayBlocks.join('\n\n')
  return { raw, nodes, records, user, reply, assistantMessageIds, replyViewSource, sessionId, filePath: absolutePath }
}
