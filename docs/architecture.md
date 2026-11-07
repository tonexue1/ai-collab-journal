# 实现与维护

产品取舍以 [为什么做协作观察](philosophy.md) 为依据：先保证事实完整、判断可追溯、人的纠正有效，再扩充功能。本文描述当前实现，尚未达到的要求在“已知限制”中列出。

针对当前实现的复现证据、最小改法与验收案例见 [基于项目哲学的工程评审](engineering-review.md)。其中的修改建议尚未实施。

## 模块

| 文件 | 职责 |
|---|---|
| `src/opencode.mjs` | 官方 CLI 的版本探测、会话导出、JSON 事件流解析和模型调用 |
| `src/analysis.mjs` | 当天筛选、按会话补上下文、分段、结构校验、证据校验、事件去重 |
| `src/engine.mjs` | 日/周流水线、任务生命周期、补跑、Markdown 导出 |
| `src/store.mjs` | SQLite、原文快照、稳定事件 ID、人工批注、跨进程锁 |
| `src/server.mjs` | 本机 HTTP API、同源限制、静态页面 |
| `public/` | 无构建依赖的网页，原文和模型内容均转义后展示 |
| `scripts/` | Windows 启动与任务计划安装 |

首版采用 CLI 适配器，避免要求用户另行启动 OpenCode HTTP 服务，也不绑定某个 SDK 参数版本。后续可新增 HTTP/SDK adapter，只要提供 `collect()` 和 `analyze(task,data,schema)` 即可。历史和模型调用共享 OpenCode 已有配置，分析工作目录独立。

## 一次日报

1. 获取跨进程租约，记录 run。
2. 在 `projects` 指定的每个项目目录列出和导出会话。OpenCode 1.x 会话列表按项目隔离，因此空 projects 明确报错，不能将分析目录当作全局历史。创建日期不作为筛选条件；任一选中会话读取失败时停止，不发布“完整”结果。
3. 保存消息；按北京时间当天边界选取事件材料，向前后补上下文。保存内容寻址的原会话快照。
4. 按预算分段，通过 stdin 将 JSON 材料传给 `opencode run`。避免 `--file` 的变长参数吞掉提示词，也不需要放开附件 read 权限。每个事件至少引用一条当天的人类会话用户消息，ID 必须来自本批输入和原文。
5. 以日期、来源会话和最早用户锚点生成稳定事件 ID，合并同锚点事件。
6. 汇总概况。人工批注作为参考，不能自动转为全局规则。
7. 事务替换该日期的分析结果，人工批注独立保存。旧事件的批注仍可访问。
8. 导出 Markdown，记录成功，释放租约。失败记录错误并保留上次成功日记。

事件锚点变更时会产生新 ID；此时旧批注保留在历史区，不自动猜测归属。输入快照去重，既能回查分析当时的原文，又避免同内容重复存储。

## API

| 接口 | 行为 |
|---|---|
| `GET /api/status` | 本地模式、日期、项目配置；不返回密钥 |
| `GET /api/reviews` | 日记索引 |
| `GET /api/reviews/:date` | 日记、事件及保留的旧批注 |
| `GET /api/events/:id` | 事件及日期 |
| `GET /api/events/:id/context` | 分析时的原文快照；支持 before/after/full/sessionId |
| `PUT /api/events/:id/reflection` | 保存 note、category、follow |
| `POST /api/runs` | `{kind,date,collect}`，返回任务 ID，后台执行 |
| `GET /api/runs` | 最近运行状态 |
| `GET /api/weeks` | 每周观察 |
| `POST /api/import` | 导入 OpenCode 会话导出 JSON |
| `GET /api/export/:date` | 导出 Markdown |

浏览原文和保存批注均不调用 LLM。前端通过任务记录轮询进度，失败与尚未生成区分。

## 部署约束

这是本机应用，不需要云数据库、向量数据库、消息队列或 Docker。Node 24 提供内置 SQLite，所有 npm scripts 不需要先安装依赖。源代码与运行数据分离，仓库不应包含 config.json、data/、密钥或真实会话。

## 已知限制

- 长对话分片存在已复现的归纳缺口：用户指令与最终结果可能落入不同片段；没有当天用户锚点的后续片段不能独立形成事件，同锚点合并也只追加证据、不更新摘要和结果。原文保留不代表事件结局已正确归纳，待修复。
- 人工核对目前限于分类、笔记和关注标记；尚无明确否定误判、修改事件事实、补入遗漏或独立浏览当天全部会话的入口。
- 修改批注或重跑日报尚不会将已有周报标记过期；带批注的历史事件会与当前事件一起进入周分析，输入没有历史身份标记。需要补齐结论更新与版本区分。
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
