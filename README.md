# dsh-yimu-bill

一木记账（[yimubill.com](https://yimubill.com)）的 **DSH 插件**：设置页 GUI 扫码登录 + 「记账模式」预设 + 私有托管的记账 MCP 兼容层。

MCP 本体在独立仓库 [`MeiXu6693/yimu-bill-cloud-mcp`](https://github.com/MeiXu6693/yimu-bill-cloud-mcp)（11 个语义化工具）；本仓库只做 DSH 宿主侧的登录、模式与工具映射。

> 非官方项目，与一木记账官方无关联。接口来自其公开网页端，升级后可能失效。

## 能力

- **GUI 扫码登录**：DSH 设置 → 一木记账，点「扫码登录」直接在页面里显示二维码；登录成功后 JWT 写入 DSH 凭据库（ref `YIMU_TOKEN`），不写任何配置文件。
- **测试连接**：用当前凭据拉起 MCP 并真实调用 `overview`，当场确认 token 与链路可用。
- **记账模式**：内置 agent preset「记账模式」= **标准模式的完整复制 + 末尾一行记账工具**。只有新建任务时选择该模式，才会加载一木记账工具；标准、极简、创造等模式完全不受影响。
- **私有 MCP 兼容层**：不经过 DSH 的 `mcpManager` / `@deepseek-ai/dsh-mcp-client`。插件自己作为 MCP 宿主，以 stdio 拉起 `yimu-bill-cloud-mcp`，把 `listTools()` 映射成当前 preset 作用域内的原生 DSH 工具；MCP 进程退出即撤工具。
- **凭据热更新**：登录/退出触发 `credentials/reference-updated`，记账工具随之连接或撤下，无需重启 DSH。

## 架构

```
DSH 设置页「一木记账」(client.js)
        │  同源 fetch /api/yimu-bill/*
        ▼
控制半 plugin.mjs（全局行，不注册工具）
  ├─ /status /login/start /login/poll /logout
  ├─ /probe ──► mcp-host.mjs ──► yimu-bill-cloud-mcp（临时进程，调 overview）
  └─ 写 DSH 凭据 YIMU_TOKEN
                    │ credentials/reference-updated
                    ▼
记账模式 preset
  └─ tools.mjs（preset 作用域）
       ├─ 读 YIMU_TOKEN
       ├─ startMcpHost() ──► yimu-bill-cloud-mcp（常驻子进程）
       └─ 注册 yimu_* + yimu_status
```

- 工具注册使用 Cordis 的「调用方作用域」语义：在 preset revision 内注册的工具，只对被绑定到该模式的会话可见。
- MCP SDK 不随插件发布：从 MCP 仓库自己的 `node_modules` 解析（`@modelcontextprotocol/sdk`），插件保持零 `@deepseek-ai` 依赖。

## 安装

### 1. 准备 MCP 仓库

```bash
git clone https://github.com/MeiXu6693/yimu-bill-cloud-mcp.git
cd yimu-bill-cloud-mcp && npm install && npm test
```

### 2. 安装本插件到 DSH profile

要求 DSH 0.2.x（web profile）。下面以 `/data/dsh/profiles/web` 为例：

```bash
# 1) 让 profile 能按包名解析插件（bundle + client 双半都依赖这一步）
ln -s /path/to/dsh-yimu-bill /data/dsh/profiles/web/node_modules/dsh-yimu-bill

# 2) profile/package.json
#    dependencies 加： "dsh-yimu-bill": "link:/path/to/dsh-yimu-bill"
#    dsh.profile.bundles 追加： "dsh-yimu-bill"

# 3) 确保 profile/cordis.patch.yml 里没有旧的 yimu-bill 手写行
#    （本包通过 dsh.bundle.patch 自己插入全局行与「记账模式」预设）
```

安装/升级**插件包**后需要重启一次 DSH：浏览器端的 client bundle 在进程启动时扫描
（新增包的首次安装不会自动进入运行中的 client 图）。重启后浏览器刷新页面，设置里出现
「一木记账」。之后只改 profile 补丁（`cordis.patch.yml`）可以热加载；改插件代码同样
需要重启。

> 不要求 `pnpm install`：`node_modules` 软链 + profile manifest 已足够让 Loader 解析包名；
> HMR 也会把该软链识别为 linked root，改插件代码可热替换。

### 3. 登录

DSH 设置 → **一木记账** → 扫码登录 → 用一木记账 App【首页】-【更多】-【扫一扫】扫码。
成功后可以点「测试连接」确认 11 个工具可用。

### 4. 使用

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

未登录时只有 `yimu_status`，它会提示去设置页扫码。

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
- 想改登录逻辑：`plugin.mjs` 的 `createLoginController` 与 `apply` 是入口；HTTP 契约见文件头注释。

## 安全与边界

### token 存在哪

- 登录成功后，网页版 JWT 写入 DSH 凭据库：`$DSH_HOME/.credentials.yaml` 的 `refs.YIMU_TOKEN`。
  文件权限由 DSH 维护为 `0600`，属主是 DSH 进程的运行用户（本机容器里是 `dsh`，UID 99）。
- 记账工具启动 MCP 时，token 通过子进程环境变量 `YIMU_TOKEN` 传入；MCP 仓库的 `YIMU_TOKEN` 环境变量也作为 headless 场景的兜底。
- HTTP 响应、profile 配置、日志都不含 token；设置页只显示 userId（JWT 的 `aud`）和凭据来源。

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
npm test        # 二维码回环 + 控制器 + schema 清洗 + 工具映射 + 路由
```

## License

MIT，见 [LICENSE](LICENSE)。
