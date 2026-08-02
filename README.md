# EduVision AI · 拍照搜题

生产级 AI 作业解答应用（类似「作业帮拍照搜题」）。学生上传作业照片后，由 Claude Sonnet 直接读图、解题并调用工具，通过 SSE 实时流式返回（支持 Markdown + LaTeX）。

## 架构

```
浏览器 (React + Tailwind + shadcn 风格 UI)
        │ 上传图片 / 流式对话 / 本地执行工具代码（计算器、JS 枚举）
        ▼
Cloudflare Worker (Hono + TypeScript)
        │
        ▼
  MyTokk Anthropic Messages API
        │
        ▼
  claude-sonnet-4-6：读图、推理、解题与工具调用
        ▼
   SSE 事件流：thinking → reasoning → [tool_call → 浏览器执行 → tool_result] → answer → done
```

核心原则：

- **单模型多模态**：Claude 原生接收图片，不需要 OCR 中转，避免转写丢失公式或图形关系。
- **可调试**：调试面板记录每一轮模型响应、停止原因和工具调用。
- **实时输出**：最终解答通过 `answer` 事件逐字流式输出；上游若提供 reasoning delta，也会通过 `reasoning` 事件展示。
- **零成本工具**：计算器（加固版 mathjs）与枚举计数代码（JS）都在**用户浏览器本地**执行——Worker 不装任何代码执行引擎，脚本体积小、不耗服务器 CPU；界面明确提示「风险自负」。

## 功能

- 拍照/拖拽上传题目图片，客户端自动压缩后上传
- Claude Sonnet 原生读图、作答和老师式分步讲解（Markdown + LaTeX 公式渲染）
- 输入区提供“深度思考”开关：关闭时低延迟作答，开启时流式展示 Claude extended thinking 摘要
- SSE 流式输出：`thinking`（开始提示）→ `reasoning`（思维链逐字实时显示）→ `answer`（解题内容逐字输出）→ `done`；模型调用工具时中间插入 `tool_call` / `tool_result` 事件
- 工具支持：`calculator`（精确数学计算，mathjs 加固沙箱）与 `javascript`（Web Worker 沙箱数值求根、平衡方程迭代、枚举/计数），工具调用与结果在聊天中可视化展示
- 按题目难度自适应讲解，回答上限 4096 token
- 移动端响应式聊天界面，API Key 只在 Worker Secret 中

## 目录结构

```
.
├── wrangler.toml            # Worker 配置 + 静态资源（前端 dist）
├── package.json             # npm workspaces（worker + frontend）
├── .env.example
├── worker/
│   └── src/
│       ├── index.ts         # Hono 入口：/api/chat/stream、/api/tool/result、/api/upload、/health、/media/*
│       ├── anthropic.ts     # Anthropic 原生客户端封装 + 流式内容/工具提取
│       ├── reasoning.ts     # 单模型流式作答 + 工具调用循环（图片 + 文本 + 历史）
│       ├── stream.ts        # SSE 事件流编排 + 心跳
│       ├── types.ts         # 共享类型与模型常量
│       ├── dev.ts           # 本地 Node 开发服务器（无 workerd 环境）
│       ├── tools.ts         # 工具定义（calculator / javascript，均在浏览器执行）
│       ├── toolbridge.ts    # 等待浏览器回传工具结果的桥接
│       └── scripts/
│           └── tools-e2e.ts # 端到端协议测试（npm run test:tools）
└── frontend/
    └── src/
        ├── App.tsx          # 聊天界面
        ├── components/      # Composer / ChatMessage / ImageUpload / Markdown
        ├── hooks/useChat.ts # 对话状态 + SSE 消费
        └── lib/             # api / calc（加固 mathjs）/ toolRunner（浏览器沙箱）/ image 压缩 / types
```

## 快速开始

前置：Node ≥ 20、npm ≥ 10。需要 MyTokk API Key（默认模型 `claude-sonnet-4-6`，可在 `.dev.vars` 中用 `API_MODEL` 覆盖）。

```bash
npm install
cp .env.example .dev.vars   # 填入 API_KEY
npm run dev                 # 打开 http://localhost:5173
```

`npm run dev` 同时启动：

