/**
 * 一木记账 MCP 兼容层。
 *
 * DSH 的 MCP 子系统（mcpManager / @deepseek-ai/dsh-mcp-client）会把 server 挂到
 * 全局作用域，做不到「只在某个模式里出现」。这里反过来做：插件自己作为 MCP
 * 宿主，用 stdio 私有托管 yimu-bill-cloud-mcp，再把 listTools() 的结果映射成
 * 调用方作用域内的原生 DSH 工具。
 *
 * SDK 不随插件发布：从 MCP 仓库自身的 node_modules 解析（该仓库的依赖里已有
 * @modelcontextprotocol/sdk），所以插件保持零 @deepseek-ai 依赖、离线可用。
 *
 * @module dsh-yimu-bill/mcp-host
 */

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 默认 MCP 仓库入口：与本插件仓库并列的 yimu-bill-cloud-mcp。 */
export const DEFAULT_SERVER_PATH = fileURLToPath(new URL('../yimu-bill-cloud-mcp/src/index.js', import.meta.url))

/** DSH 工具 schema 支持的约束关键字（其余递归剔除）。 */
const CONSTRAINT_KEYS = new Set(['type', 'required', 'enum', 'const', 'additionalProperties'])
/** 允许透传的注解关键字。 */
const ANNOTATION_KEYS = new Set(['description', 'title', 'default', 'examples'])
/** `JSON.stringify` 友好截断，避免把超长上游错误塞进工具结果或页面。 */
export function truncate(text, limit = 400) {
  const value = String(text ?? '')
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}

/**
 * 把 MCP 的 JSON Schema 收敛到 DSH 支持的子集：
 * type/oneOf/properties/required/additionalProperties/items/enum/const + 注解。
 * MCP SDK 会带出 `$schema`，个别工具还有 `format` 等关键字，直接注册会被 DSH 拒绝。
 *
 * @param {unknown} schema MCP 工具 inputSchema。
 * @returns {object} 可注册的 object 根 schema。
 */
export function sanitizeToolSchema(schema) {
  const seen = new WeakSet()

  /** @param {unknown} node */
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk)
    if (node === null || typeof node !== 'object') return node
    if (seen.has(node)) return {}
    seen.add(node)

    const out = {}
    for (const [key, value] of Object.entries(node)) {
      if (CONSTRAINT_KEYS.has(key)) {
        out[key] = value
      } else if (key === 'properties' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
        out.properties = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, walk(child)]))
      } else if (key === 'items') {
        out.items = walk(value)
      } else if (key === 'oneOf' || key === 'anyOf') {
        if (Array.isArray(value)) out.oneOf = value.map(walk)
      } else if (ANNOTATION_KEYS.has(key)) {
        out[key] = value
      }
    }
    return out
  }

  const clean = walk(schema)
  if (clean === null || typeof clean !== 'object' || Array.isArray(clean)) {
    return { type: 'object', additionalProperties: true, properties: {} }
  }
  if (clean.type !== 'object' && clean.oneOf === undefined) {
    return { type: 'object', additionalProperties: true, properties: {} }
  }
  if (clean.type === 'object' && clean.properties === undefined) clean.properties = {}
  return clean
}

/** 校验/补全 DSH 工具名允许的字符。 */
export function prefixedToolName(prefix, name) {
  return `${prefix}${name}`.replace(/[^A-Za-z0-9_-]/g, '_')
}

