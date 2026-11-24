/**
 * 一木记账工具半（只在「记账模式」preset 内挂载）。
 *
 * 由 @deepseek-ai/dsh-agent-preset 的预设声明引用：
 *   - id: yimu-bill-tools
 *     name: dsh-yimu-bill/tools
 *     config: { toolPrefix: yimu_ }
 *
 * 本模块在 preset revision 的作用域内注册工具，因此只有绑定到该模式的会话
 * 能看到它们；标准模式等其他模式不受影响。MCP 进程由本模块私有托管，token
 * 只作为子进程环境变量存在。
 *
 * @module dsh-yimu-bill/tools
 */

import path from 'node:path'
import { DEFAULT_SERVER_PATH, registerMcpTools, startMcpHost, truncate } from './mcp-host.mjs'
import { TOKEN_REF } from './lib/constants.mjs'

export { TOKEN_REF }

/** Cordis 插件名。 */
export const name = 'yimu-bill-tools'

/** 依赖 host 服务。 */
export const inject = ['tools', 'credentials']

/** 默认配置。 */
const DEFAULTS = Object.freeze({
  /** MCP 入口；留空时取相邻仓库的 yimu-bill-cloud-mcp/src/index.js。 */
  serverPath: '',
  /** MCP 仓库工作目录；留空时取 serverPath 的仓库根。 */
  serverCwd: '',
  /** 工具名前缀，避免和别的插件撞名。 */
  toolPrefix: 'yimu_',
  /** MCP 握手/列工具超时。 */
  startupTimeoutMs: 20_000,
  /** 会话创建最多等待 MCP 就绪的时间；超时后后台继续。 */
  readyWaitMs: 10_000,
})

/** 把连接状态渲染成中文工具结果。 */
function renderStatus(value) {
  if (!value.configured) {
    return '一木记账尚未登录：打开 DSH 设置 → 一木记账 → 扫码登录后再试。'
  }
  if (value.connected) {
    const tools = Array.isArray(value.tools) && value.tools.length > 0 ? value.tools.map((tool) => `${value.prefix}${tool}`).join('、') : '（无）'
    return `一木记账已登录，MCP 已连接（${value.tools.length} 个工具）：${tools}`
  }
  if (value.error) return `一木记账 MCP 未连接：${value.error}`
  return '一木记账已登录，正在连接 MCP…'
}

/**
 * 插件入口。
 * @param {object} ctx cordis 上下文（已注入 tools/credentials）。
 * @param {object} [rawConfig] 插件行配置。
 * @returns {Promise<void>} MCP 就绪或达到等待上限后返回；失败不会 reject。
 */
export async function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...rawConfig }
  const serverPath = String(config.serverPath ?? '').trim() || DEFAULT_SERVER_PATH
  const serverCwd = String(config.serverCwd ?? '').trim() || path.dirname(path.dirname(serverPath))

  /** 最近一次连接状态；yimu_status 读取。 */
  const state = { configured: false, connected: false, tools: [], error: '' }
  /** 当前 MCP host，null 表示未连接。 */
  let host = null
  /** 当前注册的工具撤下函数。 */
  let unregister = () => {}
  /** 代际号：凭据变化/卸载时让过期的启动结果自行丢弃。 */
  let generation = 0
  let disposed = false

  const stop = () => {
    unregister()
    unregister = () => {}
    const current = host
    host = null
    if (current !== null) void current.close()
  }

  /** 读取凭据并（重新）连接 MCP；失败只记录状态。 */
  const start = async () => {
    const gen = ++generation
    stop()
    if (disposed) return
    let token = ''
    try {
      token = String((await ctx.credentials.resolve(TOKEN_REF))?.value ?? '')
    } catch (error) {
      ctx.logger?.warn?.(`[yimu-bill] 读取凭据失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (token === '') {
      Object.assign(state, { configured: false, connected: false, tools: [], error: '' })
      return
    }
    Object.assign(state, { configured: true, connected: false, tools: [], error: '' })
    try {
      const next = await startMcpHost({
        serverPath,
        serverCwd,
        token,
        timeoutMs: config.startupTimeoutMs,
      })
      if (gen !== generation || disposed) {
        await next.close()
        return
      }
      host = next
      unregister = registerMcpTools(ctx, host, { prefix: config.toolPrefix })
      Object.assign(state, {
        connected: true,
        tools: host.tools.map((tool) => String(tool.name)),
        error: '',
      })
      ctx.logger?.info?.(`[yimu-bill] MCP 就绪：${state.tools.length} 个工具`)
    } catch (error) {
      if (gen !== generation || disposed) return
      Object.assign(state, {
        connected: false,
        tools: [],
        error: truncate(error instanceof Error ? error.message : String(error), 500),
      })
      ctx.logger?.warn?.(`[yimu-bill] MCP 启动失败：${state.error}`)
    }
  }

  ctx.effect(
    () => () => {
      disposed = true
      generation += 1
      stop()
    },
    'yimu-bill-tools: mcp host',
  )
  ctx.effect(
    () =>
      ctx.on('credentials/reference-updated', (ref) => {
        if (ref === TOKEN_REF) void start()
      }),
    'yimu-bill-tools: credential watch',
  )

  // 常驻状态工具：未登录、连接失败时也能给用户/Agent 一个明确提示。
  ctx.tools.register({
    name: 'yimu_status',
    description: '一木记账状态：登录凭据、MCP 连接与可用记账工具（仅记账模式）。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: renderStatus({ ...value, prefix: config.toolPrefix }) }],
    },
    async execute() {
      let configured = state.configured
      try {
        const described = await ctx.credentials.describe(TOKEN_REF)
        configured = Boolean(described?.configured)
      } catch {
        // describe 失败时沿用最近一次已知状态。
      }
      return { configured, connected: state.connected, tools: state.tools, error: state.error }
    },
  })

  const ready = start()
  // 慢/挂起的 MCP 不阻塞会话创建：最多等 readyWaitMs，之后在后台完成注册。
  let capTimer
  const cap = new Promise((resolve) => {
    capTimer = setTimeout(resolve, config.readyWaitMs)
    if (typeof capTimer.unref === 'function') capTimer.unref()
  })
  try {
    return await Promise.race([ready.then(() => undefined), cap])
  } finally {
    clearTimeout(capTimer)
  }
}
