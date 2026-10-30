# Pi Agent

把 Pi coding agent（`@earendil-works/pi-coding-agent`）接入 Coda。每个 Coda 会话启动一个 `pi --mode rpc` 子进程，由插件在 Coda 的 ACP JSON-RPC 和 Pi 的 JSONL RPC 之间转换。

## 要求

- Pi 由插件自动准备：安装或更新插件后，Coda 运行插件的「准备运行环境」（`agent/setup.mjs`）。最低支持的 Pi 为 **1.1.0**；这台机器已有能运行且不低于最低版本的 `pi`（设置里的路径、PATH 或常见目录）就直接用。
  没有可用的外部 Pi 时，用 Coda 自带的 Node 和 npm 把 `@earendil-works/pi-coding-agent@latest` 装到用户预期的 `~/.local` npm prefix，入口是 `~/.local/bin/pi`。
  装不上时插件页会写原因并给「重试」；安装后可打开资源页的「Pi 运行时」查看当前版本、npm 最新版，并执行更新。
- 还要在 Coda 里添加 provider（见下），或在 pi 里完成登录。
- Node 由 Coda 提供（`$CODA_NODE`），插件运行时没有 npm 依赖；开发检查器是锁定版本的 devDependency。
- 直接使用本机 Pi 的配置、登录、扩展与会话目录（`$PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`），插件不复制也不改写它们；Coda 里开的会话也能在 `pi --resume` 里看到。

## 安装

在「设置 › 插件」的商店里选「Pi」安装（npm 包 `@coda-console/pi`，商店里看不到时点「刷新」）；也可以在「从仓库添加…」里填本仓库 `sealiu1997/coda_plugins_pi_agent`。

本插件在本仓库维护，不在 `coda-console/coda-plugins` 里；新版本由维护者手动发布到 npm 的 `@coda-console` 下。

在这台机器上试改请不要用仓库地址，填本机仓库的绝对路径：Coda 只读取已提交的内容，未提交的改动看不到。

## 设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `pi.commandPath` | `pi` | `pi` 可执行文件路径；留为 `pi` 时依次检查 PATH、`~/.npm-global/bin`、`/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`、`~/.bun/bin`，最后兼容旧版插件留下的自管副本。显式填写的路径始终优先；准备运行环境不会覆盖它，可在资源页的「Pi 运行时」检查并更新可识别的 npm 安装。 |
| `pi.extraArgs` | 空 | 追加到 `pi --mode rpc` 的额外 CLI 参数。 |
| `pi.providers` | 无 | 一行一个 provider：地址、Key（密文）、协议、推理、上下文长度、最大输出。行名就是 Pi 里的 provider 名（不能带 `/`）。 |

## Provider

在 Coda 的「设置 › 插件 › Pi › Provider」里加一行：在「来源」里选别的插件提供的模型服务（如 CLIProxy 插件填好地址和 Key 后提供的「CLIProxy」），
或者自己填 OpenAI 兼容的地址（如 `https://example.com/v1`）和 Key。填完点「检查可用模型」就能看到这个地址列出哪些模型：地址列声明为 Coda 的模型地址（`coda-model-url`），由 Coda 统一检查，选了来源时检查那个服务。不用手写模型：

- 插件启动 Pi 时带上 `agent/providers.mjs` 扩展，它对每一行请求「地址/models」，把列出的模型注册成这个 provider 的模型；Key 从 Coda 的密文文件读（`CODA_PLUGIN_SECRETS`），不进 `models.json`。
- 列表给了上下文长度（OpenRouter 的 `context_length`、vLLM 的 `max_model_len`、llama.cpp 的 `meta.n_ctx_train`）就用它，否则用这一行的「上下文长度」；推理与最大输出取这一行的。
- 刷新：在 Coda 里点「重新读取模型」，Pi 重新启动、重新列。地址暂时连不上时用上次列出的（存在插件状态目录的 `provider-models.json`）。
- 与 `~/.pi/agent/models.json` 里的 provider 同名时，以 Coda 这一行为准。
- 需要支持密文、几列表格、模型服务与「检查可用模型」的 Coda（coda-console/coda#1387、#1410）。

