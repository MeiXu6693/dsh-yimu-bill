import { test } from 'node:test'
import assert from 'node:assert/strict'
import jsQR from 'jsqr'
import * as plugin from '../plugin.mjs'
import * as tools from '../tools.mjs'
import * as qr from '../lib/qr.mjs'
import { createLoginController, HttpError } from '../lib/login-controller.mjs'
import { TOKEN_REF } from '../lib/constants.mjs'
import { jwtAudience, pollScanLogin, startScanLogin } from '../lib/yimu-api.mjs'
import {
  DEFAULT_SERVER_PATH,
  prefixedToolName,
  registerMcpTools,
  sanitizeToolSchema,
  textOfToolResult,
} from '../mcp-host.mjs'

/** 最小凭据服务桩。 */
function fakeCredentials(initial = {}) {
  let configured = Boolean(initial.configured)
  let token = initial.token ?? ''
  const calls = { set: [], unset: [], describe: 0, resolve: 0 }
  return {
    calls,
    async describe() {
      calls.describe += 1
      return configured ? { configured: true, source: 'file' } : { configured: false }
    },
    async resolve() {
      calls.resolve += 1
      return configured ? { value: token, source: 'file' } : undefined
    },
    async set(ref, value) {
      calls.set.push([ref, value])
      configured = true
      token = value
    },
    async unset(ref) {
      calls.unset.push(ref)
      configured = false
      token = ''
    },
  }
}

/** 构造一个 aud 可读的假 JWT（不用于校验签名）。 */
function fakeJwt(aud) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ aud, exp: 9999999999 })).toString('base64url')
  return `${header}.${payload}.signature`
}

/** 控制器测试用的固定时钟。 */
function clock(startAt = 1_000) {
  let current = startAt
  return {
    now: () => current,
    advance: (ms) => {
      current += ms
    },
  }
}

/** 假响应对象。 */
function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
    },
    end(body) {
      this.body = body ?? ''
    },
  }
}

/** 构造可迭代请求体。 */
function fakeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** 建一个可用的控制器（默认真实控制器 + 假官方接口）。 */
function harness(options = {}) {
  const credentials = fakeCredentials(options.credentials)
  const time = clock(options.now)
  const loginApi = options.loginApi ?? {
    start: () => Promise.resolve('session-1'),
    poll: () => Promise.resolve({ state: 'pending' }),
  }
  const controller = createLoginController({
    credentials,
    loginApi,
    probe: options.probe ?? (() => Promise.resolve({ tools: 11, sample: 'ok', elapsedMs: 12 })),
    now: time.now,
    ttlMs: options.ttlMs ?? 120_000,
  })
  return { controller, credentials, time, loginApi }
}

test('模块元信息', () => {
  assert.equal(plugin.name, 'yimu-bill')
  assert.deepEqual(plugin.inject, ['credentials', 'webServer'])
  assert.equal(tools.name, 'yimu-bill-tools')
  assert.deepEqual(tools.inject, ['tools', 'credentials'])
})

test('二维码矩阵能被 jsQR 解回原内容', () => {
  const payload = 'login:0123456789abcdef0123456789abcdef'
  const { size, rows } = qr.qrMatrix(payload, 4)
  const scale = 6
  const width = size * scale
  const height = size * scale
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (!rows[row][col]) continue
      for (let y = 0; y < scale; y += 1) {
        for (let x = 0; x < scale; x += 1) {
          const index = ((row * scale + y) * width + (col * scale + x)) * 4
          pixels[index] = 0
          pixels[index + 1] = 0
          pixels[index + 2] = 0
        }
      }
    }
  }
  const decoded = jsQR(pixels, width, height)
  assert.ok(decoded, '二维码未被识别')
  assert.equal(decoded.data, payload)
})

test('二维码 SVG / data URL 结构正确', () => {
  const svg = qr.renderQrSvg('login:abc')
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.match(svg, /<path /)
  const url = qr.qrDataUrl('login:abc')
  assert.match(url, /^data:image\/svg\+xml;base64,/)
  assert.match(Buffer.from(url.split(',')[1], 'base64').toString('utf8'), /^<svg /)
})

