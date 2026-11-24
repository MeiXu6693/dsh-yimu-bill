/**
 * dsh-yimu-bill — 一木记账（yimubill.com）DSH 控制半。
 *
 * 只做两件事：
 * 1. 扫码登录（设置页 GUI 与 HTTP API）：申请官方扫码会话，把二维码以 data URL
 *    返回给设置页，轮询到确认后把网页版 JWT 写进 DSH 凭据库（ref: YIMU_TOKEN）。
 * 2. 提供「测试连接」：用当前凭据拉起 yimu-bill-cloud-mcp，真实调用 overview。
 *
 * 这里不注册任何 Agent 工具、不挂 MCP。记账工具由 tools.mjs 在「记账模式」
 * preset 的作用域内注册（见 cordis.patch.yml），因此其他模式完全看不到。
 *
 * @module dsh-yimu-bill
 */

import path from 'node:path'
import { createRequire } from 'node:module'
import { DEFAULT_SERVER_PATH, probeMcp, truncate } from './mcp-host.mjs'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'yimu-bill'

/** 依赖的 host 服务。 */
export const inject = ['credentials', 'webServer']

/** 凭据引用名。 */
export const TOKEN_REF = 'YIMU_TOKEN'

const API_BASE = 'https://yimubill.com/api'
const ORIGIN = 'https://yimubill.com'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
const QRCODE = createRequire(import.meta.url)('qrcode-generator')

/** 两次「开始扫码」之间的最小间隔。 */
const START_INTERVAL_MS = 3_000
/** 两次「测试连接」之间的最小间隔。 */
const PROBE_INTERVAL_MS = 5_000
/** 请求体上限。 */
const BODY_LIMIT_BYTES = 8_192

/** 插件默认配置；loader 的 config 覆盖。 */
const DEFAULTS = Object.freeze({
  /** 二维码有效期（展示与宿主侧过期判定）。 */
  loginTtlMs: 120_000,
  /** 测试连接时 MCP 握手超时。 */
  probeTimeoutMs: 20_000,
  /** MCP 入口；留空时取相邻仓库。 */
  mcpServerPath: '',
  /** MCP 仓库工作目录；留空时取 serverPath 的仓库根。 */
  mcpServerCwd: '',
})