## 协议映射

- `systemPrompt` 写入插件状态目录，并通过 `--append-system-prompt` 生效。
- 模型与推理强度映射为 `configOptions`，并转成 Pi 的 `set_model` / `set_thinking_level`。两项各有一个「Pi 默认」（`_meta.coda.default`）：
  取新会话第一次启动时 Pi 自己生效的模型与推理强度，按会话存在插件状态目录的 `defaults/`，重启 Pi、恢复会话后不变；推理强度的默认只在那个模型上提供。
  此前建的会话没有这份记录，不提供「Pi 默认」。
- `agentInfo.version` 报实际运行的 `pi --version`；无法识别或低于最低版本时拒绝启动会话并给出升级指引。
- 报一个固定的「工作模式」（`mode`，只有「默认」一项）：Pi 没有审批模式，但 Coda 只把带模式的会话记成新会话的快捷方式，没有它，新开的 Pi 会话推理强度总是没选、只显示图标。
- `mcpServers`（含 Coda 自己的 `coda` 服务器）转成 Pi 的 `mcp.json` 形式，由 `agent/coda-mcp.mjs` 扩展用 `pi.registerMcpServer` 注册、交 Pi 连接；
  配置经插件状态目录里 0600 的文件传递，不进命令行参数与环境变量；`env` 与 `headers` 的值按 Pi 的字面量写法转义（`$` 写成 `$$`，开头的 `!` 写成 `$!`），Pi 不会把它们当命令执行或展开变量。`coda` 服务器的工具直接暴露给模型（`exposure: direct`），其余按 Pi 默认（codemode）。
  `~/.pi/agent/mcp.json` 里有同名服务器时以它为准；不支持 SSE 服务器。
- Pi 的上下文整理（`compaction_start` / `compaction_end` / 摘要重试）映射为 `compaction_update`，失败带原因；Coda 未声明 `session.compaction` 时，失败改为在回复里提示。
- 每轮结束和恢复会话后，用 Pi 的 `get_session_stats` 发 `usage_update`（上下文已用 / 总量、累计费用，按 USD）；刚整理完、Pi 暂无用量时不发。
- 文本、图片与资源输入转成 Pi `prompt`；输出按 `agent_settled` 结束一轮。
- 工具执行、思考流与可用命令映射为 `session/update`。
- 会话自动命名：Pi 自己不给会话起名，插件在会话首个正常结束的一轮后，用该会话同款模型起一个不超过 16 字的标题（独立的 `pi --print --no-session` 子进程，不用工具、不进会话、失败静默），经 `set_session_name` 写进 Pi 会话（`pi --resume` 里可见），并随 `session_info_changed` 报给 Coda；用户在 Pi 里手动命名的会话不被覆盖。
- `_session/steering` 映射为 Pi `steer`；空闲时返回 `promptRequired`。
- Pi 扩展的确认、选择和输入请求映射为 ACP 审批或表单。
- 执行失败按 Coda 协议分类：上报额度耗尽（`quota_exhausted`）与临时服务故障（`service_unavailable`，`input: "accepted"`）；短时限流（rate limit）刻意保留为普通错误，不自动重试。

## 限制

- 不报告 Pi 后台任务、子 Agent 与定时唤醒（`_coda/wait`）。
- 不回放历史；Coda 保存自己的会话展示。
- 对尚未发过提示词、尚无会话文件的 Pi 会话执行 `session/load` 时，会以该 ID 启动一个空会话，Pi 会输出警告日志。
- 取消依赖 Pi 的 `clear_queue` / `abort`；约 10 秒未停止时会终止 Pi 子进程，后续轮次按需重新启动。


## 开发与兼容检查

Node ≥24。先 `npm ci --ignore-scripts`，再运行：

