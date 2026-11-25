/**
 * dsh-yimu-bill — 一木记账 DSH 宿主半侧入口。
 *
 * 只做装配：
 *   - 网页半侧（DSH Web / 桌面端）：`/api/yimu-bill/*` 路由，给插件详情页的
 *     「一木记账」面板（client.js，plugins.bundle.config）用；
 *   - dsh-go App：通过 ctx.inject(['dshGo']) 注册同一个登录控制器的原生面板
 *     （设置 → 插件 → 一木记账，清单 placement: "plugin"）。
 * 两边共用同一个控制器和 DSH 凭据。
 *
 * 不注册 Agent 工具、不挂 MCP：记账工具由 tools.mjs 在「记账模式」preset
 * 的作用域内注册（见 cordis.patch.yml）。
 *
 * 官方接口在 lib/yimu-api.mjs，二维码在 lib/qr.mjs，登录状态在 lib/login-controller.mjs，
 * HTTP 适配在 lib/web-api.mjs。
 *
 * @module dsh-yimu-bill
 */

import path from 'node:path'
import { DEFAULT_SERVER_PATH, probeMcp } from './mcp-host.mjs'
import { DEFAULT_LOGIN_TTL_MS } from './lib/constants.mjs'
import { createLoginController } from './lib/login-controller.mjs'
import { createNativePanel, PANEL_ID } from './lib/native.mjs'
import { createHandler } from './lib/web-api.mjs'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'yimu-bill'

/** 依赖的 host 服务。 */
export const inject = ['credentials', 'webServer']

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
 * 插件入口：装配登录控制器并注册 dsh-go 原生面板。
 * @param {object} ctx cordis 上下文（已注入 credentials）。
 * @param {object} [rawConfig] 插件行配置。
 */
export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...rawConfig }
  const serverPath = String(config.mcpServerPath ?? '').trim() || DEFAULT_SERVER_PATH
  const serverCwd = String(config.mcpServerCwd ?? '').trim() || path.dirname(path.dirname(serverPath))
  const controller = createLoginController({
    credentials: ctx.credentials,
    ttlMs: config.loginTtlMs,
    probe: (input) =>
      probeMcp({
        serverPath,
        serverCwd,
        token: input.token,
        timeoutMs: config.probeTimeoutMs,
      }),
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
  // dsh-go 原生面板必须从主入口（裸包名插件行）注册：桥接按插件行名反查归属包，
  // `dsh-yimu-bill/native` 这类子路径行归属失败，panel() 会抛
  // "call ctx.dshGo.* as a method from a plugin context"。没有 dshGo 服务的主机不进回调。
  ctx.inject(['dshGo'], (dshCtx) => {
    dshCtx.dshGo.panel(PANEL_ID, createNativePanel(controller))
  })
}
