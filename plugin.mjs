/**
 * dsh-yimu-bill — 一木记账（yimubill.com）DSH host 插件
 *
 * 两件事：
 * 1. 扫码登录：向官方接口申请扫码会话，把二维码渲染成终端可直接扫的文本，
 *    轮询到登录成功后把网页版 JWT 写进 DSH 凭据库（ref: YIMU_TOKEN）。
 * 2. 按插件生命周期注册 MCP server（yimu_cloud），env 用 ${credential:YIMU_TOKEN}
 *    模板。凭据写入后 mcp-client 会重建连接，工具即出现；插件卸载则 MCP 一起撤。
 *    MCP 本体在独立仓库 MeiXu6693/yimu-bill-cloud-mcp。
 *
 * 约束：profile 插件的模块解析到不了 /app/node_modules，所以只 import node
 * 内置模块与同目录 node_modules（qrcode-generator），不依赖 @deepseek-ai/* 包。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'yimu-bill'

/** 依赖的 host 服务；credentials 用于读写 YIMU_TOKEN，tools 用于注册登录工具。 */
export const inject = ['tools', 'credentials']

const REQUIRE = createRequire(import.meta.url)
const QRCODE = REQUIRE('qrcode-generator')

const API_BASE = 'https://yimubill.com/api'
const ORIGIN = 'https://yimubill.com'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
const TOKEN_REF = 'YIMU_TOKEN'

/** 插件默认配置；loader 的 config 覆盖。 */
const DEFAULTS = Object.freeze({
  /** 是否在插件生命周期内用 ctx.mcpManager 注册 MCP server（全局安装形态） */
  registerMcp: true,
  serverName: 'yimu_cloud',
  /** MCP 仓库里的 src/index.js 绝对路径；registerMcp 时必填 */
  serverPath: '',
  /** MCP 进程工作目录；留空则取 serverPath 所在目录 */
  serverCwd: '',
  /** 二维码 SVG 落盘目录 */
  qrDir: path.join(os.tmpdir(), 'dsh-yimu-bill', 'qr'),
  loginTtlMs: 120_000,
})

/** 官方接口的公共请求头。 */
const HEADERS = {
  'user-agent': USER_AGENT,
  referer: `${ORIGIN}/`,
  accept: 'application/json, text/plain, */*',
}

/** 调官方接口，返回原始 JSON（不解信封）。 */
async function call(pathname, init = {}, timeoutMs = 15_000) {
  const res = await fetch(`${API_BASE}${pathname}`, {
    ...init,
    headers: { ...HEADERS, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  })
  if (!res.ok) throw new Error(`一木接口 HTTP ${res.status}`)
  return await res.json()
}

/** 申请扫码登录会话，返回 sessionId（二维码内容为 `login:<sessionId>`）。 */
export async function startScanLogin() {
  const data = await call('/scanLogin/addScanLogin', { method: 'POST' })
  const sessionId = data?.result
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error(`扫码会话创建失败：${JSON.stringify(data).slice(0, 200)}`)
  }
  return sessionId
}

/**
 * 查询一次扫码状态。
 * @returns {{ state: 'pending' } | { state: 'ok', jwt: string, userId: string, user: object }}
 */
export async function pollScanLogin(sessionId) {
  const data = await call(`/scanLogin/getScanLogin/${encodeURIComponent(sessionId)}`)
  if (data?.code === 0 && data.result && typeof data.result === 'object') {
    const jwt = typeof data.token === 'string' ? data.token : ''
    if (jwt === '') throw new Error('扫码已确认，但响应里没有 JWT')
    const user = data.result
    const userId = String(user.id ?? user.userId ?? '')
    return { state: 'ok', jwt, userId, user }
  }
  if (data?.code === 1 && data.msg === 'no data') return { state: 'pending' }
  throw new Error(`扫码状态查询失败：code=${String(data?.code)} msg=${String(data?.msg)}`)
}

/** 生成二维码矩阵（自动选版本，M 级纠错）。 */
function makeQr(text) {
  const levels = ['M', 'L']
  for (const level of levels) {
    try {
      const qr = QRCODE(0, level)
      qr.addData(text)
      qr.make()
      return qr
    } catch {
      // 换更低纠错级别重试
    }
  }
  for (let type = 1; type <= 25; type += 1) {
    try {
      const qr = QRCODE(type, 'L')
      qr.addData(text)
      qr.make()
      return qr
    } catch {
      // 继续放大版本
    }
  }
  throw new Error('二维码生成失败（内容过长）')
}

