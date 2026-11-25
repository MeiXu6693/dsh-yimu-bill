/**
 * 网页半侧用的同源 HTTP API：把登录控制器暴露成 `/api/yimu-bill/*`。
 *
 * 只在浏览器（DSH Web / 桌面端）的插件详情页里使用；dsh-go App 用原生面板，
 * 不经过这些路由。
 *
 * @module dsh-yimu-bill/lib/web-api
 */

import { LoginError } from './login-controller.mjs'
import { truncate } from '../mcp-host.mjs'

/** 请求体上限。 */
const BODY_LIMIT_BYTES = 8_192

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
    if (size > limit) throw new LoginError(413, '请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  let parsed
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new LoginError(400, '请求体不是合法 JSON')
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
        if (req.method !== 'GET') throw new LoginError(405, '只支持 GET')
        sendJson(res, 200, { ok: true, ...(await controller.status()) })
        return
      }
      if (suffix === '/login/start') {
        if (req.method !== 'POST') throw new LoginError(405, '只支持 POST')
        sendJson(res, 200, { ok: true, ...(await controller.startLogin()) })
        return
      }
      if (suffix === '/login/poll') {
        if (req.method !== 'POST') throw new LoginError(405, '只支持 POST')
        const body = await readJsonBody(req)
        sendJson(res, 200, { ok: true, ...(await controller.pollLogin(body.sessionId)) })
        return
      }
      if (suffix === '/logout') {
        if (req.method !== 'POST') throw new LoginError(405, '只支持 POST')
        sendJson(res, 200, { ok: true, ...(await controller.logout()) })
        return
      }
      if (suffix === '/probe') {
        if (req.method !== 'POST') throw new LoginError(405, '只支持 POST')
        sendJson(res, 200, { ok: true, ...(await controller.probe()) })
        return
      }
      throw new LoginError(404, '未知接口')
    } catch (error) {
      const status = error instanceof LoginError ? error.status : 500
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
