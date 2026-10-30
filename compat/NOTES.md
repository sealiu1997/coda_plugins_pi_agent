# Pi 兼容检查

在仓库根目录运行（Node ≥24，无第三方依赖）：

```sh
node scripts/check-pi-compat.mjs
node scripts/check-pi-compat.mjs --json
node scripts/check-pi-compat.mjs --pi /opt/homebrew/bin/pi
node scripts/check-pi-compat.mjs --install latest
node scripts/check-pi-compat.mjs --install 1.1.0 --json
# 人工确认报告后，才接受本机或指定候选版本：
node scripts/check-pi-compat.mjs --accept
```

退出码：0 兼容且无新增；1 不兼容；2 新增、版本漂移、未确认基线或证据不足；3 无法检查（路径、启动、超时、安装失败等）。`--accept` 不会覆盖含确定不兼容的快照。证据不足的项目即使人工接受快照，仍保持待评估。

`pi-surface.json` 是插件依赖的唯一清单，每个接口、字段、枚举都有 agent 源文件证据。`package.json` 中暴露给 Coda 的 settings.json/models.json 也记录在清单里；agent 本身不解析这些 Pi 配置文件，没有固定依赖的 Pi 设置键。Coda 的 `pi.*` 设置不算 Pi 的 Settings。修改插件接口时同步更新清单；测试核对显式 RPC 发送、CLI 字符串、扩展调用、事件分支和消费的 record 字段。

`pi-snapshot.json` 保存版本、全量已发现的命令、事件、CLI 参数、扩展方法、设置键（含嵌套键）、扩展 UI 方法及声明签名。首次缺少快照时自动生成 `reviewed: false` 的候选基线；只有显式 `--accept` 才标记人工确认。普通检查不覆盖已有快照。本仓库附带的 1.1.0 初始快照尚未人工确认。

来源按以下优先级读取，完全不导入执行 Pi 的 JS：

| 接口 | 首选来源 | 置信度 |
| --- | --- | --- |
| RPC 命令、响应、扩展 UI | `dist/modes/rpc/rpc-types.d.ts` | 高 |
| 会话事件 | `dist/core/agent-session.d.ts` + 随包 pi-agent-core 的 AgentEvent | 高 |
| 模型及消息内容 | 随包 pi-ai 的 `.d.ts` | 高 |
| 扩展 API | `dist/core/extensions/types.d.ts` | 高 |
| 设置键 | `dist/core/settings-manager.d.ts` 的 Settings 及引用类型 | 高 |
| CLI 参数 | 隔离运行的 `pi --help` 选项行 | 中高；帮助文本可能不完整 |
| 文档回退 | 包内 docs/rpc*.md、extensions.md、settings.md、cli.md | 低；只提示人工评估 |

内置声明读取器识别对象、联合、继承、泛型引用和常见索引访问，不等价于 TypeScript 编译器。字段核对使用 JSON 粗类型；无法解析的结构会提示人工评估。基线签名变化也会报告，以覆盖参数、可选性和枚举等进一步变化。工具结果 `partialResult`/`result` 在 Pi 1.1.0 声明中为 `any`，不能静态保证其 content 结构。用户额外参数、用户扩展、任意 provider 的错误文字、MCP 配置值展开语义，以及需要真实模型回合才能观察的行为仍需人工验证。不会为了证明这些行为发送 prompt 或调用模型。

实测仅运行固定的五个 getter，使用临时 cwd、HOME、PI_CODING_AGENT_DIR 和 session 目录；不继承 API Key，关闭扩展、MCP、资源发现、遥测与启动网络。空模型列表、未命名会话和空上下文合法，探测不会据此判断登录失败。未出现的可选字段依靠声明检查；报告中的“只读探测通过”不代表实际观察到全部可选字段。结束先 TERM，500ms 后 KILL，并等待子进程关闭。

候选安装复用 Coda/当前 Node 附带的 npm，使用临时 global prefix 与 npm cache，结束后删除；不更新用户全局 Pi。安装依赖 npm 包自带的安装行为，网络安装错误返回 3。二进制定位支持 npm 符号链接及字面量绝对 exec 路径的 shell 包装；其他包装器需要 `--pi` 指向实际入口。CHANGELOG 如存在则按版本标题摘录；版本缺失或降级时会提示边界限制。