/**
 * 渲染成半块字符二维码：每个字符两行模块，宽高比接近方形，
 * 等宽字体下可直接扫描；留 4 模块静区。
 */
export function renderQrText(text, quiet = 4) {
  const qr = makeQr(text)
  const n = qr.getModuleCount()
  const size = n + quiet * 2
  const darkAt = (row, col) =>
    row >= quiet && col >= quiet && row < n + quiet && col < n + quiet
      ? qr.isDark(row - quiet, col - quiet)
      : false
  const lines = []
  for (let row = 0; row < size; row += 2) {
    let line = ''
    for (let col = 0; col < size; col += 1) {
      const top = darkAt(row, col)
      const bottom = row + 1 < size ? darkAt(row + 1, col) : false
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    }
    lines.push(line)
  }
  return lines.join('\n')
}

/** 同时落一份 SVG，方便在图片查看器里放大扫。 */
async function saveQrSvg(text, dir, sessionId) {
  const qr = makeQr(text)
  const n = qr.getModuleCount()
  const quiet = 4
  const size = n + quiet * 2
  const cells = []
  for (let row = 0; row < n; row += 1) {
    for (let col = 0; col < n; col += 1) {
      if (qr.isDark(row, col)) cells.push(`<rect x="${col + quiet}" y="${row + quiet}" width="1" height="1"/>`)
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><g fill="#000">${cells.join('')}</g></svg>`
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `login-${sessionId}.svg`)
  await writeFile(file, svg, { mode: 0o600 })
  return file
}

/** JWT 里的 aud（= userId），仅用于展示。 */
function jwtAudience(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(String(jwt).split('.')[1] ?? '', 'base64url').toString('utf8'))
    return String(payload.aud ?? payload.userId ?? '')
  } catch {
    return ''
  }
}

/** 文本型工具定义（DSH 直接吃 JSON Schema）。 */
function textTool({ toolName, description, parameters, execute, render }) {
  return {
    name: toolName,
    description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      ...parameters,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {},
      },
      render,
    },
    execute,
  }
}

/**
 * 插件入口。
 * @param ctx cordis 上下文（已注入 tools/credentials）
 * @param rawConfig loader 传入的配置
 */
export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...rawConfig }
  /** 进行中的扫码会话：sessionId → { startedAt } */
  const sessions = new Map()

  const requireQrDir = () => config.qrDir

  ctx.tools.register(
    textTool({
      toolName: 'yimu_login',
      description:
        '一木记账扫码登录：申请扫码会话并显示二维码（文本二维码，等宽字体可直接扫）。用一木记账 App【首页】-【更多】-【扫一扫】扫描后，调用 yimu_login_wait 等待登录完成。二维码约 2 分钟有效。',
      parameters: { properties: {}, required: [] },
      render: (_args, value) => [
        {
          type: 'text',
          text: [
            '用一木记账 App【首页】-【更多】-【扫一扫】扫描下面的二维码（约 2 分钟有效）：',
            '',
            '```',
            String(value.qr_text),
            '```',
            '',
            `session_id: ${value.session_id}`,
            value.qr_file ? `二维码图片: ${value.qr_file}` : '',
            '扫完调用 yimu_login_wait 等待登录结果。',
          ]
            .filter((line) => line !== '')
            .join('\n'),
        },
      ],
      async execute() {
        const sessionId = await startScanLogin()
        const payload = `login:${sessionId}`
        sessions.set(sessionId, { startedAt: Date.now() })
        const file = await saveQrSvg(payload, requireQrDir(), sessionId).catch(() => '')
        return {
          session_id: sessionId,
          qr_payload: payload,
          qr_text: renderQrText(payload),
          qr_file: file,
          expires_in_seconds: Math.round(config.loginTtlMs / 1000),
        }
      },
    }),
  )

  ctx.tools.register(
    textTool({
      toolName: 'yimu_login_wait',
      description:
        '等待一木记账扫码登录结果（轮询官方接口，最多等 timeout_seconds 秒）。成功后把网页版 JWT 写入 DSH 凭据库（YIMU_TOKEN），MCP server 会自动重连。',
      parameters: {
        properties: {
          session_id: { type: 'string', description: 'yimu_login 返回的 session_id' },
          timeout_seconds: {
            type: 'integer',
            description: '最多等待多少秒（默认 20，最大 45）',
          },
        },
        required: ['session_id'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.ok
            ? `扫码登录成功：user_id=${value.user_id}${value.email ? `，账号 ${value.email}` : ''}。JWT 已写入 DSH 凭据 ${TOKEN_REF}，MCP server 会用该凭据重连。`
            : `仍未扫码成功（${value.message}）。二维码可能已过期，可重新调用 yimu_login 生成新的。`,
        },
      ],
      async execute(args) {
        const sessionId = String(args.session_id ?? '')
        if (sessionId === '') throw new Error('缺少 session_id')
        const timeoutSeconds = Math.min(Math.max(Number(args.timeout_seconds ?? 20), 1), 45)
        const deadline = Date.now() + timeoutSeconds * 1000
        let result = { state: 'pending' }
        while (Date.now() < deadline) {
          result = await pollScanLogin(sessionId)
          if (result.state === 'ok') break
          await new Promise((resolve) => setTimeout(resolve, 2_000))
        }
        if (result.state !== 'ok') {
          return { ok: false, message: '未检测到扫码确认（可能还没扫，或二维码已过期）' }
        }
        await ctx.credentials.set(TOKEN_REF, result.jwt)
        sessions.delete(sessionId)
        return {
          ok: true,
          user_id: result.userId || jwtAudience(result.jwt),
          email: typeof result.user.email === 'string' ? result.user.email : '',
        }
      },
    }),
  )

  ctx.tools.register(
    textTool({
      toolName: 'yimu_login_status',
      description: `查看一木记账登录状态：DSH 凭据 ${TOKEN_REF} 是否已配置（不显示 token 内容）。`,
      parameters: { properties: {}, required: [] },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.configured
            ? `已登录：凭据 ${TOKEN_REF} 已配置${value.user_id ? `，user_id=${value.user_id}` : ''}。`
            : `未登录：凭据 ${TOKEN_REF} 未配置，先调用 yimu_login 扫码。`,
        },
      ],
      async execute() {
        const described = await ctx.credentials.describe(TOKEN_REF)
        return { configured: Boolean(described.configured) }
      },
    }),
  )

  ctx.tools.register(
    textTool({
      toolName: 'yimu_logout',
      description: `清除 DSH 里的一木记账凭据 ${TOKEN_REF}（不会影响手机 App 的登录状态）。`,
      parameters: { properties: {}, required: [] },
      render: () => [{ type: 'text', text: `已清除凭据 ${TOKEN_REF}。` }],
      async execute() {
        await ctx.credentials.unset(TOKEN_REF)
        return { ok: true }
      },
    }),
  )

  // MCP server 跟随插件生命周期：插件卸载 → server 撤下、工具消失。
  // 会话级（preset）形态不启用本段，由 preset 里的 mcp-client 条目自行挂载。
  if (config.registerMcp !== true) return

  const serverPath = String(config.serverPath ?? '').trim()
  if (serverPath === '') {
    ctx.logger?.warn?.('[yimu-bill] registerMcp 已启用但未配置 serverPath，跳过 MCP 注册（登录工具仍可用）')
    return
  }
  const mcpManager = ctx.get('mcpManager')
  if (mcpManager === undefined) {
    ctx.logger?.warn?.('[yimu-bill] 未找到 mcpManager 服务，跳过 MCP 注册（登录工具仍可用）')
    return
  }
  const serverCwd = String(config.serverCwd ?? '').trim() || path.dirname(serverPath)
  ctx.effect(() => {
    const dispose = mcpManager.register(config.serverName, {
      transport: 'stdio',
      command: process.execPath,
      args: [serverPath],
      cwd: serverCwd,
      env: { [TOKEN_REF]: `\${credential:${TOKEN_REF}}` },
      startupTimeoutMs: 20_000,
    })
    return () => dispose()
  }, 'yimu-bill: register mcp server')
}
