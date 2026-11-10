# 协作观察 · DSH Collab Journal

**DeepSeek Harness 原生插件。数据来自 DSH 会话，界面在 DSH 内，解析使用 DSH 配置的模型。**

把一段长对话简化为「人 → AI → 人 → AI」的协作轨迹。先看清事情怎样发生，再形成自己的认识。[为什么做这个项目](docs/philosophy.md)

## 这一版

- DSH 侧栏「协作观察」，按原生 workspace ID 和会话归属分类。同名 workspace 不合并。
- 人工选择会话，点击「解析轨迹」。浏览、刷新不会调用模型。
- 每次真人发言独立保留，连续 AI 回复与工具行动合并；自动注入的 `user/message` 不误算为人。
- 阅读完整会话，包含老会话今天新增的内容、工具结果和失败信息。长日志分片处理，不丢尾部。
- 节点可展开摘要细节和原始上下文，包含原事件序号、时间、JSON 与相邻消息。
- 使用这段会话最近一次模型路由，凭证仍由 DSH 管理。
- 解析中显示进度，可停止；失败保留旧结果；会话变化时提示重新解析。
- 结果和原文快照保存在 DSH 的 storage domain，重启后仍可阅读。

当前聚焦手动轨迹解析。自动筛选、定时日报、周总结是后续能力；本版不生成“下一次应该怎样做”的建议。

## 安装

要求 Node.js **24.9+**、DSH **0.2.2-rc.1**，以及 PATH 中的 pnpm（缺少时执行 `npm install --global pnpm@11.25.0`）。首次安装前更新 DSH 到兼容版本。这一版已对该 DSH 版本进行测试；其他版本需要重新验证。

在本仓库目录执行（PowerShell / bash 均可）：

```sh
git pull
npm ci
npm pack
dsh plugin --profile web add ./dsh-collab-journal-0.2.0.tgz
dsh web
```

已有 DSH Web 实例时，安装后重启它。在左侧点击「协作观察」，选择 workspace、会话，再点击「解析轨迹」。这是安装到 DSH 的插件，无独立服务启动步骤。

`web` 指 DSH 的 Web profile。你运行自定义 profile 时，把安装命令的 `web` 替换为对应名称。桌面版请在该 DSH 实例的 **插件管理 → 添加插件** 中填写本地构建后仓库的绝对路径，安装到桌面实例；CLI 的 web profile 与桌面 profile 不共享安装。桌面壳本身尚未做自动化验收。

仓库尚未发布 npm 包，请使用上面的本地打包安装，不能直接运行 `dsh plugin add dsh-collab-journal`。升级后重新构建、打包、安装并重启即可。

卸载 Web 插件：

```sh
dsh plugin --profile web remove dsh-collab-journal
```

## 使用与数据

模型由源会话最后一个 `request/header` 决定，旧记录则回退到最后一个模型回复的来源。模型已移除时会明确失败，请在 DSH 恢复该路由或用可用模型继续一次对话。没有模型记录的空会话须先完成一次 DSH 对话。

解析会把所选会话的可读文本发送到该 DSH 模型服务，与 DSH 当前模型配置的数据流相同。插件不读取 OpenCode 数据，不另存 API Key，不执行历史对话里的指令，也不向解析模型开放工具。

插件数据使用 `dsh_collab_journal` domain，由 DSH 管理；默认 JSON 后端位于 `$DSH_HOME/storages/dsh_collab_journal.json`。原始 DSH 会话保持不变。每次成功解析保存新结果；原文快照按会话和内容指纹版本化，以免旧摘要引用了新消息。卸载不会主动删除这些记录。

## 验证

```sh
npm ci
npm test
npm install --prefix .dsh-test/runtime --no-save @deepseek-ai/dsh@0.2.2-rc.1
npm run test:integration
npm install --no-save --package-lock=false playwright@1.62.1
npx playwright install chromium
npm run test:browser
```

集成测试实际启动已安装的 DSH，在隔离的 `DSH_HOME` 中通过 `dsh plugin --profile web add` 安装本项目 tarball，使用 DSH 原生 session/workspace/persistence/LLM/storage 服务。覆盖跨日旧会话、合并边界、长工具日志尾部、快照、失败重试、鉴权和重启后的持久会话读取。浏览器测试在真实 DSH 页面中点击原生侧栏入口、解析、展开原文、切换 workspace、搜索并检查窄布局。

测试模型是通过 DSH LLM 服务注册的确定性适配器，用于验证协议和链路，不代表真实模型的摘要质量。真实模型质量需要结合你的会话核对。

## 当前限制

仅解析文本。附件保留类型提示与原事件引用，不识别图片、音频内容。模型归纳仍可能失真，摘要与事实应通过原文核对。工具已经在 DSH 日志中被截断的部分无法恢复。

目录刷新会读取会话日志；会话数量很大时会较慢。当前一次只解析一个会话，每次调用 90 秒、整体 10 分钟超时。历史快照暂不自动清理。日报、周报、批注暂未移植到此插件版本；原独立应用保留在 Git 历史中。

[架构与边界](docs/architecture.md) · [项目哲学](docs/philosophy.md)
