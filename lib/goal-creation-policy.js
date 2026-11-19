const POLICY_UNAVAILABLE = '当前 DSH 宿主不支持 tools.guard，无法强制禁止 AI 创建目标。';
const POLICY_NOT_READY = 'DSH 目标创建限制尚未就绪，无法强制禁止 AI 创建目标。';
const DENIAL_REASON = '此宿主已禁止 AI 调用 create_goal；请直接完成用户请求。已有目标仍可读取、更新和恢复。';

/** 只限制 AI 的 create_goal；使用宿主全局 guard，不接触目标、驱动或会话状态。 */
export function installGoalCreationPolicy(ctx, getConfig) {
  let error = POLICY_NOT_READY;
  ctx.inject(['tools'], (hostCtx) => {
    hostCtx.effect(() => {
      if (typeof hostCtx.tools?.guard !== 'function') {
        error = POLICY_UNAVAILABLE;
        console.warn(`[dsh-au] ${error}`);
        return;
      }
      // 每次执行读取当前 cfg，saveFeatures 和配置重载不需要重新注册 guard。
      const dispose = hostCtx.tools.guard((exec) => {
        if (exec.name === 'create_goal' && getConfig()?.features?.blockGoalCreation === true) {
          return DENIAL_REASON;
        }
      });
      error = null;
      return () => {
        error = POLICY_NOT_READY;
        dispose();
      };
    }, 'dsh-au: goal creation policy');
  });
  // 动态提示仅减少徒劳的创建尝试；可选提示服务缺失时仍由 guard 强制执行。
  ctx.inject(['systemPrompt'], (hostCtx) => {
    if (typeof hostCtx.systemPrompt?.context !== 'function') return;
    hostCtx.effect(() => hostCtx.systemPrompt.context({
      name: 'dsh-au:goal-creation-policy',
      order: 250,
      text: () => !error && getConfig()?.features?.blockGoalCreation === true ? DENIAL_REASON : '',
    }), 'dsh-au: goal creation guidance');
  });
  // 设置 API 不能在宿主不支持或生命周期未就绪时宣称限制已生效。
  return { getError: () => error };
}
