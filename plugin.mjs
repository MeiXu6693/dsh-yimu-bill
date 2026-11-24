/**
 * dsh-yimu-bill — 一木记账 DSH 控制半入口。
 *
 * 只负责装配：把登录控制器暴露成 `/api/yimu-bill/*`，并提供「测试连接」的
 * MCP 探测。官方接口在 lib/yimu-api.mjs，二维码在 lib/qr.mjs，登录控制器在
 * lib/login-controller.mjs。
 *
 * 这里不注册任何 Agent 工具、不挂 MCP；记账工具由 tools.mjs 在「记账模式」
 * preset 的作用域内注册（见 cordis.patch.yml）。
 *
 * @module dsh-yimu-bill
 */

import path from 'node:path'
import { DEFAULT_SERVER_PATH, probeMcp, truncate } from './mcp-host.mjs'
import { DEFAULT_LOGIN_TTL_MS } from './lib/constants.mjs'
import { createLoginController, HttpError } from './lib/login-controller.mjs'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'yimu-bill'

/** 依赖的 host 服务。 */
export const inject = ['credentials', 'webServer']

/** 请求体上限。 */
const BODY_LIMIT_BYTES = 8_192

/** 插件默认配置；loader 的 config 覆盖。 */
const DEFAULTS = Object.freeze({
  /** 二维码有效期（展示与宿主侧过期判定）。 */
  loginTtlMs: DEFAULT_LOGIN_TTL_MS,
  /** 测试连接时 MCP 握手超时。 */
  probeTimeoutMs: 20_000,
  /** MCP 入口；留空时取相邻仓库。 */
  mcpServerPath: '',
  /** MCP 仓库工作目录；留空时取 serverPath 的仓库根。 */
  mcpServerCwd: '',
})

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
      if (status >= 500) {
        logger?.warn?.(
          `[yimu-bill] ${req.method} ${suffix} 失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`,
        )
      }
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
  const probe = (input) =>
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
