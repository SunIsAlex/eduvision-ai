# EduVision AI 项目交接

> 更新时间：2026-08-04（Asia/Shanghai）  
> 当前分支：`main`  
> 交接基线：`1609fdb feat: retain images alongside editable OCR input`

本文面向后续接手本项目的大模型或开发者。开始工作前，请先阅读本文件和 `README.md`，然后执行 `git status --short`，不要覆盖用户尚未提交的改动。

## 1. 项目目标与当前架构

EduVision AI 是一个拍照搜题应用，主要目标是：正确读取图片题目、流式输出严谨解答，并通过 Ultra 子模型审核减少数学错误。

项目有两条推理链路：

1. **服务器托管模式**：React 前端通过 `/api/chat/stream` 连接 Hono/Node 服务，服务端调用 Anthropic-compatible 上游 API，并负责工具调用、Ultra 规划与审核。
2. **手动配置/访客模式**：用户在浏览器填写 OpenAI-compatible API URL 和 API Key。模型请求、SSE 解析、OCR 和 mathjs calculator 均在浏览器执行，Key 不发送给 EduVision 服务端。

主要目录：

- `frontend/src/hooks/useChat.ts`：聊天状态、流式回调、消息编辑及 OCR 回写。
- `frontend/src/lib/api.ts`：服务器 SSE 客户端、本地模式入口、模型发现。
- `frontend/src/lib/localStream.ts`：浏览器直连 API、OCR、DeepSeek thinking 恢复、工具循环。
- `frontend/src/lib/localConfig.ts`：手动 API 配置。
- `frontend/src/lib/persist.ts`：会话消息持久化。
- `worker/src/stream.ts`：服务器 SSE 事件编排。
- `worker/src/reasoning.ts`：服务器主模型、Ultra 规划/审核、工具回合。
- `worker/src/types.ts`：服务端请求、模型和环境变量类型。
- `worker/prompts/*/SKILL.md`：按学科加载的提示词。
- `ops/eduvision-vps/`：生产部署配置。

## 2. 最近完成的工作

### Ultra 子模型审核

- Ultra 模式会边输出主答案边启动逐块审核，不再等整篇答案完成后才统一检查。
- 前端对被审核的内容显示运行中、`✅` 或 `❎` 状态，交互类似 GitHub Actions。
- 默认快速审核模型改为 `gpt-5.6-luna`；高智力主模型可通过 `API_MODEL_ULTRA` 配置。
- 数学提示词已强化：圆锥曲线/解析几何中去除绝对值前必须检验符号或给出符号区间，最终结果要代回原式，不应以近似数替代精确根式。

相关提交：`beaa685`、`3c0c8ad`。

### 手动配置与访客模式

- 登录页支持无密码进入访客模式。
- 访客模式只允许手动配置 API，不调用私有服务器模型、会话或标题接口。
- “结束上下文”入口已由“手动配置”替代。
- 保存配置后自动读取 `/models`，并默认选择可用模型；需要 OCR 时优先使用已发现的多模态模型。
- 手动配置模式支持查看原始 SSE 调试 JSON。
- mathjs calculator 在浏览器本地执行。

相关提交：`94e6beb`、`484802c`、`12c5674`。

### DeepSeek thinking 兼容

- thinking 开关会向 DeepSeek 发送相应配置，并尽量在 chat/reasoner 模型间选择合适模型。
- 修复了仅产生 `reasoning_content`、不产生正式正文时前端卡住的问题。
- 若思维链过长，浏览器以字符结构估算 token；达到约 16k token 时主动取消当前流，保留已有 reasoning，并发起关闭 thinking 的新请求，要求直接生成正式答案。
- 恢复请求会把上一轮 reasoning 作为普通 assistant 上下文带入，避免“思考与回答脱节”。

相关提交：`3c8ee01`、`57e057a`、`ff56246`、`2faceed`。

### OCR 结果成为可编辑用户输入

