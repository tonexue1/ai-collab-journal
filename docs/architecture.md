# 实现与维护

产品取舍以 [为什么做协作观察](philosophy.md) 为依据：先保证事实完整、判断可追溯、人的纠正有效，再扩充功能。本文描述当前实现，尚未达到的要求在“已知限制”中列出。

## 模块

| 文件 | 职责 |
|---|---|
| `src/opencode.mjs` | 官方 CLI 的版本探测、会话导出、JSON 事件流解析和模型调用 |
| `src/analysis.mjs` | 当天筛选、按会话补上下文、分段、结构校验、证据校验、事件去重 |
| `src/engine.mjs` | 日/周流水线、任务生命周期、补跑、Markdown 导出 |
| `src/store.mjs` | SQLite、原文快照、事件版本、人工决定、日期材料版本、冻结周报告、跨进程锁 |
| `src/server.mjs` | 本机 HTTP API、同源限制、静态页面 |
| `public/` | 无构建依赖的网页，原文和模型内容均转义后展示 |
| `scripts/` | Windows 启动与任务计划安装 |

首版采用 CLI 适配器，避免要求用户另行启动 OpenCode HTTP 服务，也不绑定某个 SDK 参数版本。后续可新增 HTTP/SDK adapter，只要提供 `collect()` 和 `analyze(task,data,schema)` 即可。历史和模型调用共享 OpenCode 已有配置，分析工作目录独立。

## 一次日报

1. 获取跨进程租约，记录 run。
2. 在 `projects` 指定的每个项目目录列出和导出会话。OpenCode 1.x 会话列表按项目隔离，因此空 projects 明确报错，不能将分析目录当作全局历史。创建日期不作为筛选条件；任一选中会话读取失败时停止，不发布“完整”结果。
3. 保存消息；按北京时间当天边界选取材料，补入上下文及该日用户指令后、下一条用户消息前的助手/工具结果（可以跨日）。保存内容寻址的原会话快照和本次材料指纹。
4. 按预算分片，通过 stdin 将 JSON 材料传给 `opencode run`。后续片段带上已有事件和已引用材料的限长摘录，可更新同一事件的结果。引用须来自明确提供的本片或此前证据，仍须包含原日期的真实用户锚点。
5. 以日期、来源会话和最早用户锚点生成事件 ID；合并后续结果和引用。内容或原文快照变化生成新版本，旧版本保留。
6. 通过同一有效事件读取逻辑应用人工修正，排除明确否定的事件，并保留人工补记，再汇总概况。笔记作为有情境的个人判断，不自动变成全局规则。
7. 事务更新该日期的机器提案，人工记录独立保存。材料版本变化使相关汇总过期；汇总期间发生的人工修改不会被误标为已纳入。旧事件批注只保留作历史，不混入当前周事实。
8. 导出 Markdown，记录成功，释放租约。失败记录错误并保留上次成功日记。

事件锚点变更时会产生新 ID；此时旧批注保留在历史区，不自动猜测归属。输入快照去重，既能回查分析当时的原文，又避免同内容重复存储。

周报告保存源日期版本和当时的有效事件快照，历史证据通过报告 ID 查询，不能跳转到被重跑覆盖的当前事件。修改批注或重新提取后，源版本不匹配即提示待更新。旧版周报告缺少的事件快照不能凭空补造。

`due` 持有整批租约并共用一次采集，然后比较既有日报的材料指纹及概况版本；完整日期仍可因后续结果或人工修正而更新。单日故障记录后继续，整体采集或模型服务故障停止整批。

## API

| 接口 | 行为 |
|---|---|
| `GET /api/status` | 本地模式、日期、项目配置；不返回密钥 |
| `GET /api/reviews` | 日记索引 |
| `GET /api/reviews/:date` | 日记、事件及保留的旧批注 |
| `GET /api/events/:id` | 事件及日期 |
| `GET /api/events/:id/context` | 分析时的原文快照；支持 before/after/full/sessionId |
| `PUT /api/events/:id/reflection` | 保存 note/category/follow、decision、overrides；expectedVersion 防止过期写入，basedOnRevision 记录核对依据 |
| `GET /api/sessions?day=YYYY-MM-DD` | 列出已采集的当天会话，不依赖 AI 提取结果 |
| `GET /api/sessions/:id` | 当前采集范围内的完整原文 |
| `POST /api/events` | 带实际消息依据的人工补记，重跑不删除 |
| `POST /api/runs` | `{kind,date,collect}`，返回任务 ID，后台执行 |
| `GET /api/runs` | 最近运行状态 |
| `GET /api/weeks` | 每周观察 |
| `GET /api/weeks/history?start=YYYY-MM-DD` | 该周保存的报告版本 |
| `GET /api/weeks/:weekId/events/:id` | 周报告当时采用的事件；context 接口传 weekId 可回看当时原文 |
| `POST /api/import` | 导入 OpenCode 会话导出 JSON |
| `GET /api/export/:date` | 导出 Markdown |

浏览原文和保存批注均不调用 LLM。前端通过任务记录轮询进度，失败与尚未生成区分。

## 部署约束

这是本机应用，不需要云数据库、向量数据库、消息队列或 Docker。Node 24 提供内置 SQLite，所有 npm scripts 不需要先安装依赖。源代码与运行数据分离，仓库不应包含 config.json、data/、密钥或真实会话。

## 已知限制

- 长片段采用逐片更新已有归纳，仍可能出现模型理解错误；预算超过上限时明确失败。跨越其他用户回合或其他会话的同一任务，尚无可靠的自动身份关联。
- 仅业务项目级的模型连接不会自动进入独立分析目录；当前明确支持 OpenCode 全局连接，doctor 只检查解析结果，不证明认证或额度可用。
- 已增加真实 OpenCode 1.1.48/1.19.5 的隔离集成测试；模型侧为本地协议替身，真实模型语义效果仍未验收。兼容性由 CI、doctor 和首次手动运行共同确认，不能默默升级用户的 OpenCode。
- 每天 5—10 分钟的核对目标、真实忙碌日的阅读负担，以及持续使用是否形成有价值的认识，仍需用户实际使用验证。
- 某些 OpenCode 版本、插件或模型可能改变导出/事件格式；不识别时明确失败。需要根据实际返回扩充 adapter。
- AI 归纳可能不准确；引用校验只能防止无效来源，不能证明语义判断正确。
- 无二进制附件视觉分析；无跨子会话自动追溯；首版采集不做实时事件监听。
- 日/周摘要过大时明确报错。未来可引入多级汇总，但必须保留事件覆盖与证据。

## 参考

- https://opencode.ai/docs/cli/commands/
- https://docs.opencode.ai/docs/cli/
- https://docs.opencode.ai/docs/sdk/
- https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-startboundary-triggerbasetype-element
