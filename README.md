# Pi Agent

把 Pi coding agent（`@earendil-works/pi-coding-agent`）接入 Coda。每个 Coda 会话启动一个 `pi --mode rpc` 子进程，由插件在 Coda 的 ACP JSON-RPC 和 Pi 的 JSONL RPC 之间转换。

## 要求

- Pi 随本插件安装：`package.json` 精确锁定 `@earendil-works/pi-coding-agent`，Coda 在安装或更新 Pi 插件时，用后端自带的 Node/npm 把依赖装进该插件版本目录。再运行「准备运行环境」确认内置 Pi 能启动。
  默认会话直接使用这份内置 Pi，不扫描 PATH、Homebrew、nvm 或其他全局安装。这样同一插件版本在每台机器上使用同一个 Pi，也不会改动用户自己的安装。
- Pi 的默认版本跟插件版本绑定。更新 Pi 就是更新 Pi 插件；新启动的会话使用新插件目录里的 Pi，已在运行的会话继续使用启动时的版本。
- 最低支持 Pi **1.1.0**，当前插件内置并验证 **1.4.0**。如果显式设置 `pi.commandPath` 指向外部 Pi，插件只验证它能否运行以及是否达到最低版本，不会安装或升级它。
- 还要在 Coda 里添加 provider（见下），或在 pi 里完成登录。
- Node 由 Coda 提供（`$CODA_NODE`）。插件运行时依赖随插件安装；开发检查器是锁定版本的 devDependency。
- 直接使用本机 Pi 的配置、登录、扩展与会话目录（`$PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`），插件不复制也不改写它们；Coda 里开的会话也能在 `pi --resume` 里看到。

## 安装

在「设置 › 插件」的商店里选「Pi」安装（npm 包 `@coda-console/pi`，商店里看不到时点「刷新」）；也可以在「从仓库添加…」里填本仓库 `sealiu1997/coda_plugins_pi_agent`。

本插件在本仓库维护，不在 `coda-console/coda-plugins` 里；新版本由维护者手动发布到 npm 的 `@coda-console` 下。

在这台机器上试改请不要用仓库地址，填本机仓库的绝对路径：Coda 只读取已提交的内容，未提交的改动看不到。

## 设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `pi.commandPath` | `pi` | 留为 `pi` 时使用插件目录内锁定版本；填其他命令或绝对路径时，显式改用你自行管理的 Pi。插件不会扫描 PATH 替默认值，也不会安装或升级这个外部 Pi。 |
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
| `npm run check:pi` | 扫描插件依赖中锁定的 Pi，核对 CLI/RPC/事件/扩展 API、能力新增与 changelog |
| `npm run check:pi:verified` | 与 `check:pi` 相同；CI 用它确认锁定的 Pi 已验证 |
| `npm run probe:upstream` | 手动运行独立的 latest 探测，报告写入 `compat-reports/` |
| `npm run check:real-live` | **人工选择运行**：对本机真实 Pi 执行官方 live 检查，可能需要登录并消耗模型额度 |

Coda 通用协议只复用官方 `@coda-console/plugin-check`，精确版本 **0.5.8** 与传递依赖写在 `package-lock.json`。不再维护另一套 Coda 协议扫描或协议基线。
`check:coda` 的握手和 fake live 在临时插件副本中运行原始 `agent/` 文件，只把清单默认 `pi.commandPath` 指向 fake 可执行文件；不改你的设置或 Pi 配置。fake 也模拟 `--version`、`--help`、系统提示词文件与标题进程，且断言取消和轮中插话实际发生，跳过场景不能当作通过。

普通 PR / main CI 只跑 lockfile 中的官方 checker 和插件锁定的 Pi。每日的 `Upstream compatibility advisory` workflow（也可手动发起）单独探测两个上游的 latest；上游变化或检查失败使这个独立任务告警，不进入普通 PR 的稳定检查。任务只给 `contents: read`，不使用 secrets，也不发布。
它在 job summary 和 artifact 中保存版本与提交、官方 checker 结果、Pi JSON 报告，以及从固定 checker 发布提交到最新发布提交、上游 main 的 `docs/agent-protocol.md` diff 与相关提交列表。artifact 默认保留 30 天；新协议需人工判断插件是否需要接入，再提交固定版本和快照更新。

Pi 扫描器用法与退出码见 [compat/NOTES.md](compat/NOTES.md)。无 `--accept` 时始终只读仓库基线；候选快照在 JSON 报告里。接受前检查完整报告与 changelog：

```sh
node scripts/check-pi-compat.mjs --json
node scripts/check-pi-compat.mjs --pi /absolute/path/to/pi --json
# 完成人工评估后显式更新基线：
node scripts/check-pi-compat.mjs --accept
```

## Pi 运行时管理

这与 Coda 官方 Claude SDK、Codex 插件的做法一致：运行时是插件的精确 npm 依赖，在插件设置页点「检查更新」检查 Pi 插件。新版本会先安装它自己的依赖，再从新启动的会话运行；没有单独的全局 Pi 升级按钮，也不会修改 PATH 上已有 `pi`。

维护者升级内置 Pi 的步骤是：修改 `package.json` 的精确依赖并更新根 `package-lock.json`，运行固定版本兼容扫描和 fake live；没有阻塞后升级本插件版本并发布。用户更新 Pi 插件即可得到新运行时。

需要继续使用自己安装或固定版本的 Pi 时，把 `pi.commandPath` 填成其实际命令或绝对路径。该覆盖项优先于插件内置运行时，版本检查和升级由用户自己的安装工具负责。