| 命令 | 用途 |
| --- | --- |
| `npm test` | 单元测试与无需登录、无需真实模型的 fake Pi 端到端测试 |
| `npm run check:coda` | 官方 checker 0.5.8 清单检查与 fake Pi 握手 |
| `npm run check:fake-live` | 官方 `coda-plugin-check --live` 驱动真实插件入口，覆盖系统指令、回合、取消、插话、恢复与关闭 |
| `npm run check:pi` | 扫描本机 Pi 安装包，核对 CLI/RPC/事件/扩展 API、能力新增与 changelog |
| `npm run check:pi:verified` | 临时从 npm 安装固定 Pi 1.1.0 后扫描，不改全局安装 |
| `npm run probe:upstream` | 手动运行独立的 latest 探测，报告写入 `compat-reports/` |
| `npm run check:real-live` | **人工选择运行**：对本机真实 Pi 执行官方 live 检查，可能需要登录并消耗模型额度 |

Coda 通用协议只复用官方 `@coda-console/plugin-check`，精确版本 **0.5.8** 与传递依赖写在 `package-lock.json`。不再维护另一套 Coda 协议扫描或协议基线。
`check:coda` 的握手和 fake live 在临时插件副本中运行原始 `agent/` 文件，只把清单默认 `pi.commandPath` 指向 fake 可执行文件；不改你的设置或 Pi 配置。fake 也模拟 `--version`、`--help`、系统提示词文件与标题进程，且断言取消和轮中插话实际发生，跳过场景不能当作通过。

普通 PR / main CI 只跑 lockfile 中的官方 checker 和已验证 Pi 固定候选。每日的 `Upstream compatibility advisory` workflow（也可手动发起）单独探测两个上游的 latest；上游变化或检查失败使这个独立任务告警，不进入普通 PR 的稳定检查。任务只给 `contents: read`，不使用 secrets，也不发布。
它在 job summary 和 artifact 中保存版本与提交、官方 checker 结果、Pi JSON 报告，以及从固定 checker 发布提交到最新发布提交、上游 main 的 `docs/agent-protocol.md` diff 与相关提交列表。artifact 默认保留 30 天；新协议需人工判断插件是否需要接入，再提交固定版本和快照更新。

Pi 扫描器用法与退出码见 [compat/NOTES.md](compat/NOTES.md)。无 `--accept` 时始终只读仓库基线；候选快照在 JSON 报告里。接受前检查完整报告与 changelog：

```sh
node scripts/check-pi-compat.mjs --install 1.1.0 --json
node scripts/check-pi-compat.mjs --pi /absolute/path/to/pi --json
# 完成人工评估后显式更新基线：
node scripts/check-pi-compat.mjs --accept
```

## Pi 运行时管理

插件安装时默认把 Pi latest 安装到 `~/.local/bin/pi`。已有可用 Pi 时沿用当前安装，不会因为安装或更新插件而擅自改变用户已有的版本。

资源页的「Pi 运行时」面板显示当前路径、当前版本和 npm latest，并提供「安装最新版」或「更新到最新版」按钮：

- 插件自己安装的 `~/.local` 副本，直接更新该 prefix。
- `/opt/homebrew/lib/node_modules`、nvm 或其他标准 npm global 布局中的 Pi，用对应 prefix 更新。
- 项目本地、Bun、独立下载或无法识别安装来源的 Pi 不会被覆盖；面板会提示改用原安装工具，或在 `pi.commandPath` 中改指 npm 安装的 Pi。
- 更新不会主动结束正在运行的 Coda 会话；新版本从之后启动的 Pi 进程生效。

命令行检查和更新使用同一套逻辑：

```sh
npm run pi:status
npm run pi:update
```

`agent/pi-install/` 中固定的 1.1.0 依赖图继续供兼容扫描器构造可重复的基线安装；生产 setup 默认安装 latest，Coda 插件自身版本仍由插件商店的检查更新机制管理。每日 upstream advisory 会检查 Pi latest 的接口变化，普通稳定 CI 不会因为上游半夜发版而突然失败。
