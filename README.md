# 协作观察 / AI Collaboration Journal

每天用 5—10 分钟核对 AI 协作事件、回看当时的上下文、写下自己的思考。每周再从真实记录中寻找重复模式。

我们希望从真实协作中看清自己承担的工作，把零散经验变成可核对、可积累、可验证的认识。先观察和理解，再决定什么值得优化。项目的出发点、产品原则与验收标准见 [为什么做协作观察](docs/philosophy.md)。

**本地应用，首版 v0.1。** Node.js 24+，SQLite，浏览器界面；无第三方运行时依赖，无需 Docker 或虚拟化。OpenCode 历史、日记和批注保存在本机 `data/`，不会提交到 Git。分析会通过现有 OpenCode 模型配置发送材料到对应模型服务。

## 快速启动

先安装 [Node.js 24 LTS](https://nodejs.org/)；本机需已安装并配置可正常运行的 OpenCode。

```powershell
# 在本项目目录执行，无需 npm install
Copy-Item config.example.json config.json
# 编辑 config.json：projects 填入需要回顾的项目目录，例如 ["C:/work/app"]
node src/cli.mjs doctor
npm start
```

浏览器打开 **http://127.0.0.1:4318**。选择日期，点击“生成日记”。首次可先回顾今天；今天的报告会标为暂稿，次日补齐为完整日记。

想先看界面而不调用模型：

```powershell
npm run demo
```

演示使用独立的 `data/demo/` 数据库，页面明确标记，示例为合成内容，不能作为真实工作记录。同一个端口不能同时运行正式与演示服务。

## 已实现

- 按北京时间的**消息时间**筛选当天交流，包含旧会话当天新增的消息。
- 通过官方 CLI 列出和导出会话；自动探测 `opencode export` 或 `opencode session export`。
- 在独立工作目录调用 OpenCode 现有模型，禁用分析会话工具权限，提取事件并汇总日记。
- 每个事件引用真实会话 ID 和消息 ID；拒绝不存在的引用和仅依靠旧消息构造的当天事件。
- 保存该次分析的原文快照；查看前后文、跨日背景、完整会话和工具结果。
- 手动修正分类、事实与结果，排除误判、写批注、标记周总结关注项。可从“当天对话”浏览未被 AI 选中的材料并补记事件；重跑保留人工补记和同一事件的修正。
- 同一轮任务的跨日助手/工具结果会参与原日期分析；夜间采集后检查材料变化，刷新受影响的旧日报。长片段携带已有事件继续分析并更新结果。
- 日/周概况在人工判断变化后提示待更新；周总结保存当时的事件及原文依据，可以回看历史版本。
- 每周总结引用跨日事件，至少两天的证据才能形成模式；明确显示缺失日期。
- Windows 北京时间每天 02:00 调度，漏跑补齐，重复运行不重复生成完整日报。
- SQLite 跨进程锁、失败记录、失败不覆盖已有日记、Markdown 导出。

## 配置

复制 `config.example.json` 为 `config.json`，按需修改：

| 字段 | 说明 |
|---|---|
| `opencodeCommand` | CLI 命令或绝对路径；计划任务建议使用绝对路径 |
| `model` | 空值沿用默认模型，或填 `provider/model` |
| `projects` | 自动采集必填。填需要回顾的项目绝对路径，例如 `["C:/work/app", "C:/work/sdk"]`；程序逐个目录执行 CLI，再按会话的 `directory` 精确匹配。空数组只适用于演示或手动导入分析 |
| `startDate` | 补跑起点；空值在首次运行时记录为当天，不追补更早历史 |
| `dataDir` | 数据目录，默认 `./data`，相对项目根目录解析 |
| `port` | 本地网页端口，默认 4318 |
| `maxInputChars` | 单个分析片段的字符预算，默认 28000；字符预算不是 token 数 |
| `timeoutMs` | 单次 OpenCode 运行超时，默认 10 分钟 |
| `maxSessions` | 会话枚举上限；达到上限会报错，不当作完整采集 |

分析目录使用 OpenCode 全局模型连接，不自动继承业务项目的 `opencode.json`。仅项目级 provider 请先配置到 OpenCode 全局连接；不要把业务项目的插件或权限整体复制进分析目录。`doctor` 显示分析位置解析出的模型标识与配置范围，不输出连接凭证；它不调用模型，不能验证认证或额度。

复盘口径在 `review-rules.md`，可单独调整。模型按明确 JSON 结构输出，程序二次校验。`--format json` 是 OpenCode 的**事件流**格式，不代表模型已返回符合业务结构的 JSON。

## 手动执行

```powershell
node src/cli.mjs review --date 2026-11-07
node src/cli.mjs weekly --start 2026-11-02  # 周一
node src/cli.mjs due                      # 补齐从起点到昨天，并处理已结束的周
```

不用打开网页也能运行。网页与定时任务共用一个数据库，禁止同时跑两个复盘任务。

已有导出文件时：

```powershell
node src/cli.mjs import --file C:\path\session.json
node src/cli.mjs review --date 2026-11-07 --offline
```

`--offline` **只表示不重新采集**，分析仍调用 OpenCode 和其模型。导入格式为 `{ "info": { "id": "..." }, "messages": [{ "info": { "id": "...", "role": "user", "time": { "created": 0 } }, "parts": [...] }] }`，时间需要实际有效值。页面也支持导入。

## Windows 凌晨定时

先手动验证一次真实日记，再安装任务：

```powershell
.\scripts\install-schedule.ps1
Get-ScheduledTaskInfo -TaskName AI-Collab-Journal
Start-ScheduledTask -TaskName AI-Collab-Journal
```

任务的 StartBoundary 明确为 `02:00:00+08:00`，无需更改系统时区。任务直接运行 Node，使用当前用户和固定工作目录；程序内部按 `Asia/Shanghai` 计算日期。安装脚本会输出下一次运行的北京时间，请在本机核对。

- **当前用户需要保持登录**，锁屏可以；注销后需等下次登录补跑，不索取用户密码。
- 默认请求唤醒睡眠中的电脑，可用 `-NoWake` 关闭；实际是否唤醒取决于 Windows/硬件电源策略。关机不能运行。
- 开启错过任务后尽快运行。补跑只从配置起点开始，今天暂稿不会被误认为完整日报。
- 一次补跑共用一次采集；某日材料处理失败会记录并继续其他日期，整批保留失败状态。采集或模型服务等全局故障会停止整批，避免逐日重复请求。
- 每天任务完成日报后，检查是否有已结束但尚未生成的周；周一会处理上周。
- 日志为 `data/schedule.log`，运行明细也在页面“运行记录”。源对话内容不写入运行日志。
- 企业执行策略若阻止 PowerShell，请按组织要求处理；本脚本不修改系统执行策略。

```powershell
Disable-ScheduledTask -TaskName AI-Collab-Journal
Enable-ScheduledTask -TaskName AI-Collab-Journal
Unregister-ScheduledTask -TaskName AI-Collab-Journal
```

## 数据与边界

- `data/journal.sqlite`：原文、分析快照、日报、事件、独立批注、周总结、任务状态。
- `data/daily/YYYY-MM-DD.md`：日记导出；网页批注保存时同步更新。**数据库中的批注是事实来源，外部手改导出文件不会回写。**
- `data/weekly/周一日期.md`：周总结导出。
- `data/analysis-workspace/`：隔离分析会话的工作目录。材料通过标准输入发送，不经过 shell 参数或附件读取；OpenCode 自身仍会保存分析会话，用前缀和 ID 排除。
- 不默认实时监听或改动开发会话；v0.1 每次导出选定会话，优先完整性。历史很多时建议限制项目范围。
- 子代理会话不能可靠视为人发出的消息，因此保留其原文但不独立归纳为人的介入。暂未实现跨子会话自动追溯。
- 原会话中已经被删除或压缩清理的内容无法凭空恢复；图片、视频等附件只显示元信息。
- 长消息分段保留；超出日/周汇总预算会失败并提示，避免静默丢失。复杂跨片段事件仍可能归纳不准，需人工核对。
- 事件锚点变化时，不猜测旧修正归属；旧批注保留在历史区。依据版本变化会提示重看。旧版程序生成的周总结没有当时的事件快照，重新生成后才开始保留可回查的版本。
- 工具权限全拒绝仅适用于本工具创建的分析目录，不更改全局 OpenCode 配置。
- 只监听本机地址；正式模式校验 Host 和 Origin。不要把服务直接暴露到公网。

## 验证与当前状态

```powershell
npm run check
npm test
```

36 项单元及 HTTP 回归测试覆盖跨日结果回补、长日志结局、明确纠错与补漏、冻结周证据、概况过期、保存竞态、失败隔离，以及原有的日期、采集、并发锁和 CLI 兼容行为。

另外提供真实 OpenCode 集成测试：

```powershell
npm install --global opencode-ai@1.1.48
npm run test:integration
```

测试使用隔离的 XDG 目录、两个临时 Git 项目、真实 OpenCode CLI 和本地固定响应的模型接口。验证会话创建/续聊/导入导出、跨项目采集、默认模型的 stdin 输入、日报/周报、HTTP 原文与批注、失败保留。它不会读取本机历史或使用真实模型凭证；不验证模型理解能力。也可通过 `OPENCODE_TEST_BIN` 指向已有的 CLI。不要为测试降级日常使用的 OpenCode，版本矩阵可直接看 GitHub Actions。

CI 矩阵为 Windows/Linux × OpenCode 1.1.48/1.19.5；Windows 另安装独立任务，核对凌晨 02:00 配置后，将该临时任务改为 15 秒后的时间触发，验证实际执行 `due`，完成后清理。

浏览器 CI 使用合成材料验证延迟保存时继续输入、修正持久化、排除误判、浏览原文并补记、冻结周证据和手机宽度布局。可安装仅供测试的 Playwright 1.62.1 后运行 `npm run test:browser`；日常使用应用不需要它。

页面已经实际验证生成、完整原文、保存与重跑保留批注。**真实托管模型的语义效果仍未验收**：远端免费模型探测收到 `429 FreeUsageLimitError`，没有将协议测试冒充真实 LLM 测试。各平台执行结果以仓库 Actions 为准；本机睡眠唤醒和企业策略仍需现场核对。

架构与后续维护见 [docs/architecture.md](docs/architecture.md)。
