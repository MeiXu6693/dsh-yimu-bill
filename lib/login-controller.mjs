/**
 * 登录/状态/测试连接控制器。
 *
 * 与 HTTP 解耦：只负责扫码会话生命周期、限频、凭据写入与 probe 编排；
 * `plugin.mjs` 负责把它暴露成 `/api/yimu-bill/*`。
 *
 * @module dsh-yimu-bill/lib/login-controller
 */

import {
  DEFAULT_LOGIN_TTL_MS,
  PROBE_INTERVAL_MS,
  START_INTERVAL_MS,
  TOKEN_REF,
} from './constants.mjs'
import { qrDataUrl } from './qr.mjs'
import { jwtAudience, pollScanLogin, startScanLogin } from './yimu-api.mjs'

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

/** 错误信息截断。 */
function short(text, limit = 300) {
  const value = String(text ?? '')
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}

/**
 * 登录/状态/探测控制器。
 * @param {object} options
 * @param {object} options.credentials DSH 凭据服务（describe/resolve/set/unset）。
 * @param {{start: Function, poll: Function}} [options.loginApi] 官方扫码接口（测试注入）。
 * @param {(input: {token: string}) => Promise<object>} [options.probe] 测试连接实现。
 * @param {() => number} [options.now] 时钟。
 * @param {number} [options.ttlMs] 二维码有效期。
 * @returns {object}
 */
export function createLoginController({
  credentials,
  loginApi,
  probe,
  now = () => Date.now(),
  ttlMs = DEFAULT_LOGIN_TTL_MS,
}) {
  const api = loginApi ?? {
    start: () => startScanLogin(),
    poll: (sessionId) => pollScanLogin(sessionId),
  }
  const probeImpl =
    probe ??
    (async () => {
      throw new HttpError(501, '测试连接未配置')
    })

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
      throw new HttpError(502, `无法创建扫码会话：${short(error instanceof Error ? error.message : String(error))}`)
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
      return { state: 'error', error: short(error instanceof Error ? error.message : String(error)) }
    }
    if (result.state === 'ok') {
      try {
        await credentials.set(TOKEN_REF, result.jwt)
      } catch (error) {
        return { state: 'error', error: `保存凭据失败：${short(error instanceof Error ? error.message : String(error))}` }
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
      return await probeImpl({ token })
    } catch (error) {
      throw new HttpError(502, short(error instanceof Error ? error.message : String(error)))
    }
  }

  return { status, startLogin, pollLogin, logout, probe: probeNow, sessions }
}
