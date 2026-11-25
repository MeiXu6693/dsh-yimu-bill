# dsh-yimu-bill 开发文档

本文面向贡献者和维护者；终端用户的安装、登录、使用和安全说明见 [README.md](README.md)。

## 架构

```
dsh-go App                        DSH Web（浏览器 / 桌面端）
设置 → 插件 → 一木记账              设置 → 一木记账（明显入口）
原生面板 lib/native.mjs            设置 → 插件 → dsh-yimu-bill（详情页）
        │ ctx.inject(['dshGo'])     登录页 client.js（settings.section + bundle.config）
        │                                  │ 同源 fetch /api/yimu-bill/*
        └──────────────┬───────────────────┘
                       ▼
宿主半侧 plugin.mjs（全局行，不注册工具）
  ├─ 登录控制器 lib/login-controller.mjs ──► 官方扫码接口 lib/yimu-api.mjs
  ├─ 测试连接 ──► mcp-host.mjs ──► yimu-bill-cloud-mcp（临时进程，调 overview）
  ├─ /api/yimu-bill/* 路由 lib/web-api.mjs（网页版用）
  └─ 写 DSH 凭据 YIMU_TOKEN
                    │ credentials/reference-updated
                    ▼
记账模式 preset
  └─ tools.mjs（preset 作用域）
       ├─ 读 YIMU_TOKEN
       ├─ startMcpHost() ──► yimu-bill-cloud-mcp（常驻子进程）
       └─ 注册 yimu_* + yimu_status
```

- **同一套能力，两种界面**：登录控制器和 DSH 凭据只有一份；[dsh-go](https://github.com/ccch1mneyyy/dsh-go) App 用原生面板
  （`placement: "plugin"`，设置 → 插件 → 一木记账），DSH Web 用 React 登录页。
- 网页版登录页注册在两个位置：**设置 → 一木记账**（`settings.section`，明显的设置入口）
  和 **设置 → 插件 → dsh-yimu-bill** 的配置区（`plugins.bundle.config`）。
- dsh-go App 的网页岛里会自动**隐藏** `settings.section`（检测到 App 注入的 `DshGoIsland`
  通道就跳过注册）：App 把网页设置分区当网页岛打开，无法直接显示二维码，索性不展示这个打不开的入口。
  App 的二维码入口就是 **设置 → 插件 → 一木记账** 的原生面板。
- 原生面板注册必须发生在主入口 `plugin.mjs`：dsh-go 桥接只把「裸包名」的插件行归属到插件包，
  `dsh-yimu-bill/native` 这类子路径行无法归属，注册会被拒绝（详见 `release-notes/v0.2.3.md`）。
- 工具注册使用 Cordis 的「调用方作用域」语义：在 preset revision 内注册的工具，只对被绑定到该模式的会话可见。
- MCP server 由 npm 依赖 `yimu-bill-cloud-mcp` 提供；MCP SDK 从该依赖解析，插件不直接依赖 `@deepseek-ai` 包。

## 自定义

- 想把工具加到别的模式：在 `cordis.patch.yml` 里覆盖该 `preset-*` 行的 `config.plugins`，追加
  `- id: yimu-bill-tools` / `name: dsh-yimu-bill/tools`。参考 [`preset.example.yml`](preset.example.yml)。
  注意这会在用户补丁里写入该模式的完整配置覆写，DSH 升级标准模式时不会自动同步。
- 想改登录逻辑：`lib/login-controller.mjs` 是会话/限频入口，`lib/yimu-api.mjs` 是官方接口唯一入口；
  `plugin.mjs` 只负责装配、网页路由与原生面板注册。

## 开发

```bash
npm install
npm test        # 二维码 PNG + 接口契约 + 控制器 + schema 清洗 + 工具映射 + 网页 API + 面板注册
```

代码结构：

| 文件 | 职责 |
|---|---|
| `plugin.mjs` | DSH 入口：`apply` + 登录控制器装配 + 网页路由 + dsh-go 原生面板注册 |
| `lib/yimu-api.mjs` | 官方扫码接口唯一入口；接口变化只改这里 |
| `lib/login-controller.mjs` | 扫码会话、限频、凭据写入、测试连接 |
| `lib/qr.mjs` | 二维码 PNG data URL |
| `lib/web-api.mjs` | 网页版用的 `/api/yimu-bill/*` 路由处理器 |
| `lib/native.mjs` | dsh-go 原生面板：二维码、状态、测试、退出 |
| `lib/constants.mjs` | `TOKEN_REF` 等共享常量 |
| `client.js` | 网页版登录页（`settings.section` + `plugins.bundle.config`） |
| `tools.mjs` | 记账模式工具半（私有托管 MCP） |
| `mcp-host.mjs` | MCP 适配：schema 清洗、工具映射、探测 |

官方接口来自一木网页端，不是公开契约；若上游调整，只改 `lib/yimu-api.mjs`，并用
`test/plugin.test.mjs` 里的 fake fetch 契约测试固定信封解析。

## 发布

- 版本号同步：`package.json` 与 `package-lock.json`；服务端版本已改为运行时读取 `package.json`。
- 打 tag 并推送：`git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z`。
- tag 触发 [`.github/workflows/release.yml`](.github/workflows/release.yml)：测试 → 版本校验 →
  创建 GitHub Release（优先 `release-notes/<tag>.md`）；已在 Actions 中幂等处理重复 release。
- 可选 npm：仓库 Secrets 配置 `NPM_TOKEN`（stage-only 即可）后，workflow 先安装 npm 11，再执行 `npm stage publish`；未配置则跳过。
  staged 版本需维护者在 npm 上用 2FA 批准后才公开；发布状态以 `npm view dsh-yimu-bill version` 为准。
- CI 的 `npm pack --dry-run` 会校验 `files` 白名单，防止漏发 `lib/` 或客户端文件。