/** 取 MCP 工具返回里的纯文本；isError 时抛错，交给 DSH 记录为失败。 */
export function textOfToolResult(result) {
  const content = Array.isArray(result?.content) ? result.content : []
  const text = content
    .filter((item) => item !== null && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n')
  if (result?.isError === true) throw new Error(text || '一木 MCP 工具调用失败')
  if (text !== '') return text
  try {
    return JSON.stringify(result?.structuredContent ?? result ?? {})
  } catch {
    return String(result)
  }
}

/** 收集子进程 stderr 的尾部若干行，作为启动失败的诊断信息。 */
function stderrTail(lines, count = 8) {
  return lines.slice(-count).join('\n').trim()
}

/** 带超时的 Promise。 */
function withTimeout(promise, timeoutMs, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * 从 MCP 仓库的 node_modules 解析官方 SDK。
 * @param {string} serverCwd MCP 仓库根目录。
 */
export async function resolveSdk(serverCwd) {
  const requireFrom = createRequire(path.join(serverCwd, 'package.json'))
  const clientUrl = pathToFileURL(requireFrom.resolve('@modelcontextprotocol/sdk/client/index.js')).href
  const stdioUrl = pathToFileURL(requireFrom.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href
  const [clientModule, stdioModule] = await Promise.all([import(clientUrl), import(stdioUrl)])
  return {
    Client: clientModule.Client,
    StdioClientTransport: stdioModule.StdioClientTransport,
    getDefaultEnvironment: stdioModule.getDefaultEnvironment,
  }
}

/**
 * 启动一个私有的 MCP 客户端（stdio 子进程）。
 *
 * @param {object} options
 * @param {string} options.serverPath MCP 入口 src/index.js。
 * @param {string} options.serverCwd MCP 仓库根目录（解析 SDK 与子进程 cwd）。
 * @param {string} options.token 网页版 JWT；只进子进程环境变量。
 * @param {string} [options.userId] 可选，省略时 MCP 从 JWT aud 推断。
 * @param {number} [options.timeoutMs] 握手/列工具超时。
 * @param {object} [options.sdk] 测试注入。
 * @returns {Promise<{tools: object[], callText: (name: string, args?: object) => Promise<string>, close: () => Promise<void>}>}
 */
export async function startMcpHost({ serverPath = DEFAULT_SERVER_PATH, serverCwd = '', token, userId, timeoutMs = 20_000, sdk }) {
  if (typeof token !== 'string' || token === '') throw new Error('缺少 YIMU_TOKEN')
  const cwd = serverCwd === '' ? path.dirname(path.dirname(serverPath)) : serverCwd
  const resolved = sdk ?? (await resolveSdk(cwd))
  const { Client, StdioClientTransport, getDefaultEnvironment } = resolved

  const env = { ...getDefaultEnvironment(), YIMU_TOKEN: token }
  if (typeof userId === 'string' && userId !== '') env.YIMU_USER_ID = userId
  const stderrLines = []
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd,
    env,
    stderr: 'pipe',
  })
  transport.stderr?.on('data', (chunk) => {
    const text = String(chunk)
    for (const line of text.split(/\r?\n/)) if (line.trim() !== '') stderrLines.push(line)
    while (stderrLines.length > 40) stderrLines.shift()
  })

  const client = new Client({ name: 'dsh-yimu-bill', version: '0.2.0' })
  try {
    await withTimeout(client.connect(transport), timeoutMs, '连接一木 MCP 超时')
    const listed = await withTimeout(client.listTools(), timeoutMs, '读取一木 MCP 工具清单超时')
    const tools = Array.isArray(listed?.tools) ? listed.tools : []
    return {
      tools,
      async callText(name, args = {}) {
        const result = await client.callTool({ name, arguments: args ?? {} }, undefined, { timeout: 60_000 })
        return textOfToolResult(result)
      },
      async close() {
        try {
          await client.close()
        } catch {
          // 子进程已退出时 close 可能报错，忽略即可。
        }
      },
    }
  } catch (error) {
    try {
      await client.close()
    } catch {
      // 忽略关闭失败，保留原始启动错误。
    }
    const tail = stderrTail(stderrLines)
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(tail === '' ? message : `${message}（MCP stderr: ${truncate(tail, 300)}）`)
  }
}

/**
 * 把 MCP 工具注册为调用方作用域内的 DSH 原生工具。
 * @param {object} ctx 插件上下文（需要 tools 服务）。
 * @param {{tools: object[], callText: Function}} host startMcpHost 的返回值。
 * @param {{prefix?: string}} [options]
 * @returns {() => void} 撤下本次注册的 disposer。
 */
export function registerMcpTools(ctx, host, options = {}) {
  const prefix = options.prefix ?? 'yimu_'
  const disposers = []
  for (const tool of host.tools) {
    const name = prefixedToolName(prefix, String(tool.name))
    const description = typeof tool.description === 'string' && tool.description !== '' ? tool.description : name
    const parameters = sanitizeToolSchema(tool.inputSchema)
    const dispose = ctx.tools.register({
      name,
      description,
      parameters,
      output: {
        schema: { type: 'object', additionalProperties: true, properties: {} },
        render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      },
      async execute(args) {
        return { text: await host.callText(String(tool.name), args ?? {}) }
      },
    })
    disposers.push(dispose)
  }
  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // 关联插件已卸载时重复 dispose 可能抛错，忽略。
      }
    }
  }
}

/**
 * 用当前凭据做一次真实调用（默认 overview），供设置页「测试连接」使用。
 * @param {object} options 同 startMcpHost。
 * @param {string} [options.tool] 调用的工具名。
 * @returns {Promise<{tools: number, sample: string, elapsedMs: number}>}
 */
export async function probeMcp(options) {
  const startedAt = Date.now()
  const host = await startMcpHost(options)
  try {
    const sample = await host.callText(options.tool ?? 'overview', {})
    return { tools: host.tools.length, sample: truncate(sample, 600), elapsedMs: Date.now() - startedAt }
  } finally {
    await host.close()
  }
}
