/**
 * dsh-go 原生面板：设置里没有 WebView 时，直接在手机 App 里显示二维码。
 *
 * 走 dsh-go 的 dshGo 原生插件协议（panel + image + actions）；只在有
 * `dshGo` 服务的主机上注册，DSH Web / 桌面端无副作用。二维码用 PNG
 * data URL，用户截图后到一木记账 App 扫码。
 *
 * @module dsh-yimu-bill/lib/native
 */

import { createLoginController } from './login-controller.mjs'
import { qrDataUrlPng } from './qr.mjs'
import { probeMcp, truncate } from '../mcp-host.mjs'

/** 面板 id，必须和 package.json 的 dshGo.contributes.panels[].id 一致。 */
export const PANEL_ID = 'yimu-login'

/** 已登录时用的 1x1 透明 PNG（面板 image 组件不能隐藏，只能换空白图）。 */
const TRANSPARENT_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function message(error) {
  return String((error && error.message) || error)
}

/**
 * 面板视图/数据/动作。
 * @param {object} controller createLoginController 的返回值。
 * @param {object} [options]
 * @param {(text: string) => Promise<string>} [options.qrPng] 测试注入。
 * @param {number} [options.intervalMs] 轮询间隔。
 * @returns {{view: Function, data: Function, actions: object}}
 */
export function createNativePanel(controller, { qrPng = qrDataUrlPng, intervalMs = 2000 } = {}) {
  const state = {
    qr: TRANSPARENT_PNG,
    statusText: '正在检查登录状态…',
    sessionId: '',
  }
  let emitData = null
  let timer = null
  let disposed = false

  const snapshot = () => ({ qr: state.qr, statusText: state.statusText })

  const emitState = () => {
    if (emitData !== null) emitData(snapshot())
  }

  const stopTimer = () => {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  const startTimer = () => {
    stopTimer()
    timer = setInterval(() => {
      void poll()
    }, intervalMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  async function poll() {
    if (disposed || state.sessionId === '') return
    try {
      const result = await controller.pollLogin(state.sessionId)
      if (result.state === 'ok') {
        state.sessionId = ''
        state.qr = TRANSPARENT_PNG
        state.statusText = `已登录${result.userId ? `（userId ${result.userId}）` : ''}`
        stopTimer()
        emitState()
      } else if (result.state === 'expired') {
        state.sessionId = ''
        state.qr = TRANSPARENT_PNG
        state.statusText = '二维码已过期，请点「刷新二维码」'
        stopTimer()
        emitState()
      }
    } catch (error) {
      state.statusText = `查询登录状态失败：${message(error)}`
      emitState()
    }
  }

  async function startLogin() {
    if (disposed) return
    try {
      const started = await controller.startLogin()
      state.sessionId = started.sessionId
      state.qr = await qrPng(`login:${started.sessionId}`)
      state.statusText = '请用一木记账 App 扫描二维码'
      emitState()
      startTimer()
    } catch (error) {
      state.sessionId = ''
      state.qr = TRANSPARENT_PNG
      state.statusText = `无法生成二维码：${message(error)}`
      emitState()
    }
  }

  async function checkStatus() {
    if (disposed) return
    try {
      const status = await controller.status()
      if (status.configured) {
        state.statusText = `已登录${status.userId ? `（userId ${status.userId}）` : ''}`
        state.qr = TRANSPARENT_PNG
        emitState()
        return
      }
    } catch {
      // 凭据服务异常时按未登录继续，让用户扫码。
    }
    await startLogin()
  }

  const slow = (label, timeoutMs, run) => ({
    pending: { label, timeoutMs },
    result: async () => {
      try {
        return await run()
      } catch (error) {
        return { toast: truncate(message(error), 40) }
      }
    },
  })

  return {
    view() {
      return {
        type: 'stack',
        title: '一木记账',
        children: [
          { type: 'text', text: { $: 'data.statusText' }, tone: 'muted' },
          {
            type: 'image',
            src: { $: 'data.qr' },
            aspect: 1,
            alt: '一木记账登录二维码',
          },
          {
            type: 'text',
            text: '截图后用一木记账 App【首页】→【更多】→【扫一扫】扫码。',
            tone: 'muted',
          },
          {
            type: 'actions',
            items: [
              { label: '刷新二维码', action: 'refresh', icon: 'refresh', style: 'primary' },
              { label: '测试连接', action: 'test', icon: 'check' },
              { label: '退出登录', action: 'logout', icon: 'remove', style: 'plain' },
            ],
          },
        ],
      }
    },

    data(_scope, emit) {
      disposed = false
      emitData = emit
      void checkStatus()
      return () => {
        disposed = true
        stopTimer()
        emitData = null
      }
    },

    actions: {
      refresh: () =>
        slow('正在刷新二维码', 10_000, async () => {
          await startLogin()
          return { patch: snapshot(), toast: '二维码已刷新' }
        }),
      test: () =>
        slow('正在测试连接', 30_000, async () => {
          const result = await controller.probe()
          return { toast: `连接正常（${result.tools} 个工具）` }
        }),
      logout: () =>
        slow('正在退出登录', 10_000, async () => {
          await controller.logout()
          state.sessionId = ''
          state.qr = TRANSPARENT_PNG
          state.statusText = '已退出登录'
          stopTimer()
          emitState()
          return { patch: snapshot(), toast: '已退出登录' }
        }),
    },
  }
}

/** dsh-go 原生插件行：只在有 dshGo 服务的主机上注册面板。 */
export const name = 'yimu-bill-native'

export const inject = ['credentials']

export function apply(ctx) {
  const controller = createLoginController({
    credentials: ctx.credentials,
    probe: (input) => probeMcp({ token: input.token, timeoutMs: 20_000 }),
  })
  ctx.inject(['dshGo'], (dshCtx) => {
    const panel = createNativePanel(controller)
    if (typeof dshCtx.effect === 'function') {
      dshCtx.effect(() => dshCtx.dshGo.panel(PANEL_ID, panel), 'yimu-bill-native: login panel')
    } else {
      dshCtx.dshGo.panel(PANEL_ID, panel)
    }
  })
}
