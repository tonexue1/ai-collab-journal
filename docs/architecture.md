# DSH 插件架构

## 约束

这是 DSH 原生插件。会话、workspace、模型、凭证、持久化、前端容器都由 DSH 提供。插件只负责协作轨迹的组织、摘要和呈现。

## 接入

| 工作 | DSH 接口 | 插件模块 |
| --- | --- | --- |
| 安装与激活 | `dsh.bundle.patch`，Cordis 生命周期 | `cordis.patch.yml`、`src/index.mjs` |
| 完整会话 | `sessionQuery.listSessions/readSession`，包含 live 与 persisted | `src/service.mjs` |
| Workspace | `workspaceRegistry.list()` 的 ID、`sessionIds`、归档集合 | `src/service.mjs` |
| 解析模型 | `llm.prepareCall` + 原会话 provider/model + `BlockAssembler` | `src/model.mjs` |
| 持久化 | `storageDomain.open`，`dsh_collab_journal` domain | `src/domain.mjs` |
| 通信 | `connection.fetch.register`，DSH 原生鉴权与来源校验 | `src/index.mjs` |
| UI | DSH 模块工厂、`sidebar.panellist`、`main` slot | `src/client.jsx`、`src/style.css` |

前端与 DSH 共用 React 实例，通过 `window.__ModuleLoader__` 加载。CSS 限定在插件根节点，使用 DSH 主题变量、容器查询适配宿主主栏宽度。卸载时撤销路由、槽位与样式，取消解析并关闭 domain。

## 事实与摘要的边界

程序读取完整 raw event log，保留每次 `source.kind === 'user'` 的真人表达。自动注入的上下文不制造人的介入。AI 的连续回复、工具调用/结果和失败结局归入相应节点。来源序号、角色、时间、工具次数由程序计算，模型只能填写 summary/details。

可读材料按 2400 字符分片，每次至多 4 片。先归纳各片，再在同一节点内分层合并；所有片段都进入处理。模型输入每项只暴露一个待复制的 id，内部 nodeId、seq 和子摘要 id 不参与模型输入。校验输出 ID 覆盖、唯一性、摘要与细节长度。工具调用不等于成功，计划不等于结果；提示词明确要求保留未知与失败。

`src/output.mjs` 给出不含正文的字段级错误。details 缺省/null 变为空数组，字符串变为单项数组，文本空白规范化；超长文本不截断，错误 ID 不按位置猜测。格式校验失败时，只对当前批次附加校验反馈重试，最多额外两次，覆盖分片和合并两个阶段；传输、鉴权、超时、取消等错误不进入格式重试。所有尝试共用整体截止时间。耗尽重试后保留失败阶段、模型路由、调用次数、具体字段问题，UI 可展开诊断信息；后台仅为格式校验错误记录受控消息和堆栈，不记录原始模型响应。

原始材料的内容指纹定义 snapshotId。`versions` 保存解析时的原文与结果，`reports` 指向最近成功结果。先写版本，再替换当前结果；中途失败、停止或模型输出不合法时，当前结果不变。浏览旧结果时按旧 snapshotId 取上下文。会话新消息只标记 stale，不悄悄覆盖旧摘要。

一次运行最多 10 分钟，每个模型调用最多 90 秒；一次只允许一个解析，重复点击同一会话复用当前任务。UI 异步响应按会话选择版本隔离，避免切换后显示上一会话结果。读取目录和详情不会调用模型。

## 已知限制

- 真实模型可能归纳错误，原文引用是核查入口，不自动证明摘要正确。
- 图片等非文本附件只显示提示；不恢复源日志已经丢失的内容。
- 目录完整读取开销随日志规模增长，暂未增加自有索引或后台采集。
- 历史快照尚无清理策略；重启会结束未完成的解析，但保留最近成功结果。
- 仅验证 DSH 0.2.2-rc.1 的 Web profile，桌面壳及后续 DSH 版本需另验。
- 日报、周报、定时筛选、人工批注尚未作为原生插件实现。

## 验收方式

纯函数及服务测试覆盖来源区分、长日志、输出校验、去重、错误保留、证据不可变。集成测试安装真正的 tarball、启动真实 DSH，使用原生持久会话与 workspace。模型使用 DSH 注册的确定性适配器，明确与真实模型语义质量分开。浏览器测试加载真实 DSH Client，执行侧栏进入、解析与原文操作，输出桌面及窄栏截图。