- 前端 Vite 开发服务器（`:5173`，`/api` 代理到 `:8787`）
- Worker 本地服务器（`:8787`，基于 `@hono/node-server`，代码与生产完全一致）

> **平台说明**：`wrangler` 依赖的 `workerd` 运行时没有 Android/arm64 二进制，因此在 Termux/Android 上无法安装或运行 wrangler。本仓库已把 wrangler 设为可选依赖，并内置 Node 版开发服务器（`npm run dev`），保证全栈在任意平台可跑。在 macOS/Linux/Windows 上也可以使用官方工作流：`npm run dev:cf`（wrangler dev）。

## 部署

```bash
npm run build                       # 类型检查 + 构建前端静态资源
wrangler login
wrangler secret put API_KEY   # 生产环境密钥，绝不写入代码
npm run deploy                      # 构建前端并部署 Worker（静态资源自动托管）
```

通过 Cloudflare Git 集成自动部署时，请在 Worker 的 **Settings → Variables and
Secrets** 中把 `API_KEY` 添加为 **Secret**。`wrangler.toml` 已启用
`keep_vars = true`，Git push / Wrangler deploy 会保留 Dashboard 中配置的变量。

部署成功后：

- 前端页面：`https://<你的worker子域>.workers.dev`
- 健康检查：`GET /health`
- R2 媒体上传为可选配置（见 wrangler.toml 注释）。

### 腾讯 EdgeOne Makers（本分支）

在 EdgeOne Makers 中导入仓库并设置：

- 构建命令：`npm run build`
- 输出目录：`frontend/dist`
- 环境变量：`API_URL`、`API_KEY`、`API_MODEL`
- KV：创建并绑定 namespace，变量名设为 `TOOL_RESULTS`（跨边缘实例传递浏览器工具结果）

`edge-functions/[[default]].ts` 会把文件路由请求交给同一套 Hono API；静态资源由
EdgeOne Pages 直接提供。由于 Edge Functions 请求体上限为 1 MB，前端会把图片压缩到
约 600 KB，服务端再保留 700 KB 的图片硬限制。

## API

### `POST /api/chat/stream`

请求体：

```json
{
  "image": "data:image/jpeg;base64,... 或 /media/xxx.jpg",
  "question": "解方程 x²-5x+6=0",
  "history": [{ "role": "user", "content": "上一题…" }],
  "requestId": "客户端生成的 UUID，用于工具结果回传"
}
```

返回 SSE 事件流：

| event | data | 说明 |
| --- | --- | --- |
| `thinking` | `{"text":"正在阅读图片并识别题目…"}` | 开始阶段提示 |
| `reasoning` | `{"text":"先观察系数…"}` | 模型思考过程（原始链式推理）逐字实时推送 |
| `tool_call` | `{"toolCallId":"…","name":"calculator","args":"{\"expression\":\"123*456\"}","executor":"browser"}` | 模型请求调用工具；浏览器执行完毕后 POST `/api/tool/result` |
| `tool_result` | `{"toolCallId":"…","name":"calculator","ok":true,"output":"56088"}` | 工具执行结果（随后模型会继续流式推理/作答） |
| `answer` | `{"text":"先观察系数：…"}` | 逐段推送的解答内容 |
| `done` | `{"pipeline":"multimodal","model":"claude-sonnet-4-6"}` | 管线结束 |
| `error` | `{"text":"…"}` | 错误信息（保证最终能收到终止事件） |

### `POST /api/tool/result`

浏览器执行完工具后把结果回传给暂停中的 SSE 流，Worker 再喂给模型继续生成：

```json
{ "requestId": "…", "toolCallId": "…", "ok": true, "output": "56088" }
```

返回 `{ "ok": true }`；若对应的流已超时或不在当前实例，返回 404。

### `POST /api/upload`

multipart 表单，字段 `file`（图片 ≤ 10MB）。配置 R2 后返回 `{url:"/media/<key>"}`；未配置时回退返回 data URL（本地开发用）。

### `GET /health`

返回服务状态、当前使用的模型、R2 是否启用。

## 工具（浏览器端执行）

模型可以通过原生 tool calling 调用两个工具，两者都**不在服务器上执行代码**：

