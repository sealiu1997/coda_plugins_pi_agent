# Pi 兼容检查

在仓库根目录运行（Node ≥24，无第三方依赖）：

```sh
node scripts/check-pi-compat.mjs
node scripts/check-pi-compat.mjs --json
node scripts/check-pi-compat.mjs --pi /opt/homebrew/bin/pi
node scripts/check-pi-compat.mjs --install latest
node scripts/check-pi-compat.mjs --install 1.5.0 --json
# 人工确认报告后，才接受本机或指定候选版本：
node scripts/check-pi-compat.mjs --accept
```

退出码：0 兼容且无新增；1 不兼容；2 新增、版本漂移、未确认基线或证据不足；3 无法检查（路径、启动、超时、安装失败等）。`--accept` 不会覆盖含确定不兼容的快照。证据不足的项目即使人工接受快照，仍保持待评估。

`pi-surface.json` 是插件依赖的唯一清单，每个接口、字段、枚举都有 agent 源文件证据。`package.json` 中暴露给 Coda 的 settings.json/models.json 也记录在清单里；agent 本身不解析这些 Pi 配置文件，没有固定依赖的 Pi 设置键。Coda 的 `pi.*` 设置不算 Pi 的 Settings。修改插件接口时同步更新清单；测试核对显式 RPC 发送、CLI 字符串、扩展调用、事件分支和消费的 record 字段。

`pi-snapshot.json` 保存版本、全量已发现的命令、事件、CLI 参数、扩展方法、设置键（含嵌套键）、扩展 UI 方法及声明签名。普通检查（包括缺少快照时）绝不写仓库；候选位于 JSON 报告的 `candidateSnapshot`。只有显式 `--accept` 才写入快照并标记人工确认。只有完整的 schemaVersion 1、`reviewed === true` 才可能返回 0；人读和 JSON 报告始终说明基线确认状态。1.5.0 快照在契约核对、fake live 和 pi-schema 声明解析补充后确认。运行时最低版本门槛是插件版本 `X.Y.Z` 的 `X.Y.0`（`X.Y` 是验证过的 Pi 系列，见 README「版本约定」），固定自动化验证版本为 1.5.0（即插件版本的 `X.Y` 系列），版本与运行时代码由测试交叉核对。插件版本号策略见 README「版本约定」：`X.Y` 是验证过的 Pi 系列，补丁号 `Z` 归插件自己。延伸：想用新于验证系列的 Pi，等插件跟进新系列；用户自己升级 Pi 时插件只提示「尚未验证」，不阻止。

来源按以下优先级读取，完全不导入执行 Pi 的 JS：

| 接口 | 首选来源 | 置信度 |
| --- | --- | --- |
| RPC 命令、响应、扩展 UI | `dist/modes/rpc/rpc-types.d.ts` | 高 |
| 会话事件 | `dist/core/agent-session.d.ts` + 随包 pi-agent-core 的 AgentEvent | 高 |
| 模型及消息内容 | 随包 pi-ai 的 `.d.ts` | 高 |
| 扩展 API | `dist/core/extensions/types.d.ts` | 高 |
| 设置键 | `dist/core/settings-schema.d.ts` 的 Settings 及引用类型 | 高 |
| CLI 参数 | 隔离运行的 `pi --help` 选项行 | 中高；帮助文本可能不完整 |
| 文档回退 | 包内 docs/rpc*.md、extensions.md、settings.md、cli.md | 低；只提示人工评估 |

内置声明读取器识别对象、联合、继承、泛型引用、`Omit`/`Pick`、`TypeBox` 的 `Static<typeof ...>` wrapper 和常见索引访问，不等价于 TypeScript 编译器。字段核对使用 JSON 粗类型；无法解析的结构会提示人工评估。基线签名变化也会报告，以覆盖参数、可选性和枚举等进一步变化。工具结果 `partialResult`/`result` 明确声明为 `any`；插件仅依赖父字段存在，`mapToolResultContent` 对 content 用 `Array.isArray` 保护，fake live 覆盖 null、数字、对象与非数组 content；不伪称静态证明嵌套结构。用户额外参数、用户扩展、任意 provider 的错误文字、MCP 配置值展开语义，以及需要真实模型回合才能观察的行为仍需人工验证。不会为了证明这些行为发送 prompt 或调用模型。

实测仅运行固定的五个 getter，使用临时 cwd、HOME、PI_CODING_AGENT_DIR 和 session 目录；不继承 API Key，关闭扩展、MCP、资源发现、遥测与启动网络。空模型列表、未命名会话和空上下文合法，探测不会据此判断登录失败。未出现的可选字段依靠声明检查；报告中的“只读探测通过”不代表实际观察到全部可选字段。所有扫描器子进程各自拥有进程组，结束先 TERM，最多等待 500ms 后 KILL，并在有限时间内等待关闭。顶层 SIGINT/SIGTERM 会清理当前 git/npm/pi 进程组和临时目录；清理失败返回 3（无法检查），不会误报为不兼容。

默认检查使用本机自动找到的 Pi，不联网。普通 CI 用 `npm run check:pi:verified` 扫描根 devDependency 锁定的 1.5.0；`--install 版本或latest` 使用临时 global prefix、HOME、配置与 npm cache 安装候选，结束后删除，不更新用户全局 Pi。最小环境移除凭据，`--ignore-scripts` 禁止包生命周期脚本。网络安装错误返回 3。二进制定位支持 npm 符号链接及字面量绝对 exec 路径的 shell 包装；其他包装器需要 `--pi` 指向实际入口。CHANGELOG 如存在则按版本标题摘录；版本缺失或降级时会提示边界限制。