- 浏览器本地模式收到图片后，先调用多模态模型做纯 OCR 复述。
- OCR 文字立即回写到原用户消息，消息仍保留原图，用户可以编辑 OCR 错别字。
- 多模态主模型的正式请求同时收到 OCR 文字和原始 `image_url`，以保留图形、位置及版面信息。
- 文本主模型只收到 OCR 文字；历史图片也会从发给文本模型的上下文中移除。
- 编辑已经 OCR 回写的消息时，不会再次 OCR 并覆盖用户修订，但界面和持久化消息仍保留原图。

相关提交：`9e98f9c`、`1609fdb`。

## 3. 已知问题与技术债

按优先级排序：

### P0：服务器模式与本地模式的 OCR 语义不一致

当前“图片内容回写为可编辑用户输入，同时保留原图”的完整流程只在手动配置/浏览器本地模式实现。服务器托管模式仍把图片直接交给主模型解题，没有独立 OCR 阶段，也不会发送 `ocr_result` SSE 事件。

建议实现统一协议：服务器在正式解题前执行 OCR，发送单独的 `ocr_result` 事件；前端复用现有 `onOcrResult` 回调更新原用户消息；正式推理仍携带 OCR 文字和原图。注意不要让 OCR 模型开始解题，也不要静默猜测无法辨认的字符。

### P0：OCR 文本和用户原始文字目前直接拼接

本地模式使用 `question + "\n\n" + transcription`。如果用户已输入提示，OCR 模型又复述了相同文字，可能产生重复内容。建议给 OCR 内容增加稳定的结构或标签，例如“用户补充要求”和“图片题目转录”，并在 UI 中允许分别编辑，或至少做明确分隔。

### P1：多模态能力识别依赖启发式

`fetchLocalModels` 优先读取模型列表中的 modalities/capabilities，但许多 OpenAI-compatible 服务不返回能力字段，因此还会根据模型 ID 中的 `vision|omni|4o|4.1|sonnet|gemini|luna|sol` 猜测。可能出现误判：

- 把文本模型当作视觉模型，导致 OCR 请求失败；
- 未识别实际支持图片的模型，导致无法 OCR。

建议在手动配置界面允许用户覆盖“支持图片”标记，并缓存探测结果。

### P1：DeepSeek token 截断是近似策略

`LOCAL_REASONING_TOKEN_LIMIT = 16_000`，token 数通过中日韩字符数及其余字符 `/4` 粗略估算。不同模型、编码和上游预算下不完全准确。更稳妥的方案是：

- 根据模型元数据配置预算；
- 同时观察供应商 usage/finish_reason；
- 在剩余预算阈值触发正式回答，而不是固定单一阈值；
- 为切换请求记录明确的 debug 事件和原因。

### P1：Ultra 审核的正确性仍依赖提示词和分块边界

目前已改善审核时延和可见反馈，但仍需用真实数学题持续回归。重点案例包括：

- 圆锥曲线题精确结果应为 `k=\pm\frac{\sqrt2}{4}`，不得输出错误数值根；
- 去绝对值前必须验证符号；
- 审核发现错误后，最终正文必须真正采用修正，而不是只显示错误标记；
- 很短或跨 Markdown/LaTeX 块的公式不能一直转圈后批量变为成功。

### P2：缺少正式自动化测试套件

目前主要依赖 TypeScript、生产构建、工具 e2e 和临时 mock SSE 脚本。OCR、DeepSeek reasoning 截断、工具回合、SSE 分帧、逐行审核状态都应增加可重复的单元/集成测试。

### P2：前端包体积较大

Vite 构建提示主 bundle 超过 500 kB；`calc.ts` 同时被静态和动态导入，动态导入无法形成独立 chunk。功能不受影响，但可后续做依赖拆包和 lazy loading。

## 4. 建议的下一阶段规划

### 第一阶段：统一图片输入协议