| 工具 | 在哪执行 | 说明 |
| --- | --- | --- |
| `calculator` | 浏览器主线程 | 加固版 mathjs（BigNumber 高精度）：禁用 `import / createUnit / reviver / evaluate / parse / simplify / derivative / resolve`，限制表达式长度、节点数、阶乘/组合/指数/矩阵规模，防止重计算。工具描述内置分类函数清单（数论组合 / 统计 / 线性代数 / 集合 / 单位换算 / 进制 / 常量），模型据此选用正确的函数名；不支持 `//`，整数除法用 `floor(a/b)`；报错信息会给出可操作的修正提示（如不支持中文/`//`、函数名拼写错误），模型可据此自我修正。mathjs 按需懒加载（独立 chunk，gzip 约 190KB），首次调用计算器时才下载 |
| `javascript` | 浏览器 Web Worker | 标准 JS（非线性方程数值求根、化学平衡/物料衡算迭代、枚举、计数、暴力验证、统计）；优先使用带物理区间与残差校验的二分法，`console.log` 输出被捕获回传；Worker 无 DOM/页面访问权限，`fetch` / `importScripts` 被禁用，15 秒硬超时终止死循环 |

流程：模型流式输出思考 → 需要算数/枚举时发出 `tool_call` → 浏览器本地执行并 POST `/api/tool/result` → Worker 把结果作为 `tool` 消息喂回模型 → 同一条 SSE 连接继续流式输出最终解答。前端聊天区会展示每次工具调用的名称、参数与返回结果，并提示「代码在你的浏览器本地沙箱中执行 · 风险自负」。

> 说明：这是**有意的架构选择**——不在 Worker 里内置 Python 解释器或代码执行服务，把执行放在用户浏览器，零基础设施成本。工具代码由模型生成、在你的浏览器中运行，请仅在可信设备/题目下使用（界面已明确风险提示）。`toolbridge` 使用进程内 Map 等待浏览器回传：本地开发与单实例部署完全可靠；多实例 Cloudflare 账号下如需更强保障，可升级为 Durable Object 或改用无状态 continue 端点。

## 模型

| 模型 ID | 说明 |
| --- | --- |
| `claude-sonnet-4-6`（默认） | 原生多模态、流式响应与工具调用均已通过端到端测试 |

## 安全说明

- `API_KEY` 只通过 `wrangler secret put` 注入，前端与仓库均不包含真实密钥
- 输入校验：仅接受 `data:image/*` 与 `https://` 图片，限制 10MB，非法 JSON 返回 400
- 计算器按 mathjs 官方安全建议加固，并叠加表达式长度 / 节点数 / 重函数参数 / 结果规模限制；`/api/tool/result` 校验 `requestId` / `toolCallId` 格式并截断输出上限 20KB
- JavaScript 工具在 Web Worker 中执行（无 DOM、无页面上下文），禁用网络与 `importScripts`，超时自动终止——残余风险由用户承担（界面明示）
- 最终解答实时展示；调试面板可查看每轮原始响应和工具调用
- 所有上游失败都收敛为 SSE `error` 事件，不会泄漏内部堆栈

## 常见问题

**本地报「服务端未配置 API_KEY」**：把 Key 写入项目根目录 `.dev.vars` 后重启。

**需要切换模型**：可在 `.dev.vars` 中设置 `API_MODEL` 为当前账号可用的 Anthropic 模型 ID；模型必须支持图片和工具调用。

**wrangler 装不上**：Android/Termux 不支持 `workerd`，请使用 `npm run dev`（Node 服务器）；部署在 macOS/Linux/Windows 完成。

**图片太大**：前端会自动把图片压缩到最长边 1600px 的 JPEG，Worker 侧仍保留 10MB 硬限制。

**工具没有生效 / 看不到调用**：模型不强制调用工具——普通口算与手写推导正常进行，但鼓励在关键数值计算与验算（判别式、验根、组合数、单位换算等）时调用 `calculator` 验证并标注结果；需要枚举/计数时可用 `javascript` 工具。纯符号推导与概念解释不触发。可用 `npm run test:tools` 跑端到端协议测试验证（计算器 123×456、ln(100)、解方程验根与骰子枚举等场景）。
