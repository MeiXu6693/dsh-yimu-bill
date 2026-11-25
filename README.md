# dsh-yimu-bill

一木记账（[yimubill.com](https://yimubill.com)）的 **DSH 插件**：dsh-go 原生扫码登录 + 「记账模式」预设 + 私有托管的记账 MCP 兼容层。

MCP 本体在独立仓库 [`MeiXu6693/yimu-bill-cloud-mcp`](https://github.com/MeiXu6693/yimu-bill-cloud-mcp)（11 个语义化工具）；本仓库只做 DSH 宿主侧的登录、模式与工具映射。

> 非官方项目，与一木记账官方无关联。接口来自其公开网页端，升级后可能失效。

## 快速开始

1. 安装并重启：`dsh plugin --profile web add dsh-yimu-bill`，然后重启一次 DSH（或在 DSH Web 的插件管理页安装后重启）。
2. 登录：dsh-go App 走 **设置 → 插件 → 一木记账**；DSH Web / 桌面端走 **设置 → 一木记账**。
3. 扫码：App 截图面板里的二维码；Web 页面直接扫码。二维码约 120 秒有效，过期点「刷新二维码」。
4. 使用：新建任务时在模式菜单里选择「记账模式」。

> 安装细节见[安装](#安装)；架构、开发与发布见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 能力

- **扫码登录**：dsh-go App（[项目](https://github.com/ccch1mneyyy/dsh-go)）走 **设置 → 插件 → 一木记账** 的原生面板；DSH Web / 桌面端走 **设置 → 一木记账** 的网页登录页。两边共用同一个登录控制器和 DSH 凭据（ref `YIMU_TOKEN`），不写任何配置文件。
- **测试连接**：用当前凭据拉起 MCP 并真实调用 `overview`，当场确认 token 与链路可用。
- **记账模式**：内置 agent preset「记账模式」= **标准模式的完整复制 + 末尾一行记账工具**。只有新建任务时选择该模式，才会加载一木记账工具；标准、极简、创造等模式完全不受影响。
- **私有 MCP 兼容层**：不经过 DSH 的 `mcpManager` / `@deepseek-ai/dsh-mcp-client`。插件自己作为 MCP 宿主，以 stdio 拉起 `yimu-bill-cloud-mcp`，把 `listTools()` 映射成当前 preset 作用域内的原生 DSH 工具；MCP 进程退出即撤工具。
- **凭据热更新**：登录/退出触发 `credentials/reference-updated`，记账工具随之连接或撤下，无需重启 DSH。

## 安装

要求 **DSH 0.2.2-rc.1 及以上**（web profile，实测 0.2.2-rc.1 / 0.2.3-alpha.2；需要插件管理页的 `plugins.bundle.config` slot）。**不需要克隆仓库，也不需要编译**：插件和 MCP 都以 npm 包发布，
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
- 二维码等同临时登录凭证，截图不要转发；过期或登录成功后失效。
- 退出登录会删除 DSH 凭据，记账模式工具随之撤下。
- headless 场景：把网页版 JWT 放进 DSH 凭据库的 `YIMU_TOKEN`；进程环境变量只对直接运行 MCP 生效，DSH 记账模式不读它。

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

未登录时只有 `yimu_status`，它会提示去 设置 → 一木记账（网页版）或 设置 → 插件 → 一木记账（App）扫码。

### 4. 原生面板

dsh-go App（[项目](https://github.com/ccch1mneyyy/dsh-go)）的原生面板是 **App 端**唯一的二维码入口：

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
| `mcpServerPath` | 空 | MCP 入口；留空取 npm 依赖 `yimu-bill-cloud-mcp/src/index.js`（开发仓库回退相邻目录） |
| `mcpServerCwd` | 空 | MCP 工作目录；留空取该 MCP 包根 |

工具半（preset 行）：

| 键 | 默认 | 说明 |
|---|---|---|
| `serverPath` | 空 | 同上（npm 依赖，开发仓库回退相邻目录） |
| `serverCwd` | 空 | 同上（MCP 包根） |
| `toolPrefix` | `yimu_` | 工具名前缀 |
| `startupTimeoutMs` | `20000` | MCP 握手/列工具超时 |
| `readyWaitMs` | `10000` | 会话创建最多等待 MCP 就绪的时间；超时后台继续 |

## 安全与边界

### token 存在哪

- 登录成功后，网页版 JWT 写入 DSH 凭据库：`$DSH_HOME/.credentials.yaml` 的 `refs.YIMU_TOKEN`。
  文件权限由 DSH 维护为 `0600`，属主是 DSH 进程的运行用户（本机容器里是 `dsh`，UID 99）。
- 记账工具启动 MCP 时，token 通过子进程环境变量 `YIMU_TOKEN` 传入；直接运行 MCP 时，其自身的 `YIMU_TOKEN` 环境变量可作为兜底。DSH 记账模式只读凭据库。
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
- headless / 无 GUI 场景：把 `YIMU_TOKEN` 放进 DSH 凭据库；进程环境变量只对直接运行 MCP 生效，记账模式不读它。

## 开发、架构与发布

架构、代码结构、自定义和发版流程见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：本插件运行的宿主与插件/Web 客户端框架。
- [dsh-go](https://github.com/ccch1mneyyy/dsh-go)：DSH 手机 App 与 `dshGo` 原生插件协议；本插件的 App 原生面板基于它。
- [yimu-mcp](https://github.com/powercess/yimu-mcp)：一木记账 MCP 参考实现。

## License

MIT，见 [LICENSE](LICENSE)。