1. 为服务器模式增加严格 OCR 步骤和 `ocr_result` SSE 事件。
2. 前端服务器流与本地流共用相同的 OCR 回写逻辑。
3. 定义消息数据模型：原始图片、OCR 原文、用户修订文本分别保存，避免通过 `ocrGenerated` 单个布尔值推断全部状态。
4. 用户编辑 OCR 后重新生成答案时，继续携带原图和修订文本，但不自动覆盖修订。
5. 为多图、历史图片和图片删除行为补测试。

### 第二阶段：提高 Ultra 数学可靠性

1. 建立固定回归题库，保存期望精确答案与关键证明步骤。
2. 审核输入采用结构化块 ID、原文、局部上下文和候选结论。
3. 审核结果返回结构化的 passed/failed、错误原因和替换文本。
4. 主模型输出结束前等待所有已发送块完成审核，但不阻塞前端继续显示主输出。
5. 对最终答案做一次轻量全局一致性检查，重点检查符号、定义域、根的筛选和代回。

### 第三阶段：加强兼容性与可观测性

1. 将不同供应商的 reasoning、usage、finish_reason 适配拆成 provider adapter。
2. 调试面板增加 round、模型、OCR、截断原因、耗时和 token usage 摘要，同时继续隐藏 Key 和请求头。
3. 为 SSE 增量刷新、取消、重试、断网和空正文建立端到端测试。
4. 优化 bundle 分块和首次加载性能。

## 5. 验证清单

每次提交前至少执行：

```bash
npm run typecheck
npm run build
git diff --check
```

涉及工具时额外执行：

```bash
npm run test:tools
```

图片/OCR 改动应人工或 mock 验证：

1. 多模态主模型：OCR 回写用户消息；正式请求同时包含文字和原图。
2. 文本主模型 + 视觉备用模型：先 OCR；正式请求不包含图片。
3. 编辑 OCR 消息：修订内容不会被再次 OCR 覆盖，原图仍显示并保留。
4. OCR 失败：界面明确报错，不应静默开始无题目解答。

DeepSeek 改动应验证：

1. thinking 关闭时正常流式输出正文。
2. thinking 开启时 reasoning 会影响后续正文。
3. reasoning 接近预算时会切换到正式回答，不会永久卡住。
4. 调试 JSON 中可以看出切换前后的模型响应，但不得出现 API Key。

Ultra 改动应验证：

1. 主答案持续流式显示，审核与之并行。
2. 每个已提交审核的块及时从运行中变为 `✅` 或 `❎`，而非全部长期转圈后一次更新。
3. 错误结论被正文修正，并保留可理解的审核反馈。

## 6. 安全与操作约束

- `./dpsk` 含有用户本地 DeepSeek API URL/Key，已加入 `.gitignore`。**禁止读取后打印、提交或写入文档/日志。**
- 浏览器本地 Key 只能用于用户配置的上游请求，不能发送到 EduVision 服务端。
- 调试 JSON 可以展示供应商响应 chunk，但不得展示 Authorization、`x-api-key` 或完整请求头。
- 会话 UUID 相当于读取凭证，测试和报告中不要公开包含私人内容的会话链接。
- 工作区可能存在用户改动；提交前检查 `git diff`，只提交本任务文件。
- 用户此前的工作习惯是：实现后完成合理验证，并直接 commit + push；若用户只要求审阅/诊断，则不要擅自修改。

## 7. 当前交接状态

- `main` 已推送到远程 GitHub，基线为 `1609fdb`。
- 最近一次代码验证已通过 `npm run typecheck`、`npm run build` 和多模态 OCR 请求体 mock 回归。
- 构建仅有 bundle size 和 `calc.ts` 静态/动态混合导入警告，无编译错误。
- 本文创建前工作区无未提交修改；创建本文后应只看到 `HANDOFF.md`。
- 当前最值得优先处理的是“服务器模式 OCR 回写并保留原图”，随后是自动化数学回归题库。
