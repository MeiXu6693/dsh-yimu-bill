# dsh-yimu-bill

一木记账（[yimubill.com](https://yimubill.com)）的 **DSH 宿主插件**：扫码登录、把网页版 JWT 写进 DSH 凭据库，并按插件生命周期挂载记账 MCP。

MCP 本体在独立仓库 [`MeiXu6693/yimu-bill-cloud-mcp`](https://github.com/MeiXu6693/yimu-bill-cloud-mcp)（11 个语义化工具）；本仓库只做宿主侧的登录与挂载。

> 非官方项目，与一木记账官方无关联。接口来自其公开网页端，升级后可能失效。

## 能力

- **扫码登录**：`yimu_login` 申请扫码会话，把二维码渲染成等宽字体的半块字符（直接贴在聊天里就能扫），同时落一份 SVG。
- **凭据桥**：`yimu_login_wait` 轮询登录结果，成功后把 JWT 写入 DSH 凭据库（ref `YIMU_TOKEN`）；配置里只出现 `${credential:YIMU_TOKEN}` 模板，token 不落任何配置文件。
- **挂载 MCP**：全局形态下用 `ctx.mcpManager.register()` 在插件生命周期内注册 `yimu_cloud`；插件卸载，MCP 与工具一起撤下。
- **会话级隔离**：也可以在 agent preset 里声明式挂 mcp-client，只有选中该预设的会话才有记账工具。

## 工具

| 工具 | 作用 |
|---|---|
| `yimu_login` | 申请扫码会话，返回二维码文本 + session_id（约 2 分钟有效） |
| `yimu_login_wait` | 等待扫码结果（默认 20 秒，最长 45 秒），成功后写 `YIMU_TOKEN` |
| `yimu_login_status` | 查看 `YIMU_TOKEN` 是否已配置（不显示内容） |
| `yimu_logout` | 清除 `YIMU_TOKEN`（不影响手机 App 登录态） |

## 前置

1. 可用的 DSH（需要 `tools`、`credentials` 服务，以及可选 `mcpManager`）。
2. 部署 MCP 仓库：

```bash
git clone https://github.com/MeiXu6693/yimu-bill-cloud-mcp.git
cd yimu-bill-cloud-mcp && npm install
```

## 安装

### 方式一：全局（插件注册 MCP，所有会话可见）

1. 让 profile 能加载到插件模块（软链到 profile 的 `local/` 最省事）：

```bash
ln -s /path/to/dsh-yimu-bill/plugin.mjs "$DSH_HOME/profiles/web/local/yimu-bill.mjs"
```

2. 在 `$DSH_HOME/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: yimu-bill
      name: './local/yimu-bill.mjs'
      inject: [ credentials, mcpManager ]
      config:
        registerMcp: true
        serverName: yimu_cloud
        serverPath: /path/to/yimu-bill-cloud-mcp/src/index.js
        serverCwd: /path/to/yimu-bill-cloud-mcp
        qrDir: /path/to/qr
```

DSH 会热加载 profile 补丁（无需重启）。工具名形如 `mcp__yimu_cloud__overview`。

### 方式二：会话级（agent preset，只在该预设的会话里出现）

全局条目只保留登录工具（`registerMcp: false`），再按 [`preset.example.yml`](preset.example.yml) 加一个预设：

```yaml
- insert:
    - id: preset-yimu-bill
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: yimu-bill
        name: 一木记账
        plugins:
          - id: mcp-yimu-cloud
            name: '@deepseek-ai/dsh-mcp-client'
            inject: [ credentials ]
            config:
              serverName: yimu_cloud
              transport: stdio
              command: !!js process.execPath
              args: [ /path/to/yimu-bill-cloud-mcp/src/index.js ]
              cwd: /path/to/yimu-bill-cloud-mcp
              env: { YIMU_TOKEN: '${credential:YIMU_TOKEN}' }
              failOnStartupError: false
              startupTimeoutMs: 20000
```

新建会话时选「一木记账」预设即可；该会话原生拥有独立的 MCP 进程，Standard 会话看不到记账工具。

### 关于工作区级

DSH 没有「按工作区挂插件」的原生机制：工作区只决定会话的 cwd，挂载单位是会话（preset）。所以工作区级只能按约定实现——**在某个工作区开会话时选「一木记账」预设**。

## 使用

1. 调 `yimu_login`，把返回的二维码给手机上的「一木记账」App【首页】-【更多】-【扫一扫】扫描。
2. 调 `yimu_login_wait`（带上 `session_id`），成功后 token 写入 DSH 凭据库，MCP 自动重连。
3. 记账工具就绪：`overview`、`query_bills`、`bill_add`、`stats` 等（详见 MCP 仓库 README）。

未登录时 MCP 处于等待凭据状态，不会拉起子进程；登录后自动连上。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `registerMcp` | `true` | 是否用 `ctx.mcpManager` 注册 MCP（全局形态）。设为 `false` 时只提供登录工具 |
| `serverName` | `yimu_cloud` | MCP server 名，决定工具前缀 `mcp__<serverName>__*` |
| `serverPath` | 空 | MCP 仓库 `src/index.js` 绝对路径；`registerMcp` 时必填，缺失会打印诊断并跳过注册 |
| `serverCwd` | 空 | MCP 进程工作目录；留空取 `serverPath` 的所在目录 |
| `qrDir` | `$TMPDIR/dsh-yimu-bill/qr` | 二维码 SVG 落盘目录 |
| `loginTtlMs` | `120000` | 二维码有效期展示值 |

## 故障排查

- **二维码扫不出**：聊天窗口换行会破坏二维码，改用 `yimu_login` 返回的 SVG 文件，放大后扫。
- **登录后工具没出现**：确认 `yimu_login_status` 已配置，且 MCP 的 `serverPath` 指向的仓库已 `npm install`。
- **一直 waiting-credentials**：`YIMU_TOKEN` 未写入；重新扫码，或检查凭据库文件权限是否 0600。
- **预设里没有工具**：确认 mcp-client 条目里的 `args/cwd/env` 路径是本机真实路径。

## License

MIT，见 [LICENSE](LICENSE)。