test('官方扫码接口：会话创建与状态信封', async () => {
  const start = async () => ({ ok: true, status: 200, json: async () => ({ result: 'session-9' }) })
  assert.equal(await startScanLogin(start), 'session-9')
  await assert.rejects(
    startScanLogin(async () => ({ ok: true, status: 200, json: async () => ({}) })),
    /扫码会话创建失败/,
  )
  await assert.rejects(
    startScanLogin(async () => ({ ok: false, status: 503, json: async () => ({}) })),
    /HTTP 503/,
  )

  const ok = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ code: 0, token: 'jwt', result: { id: 7, email: 'a@b.c' } }),
  })
  assert.deepEqual(await pollScanLogin('s', ok), {
    state: 'ok',
    jwt: 'jwt',
    userId: '7',
    user: { id: 7, email: 'a@b.c' },
  })
  const pending = async () => ({ ok: true, status: 200, json: async () => ({ code: 1, msg: 'no data' }) })
  assert.deepEqual(await pollScanLogin('s', pending), { state: 'pending' })
  const odd = async () => ({ ok: true, status: 200, json: async () => ({ code: 2, msg: 'x' }) })
  await assert.rejects(pollScanLogin('s', odd), /code=2/)
})

test('官方扫码接口：JWT aud 解析', () => {
  assert.equal(jwtAudience(fakeJwt('user-1')), 'user-1')
  assert.equal(jwtAudience('bad'), '')
  assert.equal(jwtAudience(undefined), '')
})

test('包自引用导出与默认 MCP 入口', async () => {
  const exported = await import('dsh-yimu-bill/tools')
  assert.equal(exported.name, 'yimu-bill-tools')
  assert.equal(typeof exported.apply, 'function')
  assert.match(DEFAULT_SERVER_PATH, /yimu-bill-cloud-mcp\/src\/index\.js$/)
})

test('控制器：未登录状态', async () => {
  const { controller } = harness()
  assert.deepEqual(await controller.status(), { configured: false, userId: '', source: '' })
})

test('控制器：扫码开始 → 轮询成功写凭据', async () => {
  const jwt = fakeJwt('user-1')
  const { controller, credentials } = harness({
    loginApi: {
      start: () => Promise.resolve('session-1'),
      poll: () => Promise.resolve({ state: 'ok', jwt, userId: 'user-1', user: { email: 'a@b.c' } }),
    },
  })
  const started = await controller.startLogin()
  assert.equal(started.sessionId, 'session-1')
  assert.match(started.qr, /^data:image\/svg\+xml;base64,/)
  assert.equal(started.expiresAt, 1_000 + 120_000)

  const polled = await controller.pollLogin('session-1')
  assert.deepEqual(polled, { state: 'ok', userId: 'user-1', email: 'a@b.c' })
  assert.deepEqual(credentials.calls.set, [[TOKEN_REF, jwt]])
  assert.equal(controller.sessions.size, 0)
  assert.equal((await controller.status()).configured, true)
})

test('控制器：开始扫码限频', async () => {
  const { controller } = harness()
  await controller.startLogin()
  await assert.rejects(() => controller.startLogin(), (error) => error.status === 429)
})

test('控制器：二维码过期与轮询错误', async () => {
  const { controller, time } = harness({
    ttlMs: 100,
    loginApi: {
      start: () => Promise.resolve('session-1'),
      poll: () => Promise.reject(new Error('上游超时')),
    },
  })
  await controller.startLogin()
  time.advance(50)
  assert.deepEqual(await controller.pollLogin('session-1'), { state: 'error', error: '上游超时' })
  time.advance(100)
  assert.deepEqual(await controller.pollLogin('session-1'), { state: 'expired' })
  assert.deepEqual(await controller.pollLogin('unknown'), { state: 'expired' })
})

test('控制器：退出登录清凭据与在途会话', async () => {
  const { controller, credentials } = harness({ credentials: { configured: true, token: 't' } })
  await controller.startLogin()
  assert.deepEqual(await controller.logout(), {})
  assert.deepEqual(credentials.calls.unset, [TOKEN_REF])
  assert.equal(controller.sessions.size, 0)
})

