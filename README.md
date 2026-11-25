# dsh-yimu-bill

一木记账（[yimubill.com](https://yimubill.com)）的 **DSH 插件**：dsh-go 原生扫码登录 + 「记账模式」预设 + 私有托管的记账 MCP 兼容层。

MCP 本体在独立仓库 [`MeiXu6693/yimu-bill-cloud-mcp`](https://github.com/MeiXu6693/yimu-bill-cloud-mcp)（11 个语义化工具）；本仓库只做 DSH 宿主侧的登录、模式与工具映射。

> 非官方项目，与一木记账官方无关联。接口来自其公开网页端，升级后可能失效。

## 能力

- **扫码登录**：dsh-go App 走 **设置 → 插件 → 一木记账** 的原生面板；DSH Web / 桌面端走 **设置 → 一木记账** 的网页登录页。两边共用同一个登录控制器和 DSH 凭据（ref `YIMU_TOKEN`），不写任何配置文件。
- **测试连接**：用当前凭据拉起 MCP 并真实调用 `overview`，当场确认 token 与链路可用。
- **记账模式**：内置 agent preset「记账模式」= **标准模式的完整复制 + 末尾一行记账工具**。只有新建任务时选择该模式，才会加载一木记账工具；标准、极简、创造等模式完全不受影响。
- **私有 MCP 兼容层**：不经过 DSH 的 `mcpManager` / `@deepseek-ai/dsh-mcp-client`。插件自己作为 MCP 宿主，以 stdio 拉起 `yimu-bill-cloud-mcp`，把 `listTools()` 映射成当前 preset 作用域内的原生 DSH 工具；MCP 进程退出即撤工具。
- **凭据热更新**：登录/退出触发 `credentials/reference-updated`，记账工具随之连接或撤下，无需重启 DSH。

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

- **同一套能力，两种界面**：登录控制器和 DSH 凭据只有一份；dsh-go App 用原生面板
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

## 安装

要求 DSH 0.2.x（web profile）。**不需要克隆仓库，也不需要编译**：插件和 MCP 都以 npm 包发布，
MCP 作为 `dsh-yimu-bill` 的依赖自动安装。

### 1. 安装插件

推荐在 DSH Web 的「设置 → 插件」里安装/启用 `dsh-yimu-bill`；或命令行：

```bash
dsh plugin --profile web add dsh-yimu-bill
```

`dsh plugin add` 会把包装进 profile，并因为插件声明了 `dsh.bundle` 自动加入
`dsh.profile.bundles`。安装/升级后重启一次 DSH（网页半侧在进程启动时扫描 client bundle）：
重启后去哪找：

| 宿主 | 位置 |
|---|---|
| dsh-go App | **设置 → 插件 → 已安装 → 一木记账**（详情页里的原生二维码面板） |
| DSH Web / 桌面端 | **设置 → 一木记账**（明显的设置入口），或 设置 → 插件 → dsh-yimu-bill 的配置区 |

App 里不再显示「设置 → 一木记账」网页入口（App 只能把它当网页岛打开，显示不出二维码；
插件在 App 网页岛里会自动隐藏该入口）。

> 不需要单独 clone/安装 `yimu-bill-cloud-mcp`，也不需要 `pnpm install` 手动构建；
> 插件依赖会带下 MCP 及其 SDK。

### 2. 登录

两个入口共用同一份登录态：

- **dsh-go App**：设置 → 插件 → 一木记账 → 点「刷新二维码」（未登录时打开面板即出码）→
  截图 → 用一木记账 App【首页】-【更多】-【扫一扫】扫码；
  （App 里不显示「设置 → 一木记账」网页入口，直接在插件详情页操作即可。）
- **DSH Web / 桌面端**：设置 → 一木记账（明显入口），或 设置 → 插件 → dsh-yimu-bill
  的配置区 → 点「扫码登录」→ 用一木记账 App 扫码。

- 二维码有效期约 120 秒，过期点「刷新二维码 / 重新登录」。
- 退出登录会删除 DSH 凭据，记账模式工具随之撤下。
- headless 场景：把网页版 JWT 放进 DSH 凭据库的 `YIMU_TOKEN`（或进程环境变量）即可。

### 3. 使用

新建任务时在模式菜单里选择 **记账模式**（自定义分组）。该任务的工具列表里会出现：

| 工具 | 对应 MCP 工具 |
|---|---|
| `yimu_overview` | `overview` |
| `yimu_query_bills` | `query_bills` |
| `yimu_stats` | `stats` |
| `yimu_accounts` | `accounts` |
| `yimu_bill_add` | `bill_add` |
| `yimu_bills_add` | `bills_add` |
| `yimu_bill_update` | `bill_update` |
| `yimu_bill_delete` | `bill_delete` |
| `yimu_transfer_add` | `transfer_add` |
| `yimu_report` | `report` |
| `yimu_admin` | `admin` |
| `yimu_status` | 插件自带：登录/MCP/工具状态 |

未登录时只有 `yimu_status`，它会提示去设置页或 dsh-go 原生面板扫码。

### 4. 原生面板

dsh-go App 的原生面板是唯一的二维码入口：

- **设置 → 插件 → 已安装 → 一木记账** → 详情页里的「一木记账」面板；
- 面板里显示二维码、登录状态，按钮有「刷新二维码 / 测试连接 / 退出登录」；
- 截图二维码，再到一木记账 App【首页】→【更多】→【扫一扫】扫码即可；
- dsh-go 原生协议没有“保存到系统相册”的动作，系统截图即可；
- 登录成功后写 DSH 凭据，记账模式立即可用；
- 面板不新增 TTL/超时/MCP 路径等设置项，全部使用默认值。

DSH Web 的网页版是同一个登录控制器的 React 页面，入口在 **设置 → 一木记账**
以及 **设置 → 插件 → dsh-yimu-bill** 的插件详情页；两个界面看到的是同一份登录状态。

## 配置项

控制半（全局行）：

| 键 | 默认 | 说明 |
|---|---|---|
| `loginTtlMs` | `120000` | 二维码有效期（展示与宿主过期判定） |
| `probeTimeoutMs` | `20000` | 「测试连接」时的 MCP 握手超时 |
| `mcpServerPath` | 空 | MCP 入口；留空取相邻仓库 `../yimu-bill-cloud-mcp/src/index.js` |
| `mcpServerCwd` | 空 | MCP 工作目录；留空取 `serverPath` 的仓库根 |

工具半（preset 行）：

| 键 | 默认 | 说明 |
|---|---|---|
| `serverPath` | 相邻仓库 | 同上，配对工具半使用 |
| `serverCwd` | 相邻仓库根 | 同上 |
| `toolPrefix` | `yimu_` | 工具名前缀 |
| `startupTimeoutMs` | `20000` | MCP 握手/列工具超时 |
| `readyWaitMs` | `10000` | 会话创建最多等待 MCP 就绪的时间；超时后台继续 |

## 自定义

- 想把工具加到别的模式：在 `cordis.patch.yml` 里覆盖该 `preset-*` 行的 `config.plugins`，追加
  `- id: yimu-bill-tools` / `name: dsh-yimu-bill/tools`。参考 [`preset.example.yml`](preset.example.yml)。
  注意这会在用户补丁里写入该模式的完整配置覆写，DSH 升级标准模式时不会自动同步。
- 想改登录逻辑：`lib/login-controller.mjs` 是会话/限频入口，`lib/yimu-api.mjs` 是官方接口唯一入口；
  `plugin.mjs` 只负责装配与原生面板注册。

## 安全与边界

### token 存在哪

- 登录成功后，网页版 JWT 写入 DSH 凭据库：`$DSH_HOME/.credentials.yaml` 的 `refs.YIMU_TOKEN`。
  文件权限由 DSH 维护为 `0600`，属主是 DSH 进程的运行用户（本机容器里是 `dsh`，UID 99）。
- 记账工具启动 MCP 时，token 通过子进程环境变量 `YIMU_TOKEN` 传入；MCP 仓库的 `YIMU_TOKEN` 环境变量也作为 headless 场景的兜底。
- 原生面板 / 网页页面、profile 配置、日志都不含 token；界面只显示 userId（JWT 的 `aud`）和凭据来源。

### 谁能读到

**这不是「只有本插件能拿到」的隔离。** 当前实现下：

- DSH 的 `credentials` 服务是进程级共享的：任何声明 `inject: ['credentials']` 的插件都能
  `resolve('YIMU_TOKEN')`；凭据记录也只靠 `scope/id` 命名约定，provider 不做 owner 校验。
- Agent 的工具（例如 `bash`）以同一个 OS 用户运行，可以直接读 `$DSH_HOME/.credentials.yaml`。
- MCP 子进程的环境变量在 Linux 上可被同用户进程读取（`/proc/<pid>/environ`；本机没有 Yama 限制）。
- 容器 root、备份/快照、能进入 DSH 容器或 DSH Home 的人，都能读到。

因此：**信任边界是整个 DSH 容器用户**。需要更强隔离时，只能把 token 移到独立服务/容器
（本插件当前未提供该形态）。

### token 的生命周期

- 这是网页版 JWT（HS256），payload 只有 `aud`（userId），**没有 `exp` / `iat` / `jti`**，
  属于长期凭据；请按「密码」级别对待。
- 一木记账网页端的「退出登录」是纯前端行为（清 `localStorage` 后刷新），不会调用服务端注销接口。
  我们实测了常见注销路径（`/api/user/logout`、`/api/logout`、`/api/auth/logout`、`/api/token/revoke` …），
  全部 404；网页端没有「让 token 失效」的 API。
- **Playwright 实测（2026-11-24）**：用真实 token 进入网页端（仅对 `getUserInfoById` 做了本地 mock 以进入界面，
  其余请求走真实接口），点击界面上的「退出登录」，只触发页面刷新与静态资源加载，**没有任何 `/api/` 请求**；
  退出后再用同一个 token 调 `/api/bill/getBillCount` 仍返回 `200 {"code":0,...}`。即网页端退出只清
  浏览器本地状态，服务端 token 完全不受影响。
- 本插件的「退出登录」会删除 DSH 凭据并关闭 MCP 子进程，但**服务端 token 仍然有效**；
  重新扫码也不保证旧 token 失效。若 token 泄露，请修改一木记账账号凭据或联系官方支持，
  并检查 DSH 的访问范围。

### 降低暴露面的建议

- 不要把 DSH 容器或 `$DSH_HOME` 暴露给不可信用户；备份 DSH Home 时按含密钥处理。
- 不要让不可信的 Agent/插件在本机获得 `bash` 或文件读取能力；它们能读到上述凭据。
- 定期确认 `$DSH_HOME/.credentials.yaml` 权限仍是 `0600`。
- headless / 无 GUI 场景：把 `YIMU_TOKEN` 放进 DSH 凭据库或进程环境变量即可，记账模式同样可用。


## 开发

```bash
npm install
npm test        # 二维码 PNG + 接口契约 + 控制器 + schema 清洗 + 工具映射 + 网页 API + 面板注册
```

代码结构：

| 文件 | 职责 |
|---|---|
| `plugin.mjs` | DSH 入口：`apply` + 登录控制器装配 + dsh-go 原生面板注册 |
| `lib/yimu-api.mjs` | 官方扫码接口唯一入口；接口变化只改这里 |
| `lib/login-controller.mjs` | 扫码会话、限频、凭据写入、测试连接 |
| `lib/qr.mjs` | 二维码 PNG data URL |
| `lib/web-api.mjs` | 网页版用的 `/api/yimu-bill/*` 路由处理器 |
| `lib/native.mjs` | dsh-go 原生面板：二维码、状态、测试、退出 |
| `lib/constants.mjs` | `TOKEN_REF` 等共享常量 |
| `client.js` | 网页版登录页（插件详情页的 `plugins.bundle.config`） |
| `tools.mjs` | 记账模式工具半（私有托管 MCP） |
| `mcp-host.mjs` | MCP 适配：schema 清洗、工具映射、探测 |

官方接口来自一木网页端，不是公开契约；若上游调整，只改 `lib/yimu-api.mjs`，并用
`test/plugin.test.mjs` 里的 fake fetch 契约测试固定信封解析。

## 发布

- 版本号同步：`package.json` 与 `package-lock.json`；服务端版本已改为运行时读取 `package.json`。
- 打 tag 并推送：`git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z`。
- tag 触发 [`.github/workflows/release.yml`](.github/workflows/release.yml)：测试 → 版本校验 →
  创建 GitHub Release（优先 `release-notes/<tag>.md`）；已在 Actions 中幂等处理重复 release。
- 可选 npm：仓库 Secrets 配置 `NPM_TOKEN`（stage-only 即可）后，workflow 执行 `npm stage publish`；未配置则跳过。
  staged 版本需维护者在 npm 上用 2FA 批准后才公开（本版已发布 `dsh-yimu-bill@0.2.1`）。
- CI 的 `npm pack --dry-run` 会校验 `files` 白名单，防止漏发 `lib/` 或客户端文件。

## License

MIT，见 [LICENSE](LICENSE)。
