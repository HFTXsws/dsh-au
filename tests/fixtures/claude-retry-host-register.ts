// Behavioral fixture for inspect/retry toasts; not a production plugin.
import type { Register } from 'claude-code'

const PERIOD_MS = 60_000
const MAX_RETRIES = 30
const RETRY_TEXT = '[自动重试] 上一轮因服务端临时错误失败，请沿用原任务继续；先检查已经完成的操作，不要重复成功的写入或外部操作。'

// 400 中仅 "Requests ending with a model turn are not supported." 属于可通过追加用户继续消息恢复的回合状态错误
const MODEL_TURN_400_RE = /requests ending with a model turn are not supported/i
const TRANSIENT_API_ERROR_RE =
  /^API Error:\s*(?:500|502|503|504|529)\b|overloaded_error|repeated_529|server_overload|api is at capacity|service is busy|服务繁忙|connection error|econnreset|econnrefused|etimedout|socket hang up/i

type Failure = { attempts: number; nextAt: number; timerId: number }

function isRetryableErrorText(text: string): boolean {
  if (!text) return false
  return MODEL_TURN_400_RE.test(text) || TRANSIENT_API_ERROR_RE.test(text)
}

function describeErrorReason(text: string): string {
  if (MODEL_TURN_400_RE.test(text)) {
    return '检测到模型回合结尾 400 报错（Requests ending with a model turn are not supported）'
  }
  return '本会话临时错误'
}

// 提示只走非转录 toast；缺少 API 或通知失败时静默略过，不阻断重试。
function showToast($: { ui?: { toast?: (text: string) => unknown } }, text: string): void {
  try {
    const ui = $.ui
    if (typeof ui?.toast !== 'function') return
    void Promise.resolve(ui.toast(text)).catch(() => {})
  } catch {
    // 通知只是附加显示，不能影响 next、计时或重试提交。
  }
}

export const register: Register = on => {
  const failures = new Map<string, Failure>()
  let timerSeq = 0

  on('session.start', async ($, e, next) => {
    showToast($, '重试插件已启动：本会话遇到临时错误或模型回合结尾 400 报错时会自动等待 60 秒后重试，最多 30 次')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const key = e.agentId ?? 'main'
    if (e.agentId !== undefined) {
      failures.delete(key)
      return next(e)
    }

    const answerText = typeof e.answer === 'string' ? e.answer : ''
    const retryableAnswer = isRetryableErrorText(answerText)
    if (e.reason !== 'error' && !retryableAnswer) {
      failures.delete(key)
      return next(e)
    }

    const now = Date.now()
    const current = failures.get(key) ?? { attempts: 0, nextAt: 0, timerId: 0 }
    if (current.attempts >= MAX_RETRIES) {
      showToast($, `本会话已达到最多 ${MAX_RETRIES} 次自动重试，停止。`)
      return next(e)
    }
    if (now < current.nextAt) return next(e)

    const attempts = current.attempts + 1
    const timerId = ++timerSeq
    failures.set(key, { attempts, nextAt: now + PERIOD_MS, timerId })
    const reasonLabel = describeErrorReason(answerText)
    showToast($, `${reasonLabel}，${PERIOD_MS / 1000} 秒后进行第 ${attempts}/${MAX_RETRIES} 次自动重试。`)
    $.clock.after(PERIOD_MS, async () => {
      const latest = failures.get(key)
      // 若等待期间用户已手动恢复会话或已被新一轮覆盖，则不再重复提交
      if (!latest || latest.timerId !== timerId) return
      try {
        await $.prompt.submit({ text: RETRY_TEXT })
      } catch (error) {
        showToast($, `本会话自动重试未提交：${String(error)}`)
      }
    })
    return next(e)
  })
}