test('控制器：测试连接的限频与未登录拒绝', async () => {
  const { controller } = harness()
  await assert.rejects(() => controller.probe(), (error) => error.status === 400)

  const logged = harness({ credentials: { configured: true, token: 't' } })
  const result = await logged.controller.probe()
  assert.equal(result.tools, 11)
  await assert.rejects(() => logged.controller.probe(), (error) => error.status === 429)
})

test('控制器：测试连接把上游错误映射为 502', async () => {
  const { controller } = harness({
    credentials: { configured: true, token: 't' },
    probe: () => Promise.reject(new Error('云端网络暂时不可用')),
  })
  await assert.rejects(() => controller.probe(), (error) => error.status === 502 && /网络暂时不可用/.test(error.message))
})

test('MCP schema 清洗：去掉 $schema/format，保留允许关键字', () => {
  const clean = sanitizeToolSchema({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    required: ['type'],
    properties: {
      type: { type: 'string', enum: ['expense', 'income'], format: 'text', description: '类型' },
      month: { type: 'string', title: '月份', default: '2026-11', minLength: 7 },
    },
  })
  assert.equal(clean.$schema, undefined)
  assert.equal(clean.type, 'object')
  assert.equal(clean.additionalProperties, false)
  assert.deepEqual(clean.required, ['type'])
  assert.deepEqual(clean.properties.type.enum, ['expense', 'income'])
  assert.equal(clean.properties.type.description, '类型')
  assert.equal(clean.properties.type.format, undefined)
  assert.equal(clean.properties.month.title, '月份')
  assert.equal(clean.properties.month.default, '2026-11')
  assert.equal(clean.properties.month.minLength, undefined)
  assert.deepEqual(clean.properties.month.properties, undefined)
})

test('MCP schema 清洗：anyOf 收敛为 oneOf，根不是 object 时兜底', () => {
  const clean = sanitizeToolSchema({
    type: 'object',
    properties: { value: { anyOf: [{ type: 'string' }, { type: 'number' }] } },
  })
  assert.equal(clean.properties.value.oneOf.length, 2)
  assert.deepEqual(sanitizeToolSchema({ type: 'string' }), {
    type: 'object',
    additionalProperties: true,
    properties: {},
  })
})

test('工具映射：前缀、schema、execute、render、dispose', async () => {
  const defs = new Map()
  const ctx = {
    tools: {
      register(definition) {
        defs.set(definition.name, definition)
        return () => defs.delete(definition.name)
      },
    },
  }
  const calls = []
  const host = {
    tools: [
      { name: 'overview', description: '摘要', inputSchema: { type: 'object', properties: {} } },
      { name: 'bill_add', description: '记一笔', inputSchema: { type: 'object', properties: {} } },
    ],
    async callText(name, args) {
      calls.push([name, args])
      return `result:${name}`
    },
  }
  const off = registerMcpTools(ctx, host, { prefix: 'yimu_' })
  assert.deepEqual([...defs.keys()], ['yimu_overview', 'yimu_bill_add'])
  assert.equal(defs.get('yimu_overview').description, '摘要')
  assert.equal(defs.get('yimu_overview').parameters.type, 'object')
  assert.equal(defs.get('yimu_overview').output.schema.type, 'object')

  const value = await defs.get('yimu_overview').execute({ month: '2026-11' })
  assert.deepEqual(value, { text: 'result:overview' })
  assert.deepEqual(calls, [['overview', { month: '2026-11' }]])
  assert.deepEqual(defs.get('yimu_overview').output.render({}, value), [
    { type: 'text', text: 'result:overview' },
  ])

  off()
  assert.equal(defs.size, 0)
})

test('MCP 工具结果：isError 抛错，空文本回退结构化内容', () => {
  assert.throws(() => textOfToolResult({ isError: true, content: [{ type: 'text', text: 'boom' }] }), /boom/)
  assert.equal(textOfToolResult({ content: [{ type: 'text', text: 'ok' }] }), 'ok')
  assert.equal(textOfToolResult({ structuredContent: { a: 1 }, content: [] }), '{"a":1}')
  assert.equal(prefixedToolName('yimu_', 'query_bills'), 'yimu_query_bills')
})

