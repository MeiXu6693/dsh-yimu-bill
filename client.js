/**
 * dsh-yimu-bill — 网页半侧（DSH Web / 桌面端）。
 *
 * 把「一木记账」登录页注册到两个位置，共用同一个组件、同一个登录控制器：
 *   1. `settings.section`：设置 → 一木记账（明显入口；dsh-go App 里
 *      App 会自动生成一个「网页版」设置入口，打开的是网页岛）；
 *   2. `plugins.bundle.config`：设置 → 插件 → dsh-yimu-bill 的配置区。
 * 原生面板（设置 → 插件 → 一木记账）由宿主半侧注册给 dsh-go App，两边共享
 * 同一份 DSH 凭据，登录状态一致。
 *
 * 这是 DSH 的 static client bundle 格式（window.__ModuleLoader__.load），
 * 不打包 React、不 import 任何 DSH 包；所有宿主交互走同源 HTTP API。
 */

window.__ModuleLoader__.load({
  id: 'dsh-yimu-bill',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    // dsh-go App 的网页岛会注入 DshGoIsland 通道；App 里用原生面板
    // （设置 → 插件 → 一木记账），不再往 App 的设置首页塞一个只能当网页岛打开的
    // 网页设置页（App 无法把网页分区直接画成原生页面，会出现打不开的入口）。
    // 桌面 / 普通手机浏览器里保留 settings.section，设置首页就有明显的「一木记账」入口。
    const inDshGoApp =
      (typeof window === 'object' && window !== null && 'DshGoIsland' in window) ||
      /;\s*wv[);]/i.test(typeof navigator === 'undefined' ? '' : String(navigator.userAgent || ''))

    /** 宿主路由前缀。 */
    const API = '/api/yimu-bill'
    /** 记账模式在模式菜单里的显示名。 */
    const MODE_NAME = '记账模式'

    const CSS = `
.yimu-page{display:flex;flex-direction:column;gap:14px;max-width:680px;padding:2px 2px 28px;color:inherit;font-size:13px;line-height:1.65}
.yimu-card{border:1px solid rgba(128,128,128,.26);border-radius:12px;padding:16px 18px;background:rgba(128,128,128,.045)}
.yimu-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
.yimu-title{font-size:15px;font-weight:600}
.yimu-sub{font-size:12px;opacity:.66;margin:0 0 10px}
.yimu-badge{font-size:11px;line-height:18px;padding:0 8px;border-radius:999px;border:1px solid rgba(128,128,128,.4);opacity:.85;white-space:nowrap}
.yimu-badge-ok{color:#1a7f37;border-color:rgba(26,127,55,.5);background:rgba(26,127,55,.08)}
.yimu-badge-bad{color:#b35900;border-color:rgba(179,89,0,.45);background:rgba(179,89,0,.08)}
.yimu-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.yimu-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.yimu-btn{appearance:none;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;border-radius:8px;padding:6px 12px;font-size:13px;line-height:1.4;cursor:pointer}
.yimu-btn:hover:not(:disabled){background:rgba(128,128,128,.1)}
.yimu-btn-primary{border-color:#2f6feb;background:#2f6feb;color:#fff}
.yimu-btn-primary:hover:not(:disabled){background:#245bc4}
.yimu-btn-danger{color:#c62828;border-color:rgba(198,40,40,.5)}
.yimu-btn:disabled{opacity:.5;cursor:not-allowed}
.yimu-qr-box{display:flex;flex-direction:column;align-items:center;gap:6px;margin-top:14px;padding:12px;border-radius:12px;background:rgba(128,128,128,.07)}
.yimu-qr{display:block;width:200px;height:200px;background:#fff;border-radius:8px;padding:8px;image-rendering:pixelated}
.yimu-hint{font-size:12px;opacity:.7;margin:0}
.yimu-error{color:#c62828;margin:8px 0 0;font-size:12px;white-space:pre-wrap;word-break:break-word}
.yimu-ok{color:#1a7f37;margin:8px 0 0;font-size:12px;white-space:pre-wrap;word-break:break-word}
.yimu-pre{margin:8px 0 0;padding:8px 10px;border-radius:8px;background:rgba(128,128,128,.1);font-size:12px;white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto}
.yimu-list{margin:6px 0 0;padding-left:18px}
.yimu-list li{margin:2px 0}
`

    /** 同源调用宿主 API；非 2xx 或 ok:false 统一抛错。 */
    async function request(path, init = {}) {
      const options = { credentials: 'same-origin', ...init }
      if (options.body !== undefined && options.headers === undefined) {
        options.headers = { 'content-type': 'application/json' }
      }
      let response
      try {
        response = await fetch(API + path, options)
      } catch (error) {
        throw new Error(`无法连接 DSH 宿主：${error && error.message ? error.message : String(error)}`)
      }
      let data
      try {
        data = await response.json()
      } catch {
        throw new Error(`宿主返回了非 JSON 响应（HTTP ${response.status}）`)
      }
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || `请求失败（HTTP ${response.status}）`)
      }
      return data
    }

    /** 凭据来源的中文说明。 */
    function sourceText(source) {
      if (source === 'file') return '凭据文件'
      if (source === 'env') return '环境变量'
      return source || '未知'
    }

    /** 设置页主体。 */
    function YimuSettings() {
      const [status, setStatus] = useState(null)
      const [statusError, setStatusError] = useState('')
      const [loading, setLoading] = useState(true)
      const [phase, setPhase] = useState('idle')
      const [qr, setQr] = useState(null)
      const [notice, setNotice] = useState('')
      const [error, setError] = useState('')
      const [now, setNow] = useState(Date.now())
      const [probe, setProbe] = useState({ busy: false, ok: null, text: '' })
      const polling = useRef(false)

      const loadStatus = async () => {
        try {
          const data = await request('/status')
          setStatus(data)
          setStatusError('')
        } catch (err) {
          setStatusError(err.message)
        } finally {
          setLoading(false)
        }
      }

      useEffect(() => {
        void loadStatus()
      }, [])

      // 二维码倒计时：仅用于展示，真正的过期判定在宿主。
      useEffect(() => {
        if (qr === null) return undefined
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [qr])

      // 扫码轮询：进入 waiting 后每 2 秒问一次；登录成功/过期/错误即停。
      useEffect(() => {
        if (phase !== 'waiting' || qr === null) return undefined
        let cancelled = false
        const tick = async () => {
          if (polling.current) return
          polling.current = true
          try {
            const data = await request('/login/poll', {
              method: 'POST',
              body: JSON.stringify({ sessionId: qr.sessionId }),
            })
            if (cancelled) return
            if (data.state === 'ok') {
              setPhase('success')
              setQr(null)
              setError('')
              setNotice(`登录成功${data.userId ? `（user_id ${data.userId}）` : ''}，凭据已写入 DSH。`)
              await loadStatus()
            } else if (data.state === 'expired') {
              setPhase('expired')
              setError('二维码已过期，请重新获取。')
            } else if (data.state === 'error') {
              setPhase('error')
              setError(data.error || '查询扫码状态失败。')
            }
          } catch (err) {
            if (!cancelled) {
              setPhase('error')
              setError(err.message)
            }
          } finally {
            polling.current = false
          }
        }
        const timer = setInterval(() => {
          void tick()
        }, 2000)
        void tick()
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [phase, qr])

      const startLogin = async () => {
        setError('')
        setNotice('')
        setPhase('starting')
        try {
          const data = await request('/login/start', { method: 'POST' })
          setQr({ sessionId: data.sessionId, dataUrl: data.qr, expiresAt: data.expiresAt })
          setNow(Date.now())
          setPhase('waiting')
        } catch (err) {
          setPhase('error')
          setError(err.message)
        }
      }

      const logout = async () => {
        setError('')
        setNotice('')
        setPhase('idle')
        setQr(null)
        try {
          await request('/logout', { method: 'POST' })
          setNotice('已退出登录。')
          await loadStatus()
        } catch (err) {
          setError(err.message)
        }
      }

      const runProbe = async () => {
        setProbe({ busy: true, ok: null, text: '' })
        try {
          const data = await request('/probe', { method: 'POST' })
          setProbe({
            busy: false,
            ok: true,
            text: `连接正常：${data.tools} 个工具，耗时约 ${data.elapsedMs} ms。\n示例：${data.sample}`,
          })
        } catch (err) {
          setProbe({ busy: false, ok: false, text: err.message })
        }
      }

      const configured = Boolean(status && status.configured)
      const remaining = qr === null ? 0 : Math.max(0, Math.ceil((qr.expiresAt - now) / 1000))
      const busy = phase === 'starting'

      const accountCard = h(
        'section',
        { className: 'yimu-card', key: 'account' },
        h(
          'div',
          { className: 'yimu-head' },
          h('div', { className: 'yimu-title' }, '一木记账'),
          h(
            'span',
            { className: `yimu-badge ${configured ? 'yimu-badge-ok' : 'yimu-badge-bad'}` },
            configured ? '已登录' : '未登录',
          ),
        ),
        loading
          ? h('p', { className: 'yimu-sub' }, '正在读取登录状态…')
          : statusError
            ? h('p', { className: 'yimu-error' }, statusError)
            : h(
                'p',
                { className: 'yimu-sub' },
                configured
                  ? `账号 ${status.userId || '（未知）'}${status.source ? ` · 凭据来源：${sourceText(status.source)}` : ''}。`
                  : '尚未登录。扫码后 JWT 保存在 DSH 凭据库，不会写进配置文件。',
              ),
        h(
          'div',
          { className: 'yimu-actions' },
          h(
            'button',
            {
              type: 'button',
              className: `yimu-btn ${configured ? '' : 'yimu-btn-primary'}`,
              disabled: busy,
              onClick: () => {
                void startLogin()
              },
            },
            busy ? '正在申请二维码…' : qr === null ? (configured ? '重新登录' : '扫码登录') : '刷新二维码',
          ),
          configured
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'yimu-btn',
                  disabled: probe.busy,
                  onClick: () => {
                    void runProbe()
                  },
                },
                probe.busy ? '正在连接…' : '测试连接',
              )
            : null,
          configured
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'yimu-btn yimu-btn-danger',
                  onClick: () => {
                    void logout()
                  },
                },
                '退出登录',
              )
            : null,
        ),
        configured
          ? h(
              'p',
              { className: 'yimu-hint' },
              '退出登录只删除本机凭据；一木记账网页端没有提供服务端注销接口，服务端 token 不会因此失效。',
            )
          : null,
        qr === null
          ? null
          : h(
              'div',
              { className: 'yimu-qr-box' },
              h('img', { className: 'yimu-qr', src: qr.dataUrl, alt: '一木记账登录二维码', width: 200, height: 200 }),
              h(
                'p',
                { className: 'yimu-hint' },
                remaining > 0 ? `二维码约 ${remaining} 秒后过期。` : '二维码已过期，请刷新。',
              ),
              h('p', { className: 'yimu-hint' }, '一木记账 App → 首页 → 更多 → 扫一扫'),
            ),
        notice === '' ? null : h('p', { className: 'yimu-ok' }, notice),
        error === '' ? null : h('p', { className: 'yimu-error' }, error),
        probe.ok === null ? null : h('pre', { className: `yimu-pre ${probe.ok ? '' : 'yimu-error'}` }, probe.text),
      )

      const modeCard = h(
        'section',
        { className: 'yimu-card', key: 'mode' },
        h('div', { className: 'yimu-title' }, '在哪些任务里能用'),
        h(
          'p',
          { className: 'yimu-sub' },
          `记账工具只在「${MODE_NAME}」里出现。新建任务时在模式菜单里选择「${MODE_NAME}」，该任务就能查询、统计和记账；其他模式不会加载这些工具。`,
        ),
        h(
          'ul',
          { className: 'yimu-list' },
          h('li', null, '记账模式 = 标准模式的全部能力 + 一木记账工具，行为与标准模式一致。'),
          h('li', null, '登录/退出会立即影响新任务的工具；已经进行中的任务可能保持原状。'),
        ),
      )

      return h('div', { className: 'yimu-page' }, [accountCard, modeCard])
    }

    const plugin = {
      name: 'yimu-bill',
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.dataset.yimuBill = '1'
        style.textContent = CSS
        document.head.append(style)
        ctx.effect(() => () => style.remove(), 'yimu-bill: settings styles')
        // 1) 设置 → 一木记账：只在浏览器里注册（App 里隐藏，App 用原生面板）。
        if (!inDshGoApp) {
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: 'yimu-bill', order: 27, label: '一木记账' },
              YimuSettings,
            ),
          )
        }
        // 2) 设置 → 插件 → dsh-yimu-bill：插件详情页的配置区（网页版）。
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            { name: 'plugins.bundle.config', key: 'dsh-yimu-bill' },
            YimuSettings,
          ),
        )
      },
    }

    return plugin
  },
})
