/**
 * 一木记账网页端接口的唯一入口。
 *
 * 目前只依赖公开网页端的两个扫码接口：
 *   POST /scanLogin/addScanLogin                 -> { result: sessionId }
 *   GET  /scanLogin/getScanLogin/{sessionId}     -> 待扫 { code: 1, msg: 'no data' }
 *                                                   成功 { code: 0, result: user, token: jwt }
 *
 * 官方接口若调整，只改本文件；上层控制器通过注入的 loginApi 隔离，测试用
 * fake fetch 覆盖信封解析，不需要真实网络。
 *
 * @module dsh-yimu-bill/lib/yimu-api
 */

const API_BASE = 'https://yimubill.com/api'
const ORIGIN = 'https://yimubill.com'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36'
const REQUEST_TIMEOUT_MS = 15_000

const HEADERS = {
  'user-agent': USER_AGENT,
  referer: `${ORIGIN}/`,
  accept: 'application/json, text/plain, */*',
}

/** 错误信息截断，避免把上游大段文本塞进 GUI。 */
function short(text, limit = 200) {
  const value = String(text ?? '')
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}

/**
 * 调官方接口，返回原始 JSON（不解信封）。
 * @param {string} pathname 接口路径。
 * @param {object} [init] fetch 参数。
 * @param {number} [timeoutMs] 超时。
 * @param {typeof fetch} [fetchImpl] 测试注入。
 * @returns {Promise<any>}
 */
export async function call(pathname, init = {}, timeoutMs = REQUEST_TIMEOUT_MS, fetchImpl = fetch) {
  const response = await fetchImpl(`${API_BASE}${pathname}`, {
    ...init,
    headers: { ...HEADERS, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`一木接口 HTTP ${response.status}`)
  return await response.json()
}

/**
 * 申请扫码登录会话，返回 sessionId（二维码内容为 `login:<sessionId>`）。
 * @param {typeof fetch} [fetchImpl] 测试注入。
 * @returns {Promise<string>}
 */
export async function startScanLogin(fetchImpl = fetch) {
  const data = await call('/scanLogin/addScanLogin', { method: 'POST' }, REQUEST_TIMEOUT_MS, fetchImpl)
  const sessionId = data?.result
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error(`扫码会话创建失败：${short(JSON.stringify(data))}`)
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
  const data = await call(`/scanLogin/getScanLogin/${encodeURIComponent(sessionId)}`, {}, REQUEST_TIMEOUT_MS, fetchImpl)
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

/**
 * JWT 里的 aud（= userId），仅用于展示，不参与鉴权。
 * @param {unknown} jwt
 * @returns {string}
 */
export function jwtAudience(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(String(jwt).split('.')[1] ?? '', 'base64url').toString('utf8'))
    return String(payload.aud ?? payload.userId ?? '')
  } catch {
    return ''
  }
}