test('工具半：未登录时只注册 yimu_status', async () => {
  const defs = new Map()
  const ctx = {
    tools: { register: (definition) => (defs.set(definition.name, definition), () => defs.delete(definition.name)) },
    credentials: {
      async resolve() {
        return undefined
      },
      async describe() {
        return { configured: false }
      },
    },
    effect(fn) {
      fn()
      return () => {}
    },
    on() {
      return () => {}
    },
    logger: { info() {}, warn() {} },
  }
  await tools.apply(ctx, { readyWaitMs: 20 })
  assert.deepEqual([...defs.keys()], ['yimu_status'])
  const value = await defs.get('yimu_status').execute({})
  assert.equal(value.configured, false)
  assert.match(defs.get('yimu_status').output.render({}, value)[0].text, /扫码登录/)
})

test('工具半：MCP 启动失败不抛错，状态工具给出原因', async () => {
  const defs = new Map()
  const cleanups = []
  const ctx = {
    tools: { register: (definition) => (defs.set(definition.name, definition), () => defs.delete(definition.name)) },
    credentials: {
      async resolve() {
        return { value: 'fake-token' }
      },
      async describe() {
        return { configured: true }
      },
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return dispose
    },
    on() {
      return () => {}
    },
    logger: { info() {}, warn() {} },
  }
  await tools.apply(ctx, {
    serverPath: '/nonexistent/yimu/src/index.js',
    serverCwd: '/nonexistent/yimu',
    startupTimeoutMs: 50,
    readyWaitMs: 500,
  })
  assert.deepEqual([...defs.keys()], ['yimu_status'])
  const value = await defs.get('yimu_status').execute({})
  assert.equal(value.configured, true)
  assert.equal(value.connected, false)
  assert.notEqual(value.error, '')
  for (const dispose of cleanups) dispose()
})

test('控制半 handler：路由、方法、JSON 体与错误映射', async () => {
  const controller = {
    status: async () => ({ configured: true }),
    startLogin: async () => ({ sessionId: 's1' }),
    pollLogin: async (sessionId) => ({ state: 'pending', sessionId }),
    logout: async () => ({}),
    probe: async () => ({ tools: 11 }),
  }
  const handler = plugin.createHandler(controller)

  const statusRes = fakeRes()
  await handler(fakeReq('GET', '/api/yimu-bill/status'), statusRes)
  assert.equal(statusRes.status, 200)
  assert.deepEqual(JSON.parse(statusRes.body), { ok: true, configured: true })

  const pollRes = fakeRes()
  await handler(fakeReq('POST', '/api/yimu-bill/login/poll', { sessionId: 's1' }), pollRes)
  assert.equal(pollRes.status, 200)
  assert.deepEqual(JSON.parse(pollRes.body), { ok: true, state: 'pending', sessionId: 's1' })

  const badMethod = fakeRes()
  await handler(fakeReq('GET', '/api/yimu-bill/login/start'), badMethod)
  assert.equal(badMethod.status, 405)

  const unknown = fakeRes()
  await handler(fakeReq('GET', '/api/yimu-bill/nope'), unknown)
  assert.equal(unknown.status, 404)

  const badJson = fakeRes()
  await handler(fakeReq('POST', '/api/yimu-bill/login/poll', 'not-json'), badJson)
  assert.equal(badJson.status, 400)
  assert.equal(JSON.parse(badJson.body).ok, false)

  const failing = plugin.createHandler({
    ...controller,
    status: async () => {
      throw new HttpError(418, '我是茶壶')
    },
  })
  const failingRes = fakeRes()
  await failing(fakeReq('GET', '/api/yimu-bill/status'), failingRes)
  assert.equal(failingRes.status, 418)
  assert.deepEqual(JSON.parse(failingRes.body), { ok: false, error: '我是茶壶' })
})

test('控制半 apply：注册 /api/yimu-bill 前缀路由', () => {
  const routes = []
  const ctx = {
    credentials: fakeCredentials(),
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(fn) {
      fn()
      return () => {}
    },
    logger: { warn() {} },
  }
  plugin.apply(ctx, {})
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/api/yimu-bill')
  assert.equal(typeof routes[0].handler, 'function')
})
