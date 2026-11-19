import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const STORE_VERSION = 1;
const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8']);

export function resolveTodoStorePath() {
  if (process.env.DSH_AU_TODO_PATH) return process.env.DSH_AU_TODO_PATH;
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-au-todo.json');
}

function emptyStore() {
  return { version: STORE_VERSION, conversations: {} };
}

/** 读取当前设备私有的对话优先级、拖拽权重与 Todo 队列。 */
export function loadTodoStore() {
  const filePath = resolveTodoStorePath();
  if (!existsSync(filePath)) return emptyStore();
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    if (raw?.version !== STORE_VERSION || !raw.conversations || typeof raw.conversations !== 'object') return emptyStore();
    return raw;
  } catch {
    return emptyStore();
  }
}

/** 原子替换本机 Todo 文件，防止 DSH 退出中途留下半份 JSON。 */
export function saveTodoStore(store) {
  const filePath = resolveTodoStorePath();
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  renameSync(tempPath, filePath);
  return store;
}

function entryFor(store, sessionId) {
  const current = store.conversations[sessionId];
  if (current && typeof current === 'object') return current;
  const created = { priority: 'P4', sortOrder: 0, todos: [], hidden: false, pinned: false };
  store.conversations[sessionId] = created;
  return created;
}

function normalizeTodos(todos) {
  return Array.isArray(todos)
    ? todos.filter((todo) => todo && typeof todo.text === 'string' && todo.text.trim()).map((todo) => ({
      id: typeof todo.id === 'string' ? todo.id : randomUUID(),
      text: todo.text.trim().slice(0, 12_000),
      createdAt: Number(todo.createdAt) || Date.now(),
    }))
    : [];
}

/** 将本机持久化元数据合并到 dsh-au 读取的原生会话摘要。 */
export function applyTodoMetadata(cards, store = loadTodoStore()) {
  let dirty = false;
  const result = cards.map((card) => {
    const entry = entryFor(store, card.sessionId);
    const priority = PRIORITIES.has(entry.priority) ? entry.priority : 'P4';
    const todos = normalizeTodos(entry.todos);
    const lastUserMessageAt = Number(card.lastUserMessageAt) || 0;
    if (entry.hidden === true) {
      if (!Number.isFinite(entry.hiddenAt) || entry.hiddenAt <= 0) {
        // 兼容历史已隐藏条目：首次补齐完成水位线，避免存量旧消息误触发解封。
        const fallbackAt = Math.max(lastUserMessageAt, Number(card.updatedAt) || 0);
        entry.hiddenAt = fallbackAt > 0 ? fallbackAt : Date.now();
        dirty = true;
      } else if (lastUserMessageAt > entry.hiddenAt) {
        // 仅当用户本人在聊天框主动发送了晚于完成水位线的新消息时，自动解除完成隐藏。
        entry.hidden = false;
        delete entry.hiddenAt;
        dirty = true;
      }
    }
    return {
      ...card,
      priority,
      // 默认按最近更新时间逆序；一旦拖拽则使用持久化的数值位置。
      sortOrder: Number.isFinite(entry.sortOrder) && entry.sortOrder !== 0 ? entry.sortOrder : -card.updatedAt,
      todos,
      // 暂存表示必须完成的最高优先级事项；完成仅取消面板展示，均不触碰原生会话。
      pinned: entry.pinned === true,
      hidden: entry.hidden === true,
      ...(Number.isFinite(entry.hiddenAt) && entry.hiddenAt > 0 ? { hiddenAt: entry.hiddenAt } : {}),
    };
  });
  if (dirty) {
    try { saveTodoStore(store); } catch {}
  }
  return result;
}

export function savePriority(sessionId, priority) {
  if (!PRIORITIES.has(priority)) return { ok: false, error: '优先级必须是 P0 到 P8' };
  const store = loadTodoStore();
  entryFor(store, sessionId).priority = priority;
  saveTodoStore(store);
  return { ok: true };
}

/** 暂存是可逆的最高优先级置顶标记，不修改普通 P0-P3 优先级。 */
export function savePinned(sessionId, pinned) {
  if (typeof sessionId !== 'string' || !sessionId || typeof pinned !== 'boolean') {
    return { ok: false, error: '暂存参数无效' };
  }
  const store = loadTodoStore();
  entryFor(store, sessionId).pinned = pinned;
  saveTodoStore(store);
  return { ok: true };
}

export function saveSortOrder(sessionId, priority, sortOrder) {
  if (!PRIORITIES.has(priority) || !Number.isFinite(sortOrder)) return { ok: false, error: '拖拽排序参数无效' };
  const store = loadTodoStore();
  const entry = entryFor(store, sessionId);
  entry.priority = priority;
  entry.sortOrder = sortOrder;
  saveTodoStore(store);
  return { ok: true };
}

export function appendTodo(sessionId, text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'Todo 不能为空' };
  const store = loadTodoStore();
  const entry = entryFor(store, sessionId);
  entry.todos = normalizeTodos(entry.todos);
  const todo = { id: randomUUID(), text: text.trim().slice(0, 12_000), createdAt: Date.now() };
  entry.todos.push(todo);
  // 手动追加新待办时，自动解除该会话的完成隐藏状态。
  if (entry.hidden === true) {
    entry.hidden = false;
    delete entry.hiddenAt;
  }
  saveTodoStore(store);
  return { ok: true, todo };
}

/** 仅将卡片从 Todo 面板隐藏；保留对应 DSH 会话、优先级和待发 Todo 队列。 */
export function hideTodoConversation(sessionId, options = {}) {
  if (typeof sessionId !== 'string' || !sessionId) return { ok: false, error: '缺少 sessionId' };
  const store = loadTodoStore();
  const entry = entryFor(store, sessionId);
  entry.hidden = true;
  const explicitBaseline = Math.max(
    Number(options?.hiddenAt) || 0,
    Number(options?.lastUserMessageAt) || 0,
    Number(options?.updatedAt) || 0,
  );
  entry.hiddenAt = explicitBaseline > 0 ? explicitBaseline : Date.now();
  saveTodoStore(store);
  return { ok: true };
}

export function peekTodo(sessionId) {
  const store = loadTodoStore();
  const todos = normalizeTodos(store.conversations[sessionId]?.todos);
  return todos[0] || null;
}

/** 成功投递后才移除首项，网络失败时用户仍可重试。 */
export function removeTodo(sessionId, todoId) {
  const store = loadTodoStore();
  const entry = entryFor(store, sessionId);
  entry.todos = normalizeTodos(entry.todos).filter((todo) => todo.id !== todoId);
  saveTodoStore(store);
  return { ok: true };
}