`--extension`、`-e`、`--extension=`、`-e=` 都记录在依赖面。插件把等号写法规范化后再传给 Pi；测试覆盖四种形式、所有 `.send()`、`.write()` 及变量形式的 UI 回包，并约束 Pi RPC 序列化只在中央模块内发生。CLI 签名解析失败、必需类型消失、未知响应、缺少 getter 响应均不能通过。

## Pi 1.5.0 评估（基线 1.4.0 → 1.5.0）

`node scripts/check-pi-compat.mjs --install 1.5.0` 的结果：无确定不兼容项，12 个待评估项，逐项结论如下。接受快照后 `check:pi:verified` 退出 0（4 个字段由扫描器补充解析证明，见最后一项）。

| 待评估项 | 结论 |
| --- | --- |
| Pi 版本漂移 1.4.0 → 1.5.0 | 预期的升级；快照与 devDependency 钉到 1.5.0，插件版本对齐到 1.5.0。 |
| 新增设置 `extensionChangelogVersions` | 无关。Pi 记录已展示过的扩展更新说明版本，只影响 TUI 启动提示；插件不读写 Pi 的 settings。 |
| 新增设置 `selfUpdateCommand`（及 `PI_SELF_UPDATE_COMMAND`） | 无关，暂不接入：它让 `pi update` 经包装器或别的包管理器更新 Pi，与「按验证过的系列钉版本」冲突；插件自己的更新走 `agent/pi-runtime.mjs`，不经 `pi update`。 |
| 声明变化 `cli.--export` | 无关。签名由 `<file>` 变为 `<file> [output]`，是 HTML 导出的可选输出路径（1.5 起导出含系统提示词与工具）；插件不使用 `--export`。 |
| 声明变化 `types.ModelCostRatesSchema` / `ModelCostTierSchema` / `ModelCostSchema` | 无关。写法由 TypeBox `Type.TObject<...>` 改为 pi-schema 的 `Schema<...>`，字段形状不变（`input/output/cacheRead/cacheWrite: number`，可选 `tiers[]`）。 |
| 声明变化 `types.ProviderConfigSchema` | 无关。这是 `models.json` 的配置 schema（`compat` 改为 `TUnsafe`），插件只调用 `registerProvider`，不解析 `models.json`；`ProviderConfig` 本身未变。 |
| 4 个字段 `ProviderConfig.models.[].cost.{input,output,cacheRead,cacheWrite}` 无法解析 | 需要适配扫描器，不需要适配插件：`agent/providers.mjs` 注册模型时给的 `cost` 四项都是 0，仍满足新声明。无法解析的原因是 1.5 起声明写成 `import("@earendil-works/pi-schema").Schema<T>`，内置读取器不认识；已让读取器按 `T` 解析（测试覆盖，且改回非数字仍报不兼容），现在四项都被证明为 `number`。 |

对 RPC 集成有意义的变更，逐项核实：

- **Z.ai/智谱 `1308`**：Pi 1.5 的 `pi-ai` 重试判断新增不可重试模式 `"code": 1308`，用量上限不再按临时 429 重试。`agent/errors.mjs` 的 `QUOTA_PATTERN` 原先只在错误文字含英文额度措辞时命中；中文提示（「已达到 5 小时的使用上限……」）会落到 429 限流分支成为普通错误。现在补识别 JSON 里的 `code: 1308`（含数字写法与转义写法）并归为 `quota_exhausted`。短时限流（`1302`/`1305`、普通 429、`rate limit`）仍是普通错误，测试覆盖。
- **思考 `off`（GPT-6.1 Terra）**：用 1.5.0 对只读 RPC 实测（临时 `PI_CODING_AGENT_DIR`、`PI_OFFLINE=1`、假 API Key，不发提示词）：`get_available_thinking_levels` 返回 `["off","low","medium","high","xhigh","max"]`。`config-options.mjs` 只在「仅有 off 一档」时隐藏选择器，`off` 与其他档位并存时照常列出；`entry.mjs` 把所选值原样发给 `set_thinking_level`（只有 `default` 哨兵值特殊处理）。无需改代码，新增配置项与整条 ACP 链路（含会话中途改档位）的测试。
- **`Usage.cost.totalFromProvider`**：实测与源码都显示 `get_session_stats` 的 `data.cost` 只是一个数字（各消息 `usage.cost.total` 之和），整份响应的键为 `sessionFile, sessionId, userMessages, assistantMessages, toolCalls, toolResults, totalMessages, tokens{input,output,cacheRead,cacheWrite,total}, cost, contextUsage{tokens,contextWindow,percent}`，没有这个标记；它只出现在消息里的 `usage.cost` 上（SDK/扩展层面，且「合并用量仅当每一部分都由供应商报告才算」）。RPC 拿不到，所以 `usage_update` 的 `cost` 与 `_meta.pi` 都不改；若以后需要，要从 `agent_end` 的消息 usage 自己聚合，另行评估。
- **其余**（TUI、扩展更新说明、导出、终端兼容、更快的流式渲染、`pi.exec` 修复、MCP OAuth 等）对 RPC 无影响，未改代码。工具参数校验改用 `pi-schema`（Breaking Changes 里唯一一条）影响的是 Pi 内部对工具参数的校验与转换，包括经 `coda-mcp.mjs` 注册的 MCP 工具；插件不发工具参数，扩展接口 `registerMcpServer` 与扫描通过项均未变，无需适配。

Coda 的通用检查已迁移到官方包；命令与日常/定时 CI 的职责见 [README](../README.md#开发与兼容检查)。
