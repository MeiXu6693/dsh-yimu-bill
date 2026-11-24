import { test } from 'node:test'
import assert from 'node:assert/strict'
import jsQR from 'jsqr'
import * as plugin from '../plugin.mjs'

/** 最小 ctx 桩：只实现插件用到的服务，MCP 注册在测试里不启用。 */
function harness(config = {}) {
  const defs = new Map()
  const calls = { set: [], unset: [] }
  const ctx = {
    tools: {
      register(definition) {
        assert.ok(!defs.has(definition.name), `重复注册 ${definition.name}`)
        defs.set(definition.name, definition)
        return () => {}
      },
    },
    credentials: {
      async set(ref, value) {
        calls.set.push([ref, value])
      },
      async unset(ref) {
        calls.unset.push(ref)
      },
      async describe() {
        return { configured: false }
      },
      async resolve() {
        return undefined
      },
    },
    get: () => undefined,
    effect: (fn) => fn(),
    logger: { warn() {} },
  }
  plugin.apply(ctx, config)
  return { defs, calls, ctx }
}

test('插件元信息', () => {
  assert.equal(plugin.name, 'yimu-bill')
  assert.deepEqual(plugin.inject, ['tools', 'credentials'])
})

test('注册四个登录工具，参数 schema 结构合法', () => {
  const { defs } = harness()
  assert.deepEqual([...defs.keys()], [
    'yimu_login',
    'yimu_login_wait',
    'yimu_login_status',
    'yimu_logout',
  ])
  for (const def of defs.values()) {
    assert.equal(def.parameters.type, 'object')
    assert.equal(typeof def.description, 'string')
    assert.equal(typeof def.execute, 'function')
    assert.equal(typeof def.output.render, 'function')
    assert.equal(def.output.schema.type, 'object')
  }
  const wait = defs.get('yimu_login_wait')
  assert.deepEqual(wait.parameters.required, ['session_id'])
  assert.equal(wait.parameters.properties.session_id.type, 'string')
  assert.equal(wait.parameters.properties.timeout_seconds.type, 'integer')
})

test('yimu_login_status / yimu_logout 可执行且可渲染', async () => {
  const { defs, calls } = harness()
  const status = await defs.get('yimu_login_status').execute({}, {})
  assert.deepEqual(status, { configured: false })
  assert.match(defs.get('yimu_login_status').output.render({}, status)[0].text, /未登录/)

  const out = await defs.get('yimu_logout').execute({}, {})
  assert.deepEqual(out, { ok: true })
  assert.deepEqual(calls.unset, ['YIMU_TOKEN'])
})

test('registerMcp 未配置 serverPath 时跳过注册且不抛错', () => {
  assert.doesNotThrow(() => harness({ registerMcp: true }))
  assert.doesNotThrow(() => harness({ registerMcp: false }))
})

test('二维码文本能被 jsQR 解回原内容', () => {
  const payload = 'login:0123456789abcdef0123456789abcdef'
  const text = plugin.renderQrText(payload)
  const lines = text.split('\n')
  const rows = lines.length * 2
  const cols = lines[0].length
  const scale = 6
  const width = cols * scale
  const height = rows * scale
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255)
  const dark = (row, col) => {
    const ch = lines[Math.floor(row / 2)][col]
    return row % 2 === 0 ? ch === '█' || ch === '▀' : ch === '█' || ch === '▄'
  }
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (!dark(row, col)) continue
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