/** 带 HTTP 状态码的控制器错误；handler 用它决定响应码。 */
export class HttpError extends Error {
  /**
   * @param {number} status HTTP 状态码。
   * @param {string} message 面向用户的中文消息。
   */
  constructor(status, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

/** 官方接口的公共请求头。 */
const HEADERS = {
  'user-agent': USER_AGENT,
  referer: `${ORIGIN}/`,
  accept: 'application/json, text/plain, */*',
}

/**
 * 调官方接口，返回原始 JSON（不解信封）。
 * @param {string} pathname 接口路径。
 * @param {object} [init] fetch 参数。
 * @param {number} [timeoutMs] 超时。
 * @param {typeof fetch} [fetchImpl] 测试注入。
 * @returns {Promise<any>}
 */
export async function call(pathname, init = {}, timeoutMs = 15_000, fetchImpl = fetch) {
  const res = await fetchImpl(`${API_BASE}${pathname}`, {
    ...init,
    headers: { ...HEADERS, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  })
  if (!res.ok) throw new Error(`一木接口 HTTP ${res.status}`)
  return await res.json()
}

/**
 * 申请扫码登录会话，返回 sessionId（二维码内容为 `login:<sessionId>`）。
 * @param {typeof fetch} [fetchImpl] 测试注入。
 * @returns {Promise<string>}
 */
export async function startScanLogin(fetchImpl = fetch) {
  const data = await call('/scanLogin/addScanLogin', { method: 'POST' }, 15_000, fetchImpl)
  const sessionId = data?.result
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error(`扫码会话创建失败：${truncate(JSON.stringify(data), 200)}`)
  }
  return sessionId
}

/**
 * 查询一次扫码状态。
 * @param {string} sessionId 扫码会话。
 * @param {typeof fetch} [fetchImpl] 测试注入。
 * @returns {Promise<{state: 'pending'} | {state: 'ok', jwt: string, userId: string, user: object}>}
 */
export async function pollScanLogin(sessionId, fetchImpl = fetch) {
  const data = await call(`/scanLogin/getScanLogin/${encodeURIComponent(sessionId)}`, {}, 15_000, fetchImpl)
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
 * @param {string} text 二维码内容。
 * @param {number} [quiet] 静区模块数。
 * @returns {string}
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

/**
 * 生成二维码 SVG（供设置页以 data URL 显示）。
 * @param {string} text 二维码内容。
 * @param {number} [quiet] 静区模块数。
 * @returns {string}
 */
export function renderQrSvg(text, quiet = 4) {
  const qr = makeQr(text)
  const n = qr.getModuleCount()
  const size = n + quiet * 2
  const cells = []
  for (let row = 0; row < n; row += 1) {
    for (let col = 0; col < n; col += 1) {
      if (qr.isDark(row, col)) cells.push(`<rect x="${col + quiet}" y="${row + quiet}" width="1" height="1"/>`)
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><g fill="#000">${cells.join('')}</g></svg>`
}

/**
 * 二维码内容转 data URL（浏览器用 `<img>` 渲染，不注入 HTML）。
 * @param {string} text 二维码内容。
 * @returns {string}
 */
export function qrDataUrl(text) {
  return `data:image/svg+xml;base64,${Buffer.from(renderQrSvg(text), 'utf8').toString('base64')}`
}

/** JWT 里的 aud（= userId），仅用于展示。 */
export function jwtAudience(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(String(jwt).split('.')[1] ?? '', 'base64url').toString('utf8'))
    return String(payload.aud ?? payload.userId ?? '')
  } catch {
    return ''
  }
}

/**
 * 登录/状态/探测控制器。与 HTTP 解耦，便于单测。
 * @param {object} options
 * @param {object} options.credentials DSH 凭据服务（describe/resolve/set/unset）。
 * @param {{start: Function, poll: Function}} [options.loginApi] 官方扫码接口（测试注入）。
 * @param {(input: {token: string}) => Promise<object>} [options.probe] 测试连接实现。
 * @param {() => number} [options.now] 时钟。
 * @param {number} [options.ttlMs] 二维码有效期。
 * @returns {object}
 */
export function createLoginController({ credentials, loginApi, probe, now = () => Date.now(), ttlMs = DEFAULTS.loginTtlMs }) {
  const api = loginApi ?? {
    start: () => startScanLogin(),
    poll: (sessionId) => pollScanLogin(sessionId),
  }
  /** @type {Map<string, {expiresAt: number}>} */
  const sessions = new Map()
  let lastStartAt = Number.NEGATIVE_INFINITY
  let lastProbeAt = Number.NEGATIVE_INFINITY

  const purge = () => {
    const current = now()
    for (const [id, session] of sessions) if (current >= session.expiresAt) sessions.delete(id)
    while (sessions.size > 8) {
      const oldest = sessions.keys().next().value
      if (oldest === undefined) break
      sessions.delete(oldest)
    }
  }

  async function status() {
    let described = { configured: false }
    try {
      described = await credentials.describe(TOKEN_REF)
    } catch {
      // 凭据服务异常时按未登录处理。
    }
    let userId = ''
    if (described?.configured) {
      try {
        const resolved = await credentials.resolve(TOKEN_REF)
        userId = jwtAudience(resolved?.value)
      } catch {
        // 展示信息拿不到不影响登录状态。
      }
    }
    return {
      configured: Boolean(described?.configured),
      userId,
      source: typeof described?.source === 'string' ? described.source : '',
    }
  }

  async function startLogin() {
    const current = now()
    if (current - lastStartAt < START_INTERVAL_MS) throw new HttpError(429, '操作太频繁，请稍后再试')
    lastStartAt = current
    let sessionId
    try {
      sessionId = await api.start()
    } catch (error) {
      throw new HttpError(502, `无法创建扫码会话：${truncate(error instanceof Error ? error.message : String(error), 200)}`)
    }
    if (typeof sessionId !== 'string' || sessionId === '') throw new HttpError(502, '扫码会话创建失败')
    const expiresAt = current + ttlMs
    sessions.set(sessionId, { expiresAt })
    purge()
    return {
      sessionId,
      qr: qrDataUrl(`login:${sessionId}`),
      expiresAt,
      expiresInSeconds: Math.round(ttlMs / 1000),
    }
  }

  async function pollLogin(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') throw new HttpError(400, '缺少 sessionId')
    const session = sessions.get(sessionId)
    if (session === undefined || now() >= session.expiresAt) {
      sessions.delete(sessionId)
      return { state: 'expired' }
    }
    let result
    try {
      result = await api.poll(sessionId)
    } catch (error) {
      return { state: 'error', error: truncate(error instanceof Error ? error.message : String(error), 300) }
    }
    if (result.state === 'ok') {
      try {
        await credentials.set(TOKEN_REF, result.jwt)
      } catch (error) {
        return { state: 'error', error: `保存凭据失败：${truncate(error instanceof Error ? error.message : String(error), 200)}` }
      }
      sessions.delete(sessionId)
      return {
        state: 'ok',
        userId: result.userId || jwtAudience(result.jwt),
        email: typeof result.user?.email === 'string' ? result.user.email : '',
      }
    }
    return { state: 'pending' }
  }

  async function logout() {
    await credentials.unset(TOKEN_REF)
    sessions.clear()
    return {}
  }

  async function probeNow() {
    const current = now()
    if (current - lastProbeAt < PROBE_INTERVAL_MS) throw new HttpError(429, '操作太频繁，请稍后再试')
    lastProbeAt = current
    const described = await credentials.describe(TOKEN_REF)
    if (!described?.configured) throw new HttpError(400, '尚未登录一木记账')
    const resolved = await credentials.resolve(TOKEN_REF)
    const token = String(resolved?.value ?? '')
    if (token === '') throw new HttpError(400, '凭据读取失败，请重新登录')
    try {
      return await probe({ token })
    } catch (error) {
      throw new HttpError(502, truncate(error instanceof Error ? error.message : String(error), 300))
    }
  }

  return { status, startLogin, pollLogin, logout, probe: probeNow, sessions }
}

/**
 * 读取并解析 JSON 请求体。
 * @param {AsyncIterable<Buffer>} req 请求流。
 * @param {number} [limit] 字节上限。
 * @returns {Promise<object>}
 */
export async function readJsonBody(req, limit = BODY_LIMIT_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, '请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON')
  }
  return parsed !== null && typeof parsed === 'object' ? parsed : {}
}

/** 输出 JSON 响应（no-store，禁止缓存登录态）。 */
function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(payload))
}

/**
 * 构造 `/api/yimu-bill` 前缀路由处理器。
 * @param {object} controller createLoginController 的返回值。
 * @param {object} [logger] 插件 logger。
 * @returns {(req: any, res: any) => Promise<void>}
 */
export function createHandler(controller, logger) {
  return async (req, res) => {
    let route
    try {
      route = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      route = '/'
    }
    const suffix = route.startsWith('/api/yimu-bill') ? route.slice('/api/yimu-bill'.length) || '/' : route
    try {
      if (suffix === '/status') {
        if (req.method !== 'GET') throw new HttpError(405, '只支持 GET')
        sendJson(res, 200, { ok: true, ...(await controller.status()) })
        return
      }
      if (suffix === '/login/start') {
        if (req.method !== 'POST') throw new HttpError(405, '只支持 POST')
        sendJson(res, 200, { ok: true, ...(await controller.startLogin()) })
        return
      }
      if (suffix === '/login/poll') {
        if (req.method !== 'POST') throw new HttpError(405, '只支持 POST')
        const body = await readJsonBody(req)
        sendJson(res, 200, { ok: true, ...(await controller.pollLogin(body.sessionId)) })
        return
      }
      if (suffix === '/logout') {
        if (req.method !== 'POST') throw new HttpError(405, '只支持 POST')
        sendJson(res, 200, { ok: true, ...(await controller.logout()) })
        return
      }
      if (suffix === '/probe') {
        if (req.method !== 'POST') throw new HttpError(405, '只支持 POST')
        sendJson(res, 200, { ok: true, ...(await controller.probe()) })
        return
      }
      throw new HttpError(404, '未知接口')
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      if (status >= 500) logger?.warn?.(`[yimu-bill] ${req.method} ${suffix} 失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, status, { ok: false, error: truncate(message, 300) })
    }
  }
}

/**
 * 插件入口：注册设置页使用的同源 HTTP API。
 * @param {object} ctx cordis 上下文（已注入 credentials/webServer）。
 * @param {object} [rawConfig] 插件行配置。
 */
export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...rawConfig }
  const serverPath = String(config.mcpServerPath ?? '').trim() || DEFAULT_SERVER_PATH
  const serverCwd = String(config.mcpServerCwd ?? '').trim() || path.dirname(path.dirname(serverPath))
  const probe =
    typeof config.probe === 'function'
      ? config.probe
      : (input) =>
          probeMcp({
            serverPath,
            serverCwd,
            token: input.token,
            timeoutMs: config.probeTimeoutMs,
          })
  const controller = createLoginController({
    credentials: ctx.credentials,
    ttlMs: config.loginTtlMs,
    probe,
  })
  const handler = createHandler(controller, ctx.logger)
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/api/yimu-bill',
        handler,
      }),
    'yimu-bill: /api/yimu-bill routes',
  )
}
