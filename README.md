# EduVision AI · 拍照搜题

基于 Claude Sonnet 的多模态作业解答应用。生产环境运行在 VPS 的单实例 Node.js 服务中，React 前端与 Hono API 由同一进程提供。

## 架构

```text
浏览器（React）
  ├─ 上传/压缩图片
  ├─ 渲染 Markdown + LaTeX
  └─ 本地执行 JavaScript 工具
          │ SSE + 工具结果回传
          ▼
VPS Node.js（Hono）
  ├─ Anthropic Messages API 流式代理
  ├─ 按用户隔离的账号与会话持久化
  └─ 前端静态资源
          │
          ▼
MyTokk Anthropic-compatible API → claude-sonnet-4-6
```

项目不再包含 Cloudflare Worker、Wrangler、EdgeOne Functions 或 R2 部署代码。

## 功能

- Claude 原生多模态读图与连续对话，保留历史文字和图片。
- 可选 adaptive thinking 摘要。
- 可选 Ultra 模式：高智力模型先规划解题思路，作答完成后由子代理复核最终答案的数值与代数结论，发现不一致时自动追加修正。
- SSE 流式答案、工具调用卡片和原始响应调试面板。
- 可选浏览器本地模式：通过“手动配置”填写 OpenAI 兼容 API URL/Key，SSE 和 mathjs calculator 均在浏览器本地运行，Key 不发送到本服务。
- VPS 加固版 calculator 与浏览器 Web Worker JavaScript 沙箱。
- 用户名与独立密码登录；每个账号拥有隔离的云端会话列表，可跨设备恢复。
- 当前会话仍保留 URL 定位，但必须登录所属账号才能读取。
- Markdown、GFM、KaTeX 渲染，兼容多工具回合间相邻公式块。
- 用户可显式选择通用、数学或化学 SKILL；学科提示词按需从 `worker/prompts/*/SKILL.md` 加载。

## 本地开发

要求 Node.js 20 或更高版本。

```bash
npm install
cp .env.example .dev.vars
# 在 .dev.vars 中设置 API_URL、API_KEY、API_MODEL
npm run dev
```

访问 `http://localhost:5173`。Vite 将 `/api` 转发到本地 Node 后端 `http://localhost:8787`。

常用命令：

```bash
npm run typecheck
npm run build
npm run test:accounts
E2E_USERNAME=tester E2E_PASSWORD=your-password npm run test:tools
```

`test:tools` 连接已启动的本地服务；仅在临时测试服务器上可额外设置 `E2E_REGISTER=true` 自动创建测试账号。

## 生产部署

VPS 文件和脚本位于 `ops/eduvision-vps/`：

- `eduvision-ai.service`：systemd 单实例 Node 服务。
- `nginx.conf`：HTTPS、SSE 无缓冲反向代理。
- `deploy.sh`：拉取指定分支、安装依赖、构建并重启。
- `openclaw-eduvision-root`：受限的部署/状态入口。

生产环境变量保存在 `/etc/eduvision-ai.env`，只需要：

```dotenv
API_URL=https://api.mytokk.com
API_KEY=...
API_MODEL=claude-sonnet-4-6
# 可选：Ultra 模式使用的高智力模型；缺省时回退到 API_MODEL
API_MODEL_ULTRA=gpt-5.6-sol
# 可选：逐块增量审核使用的低延迟模型
API_MODEL_REVIEW=gpt-5.6-luna
# 可选：向 Desmos 申请的生产嵌入 key；缺省时绘图卡片降级显示表达式
DESMOS_API_KEY=...
# 开放注册；生产环境建议设置邀请码，建完账号后可设为 false
ALLOW_REGISTRATION=true
REGISTRATION_CODE=...
# 可选：Cookie 签名密钥；缺省时自动生成到用户数据目录
AUTH_SESSION_SECRET=...
# 管理面板 /admin 的独立密码
ADMIN_ACCESS_PASSWORD=...
# 可选：上游模型连接池/排队参数（下列为默认值）
UPSTREAM_CONNECTIONS=16
UPSTREAM_MAX_CONCURRENCY=12
UPSTREAM_MAX_QUEUE=64
UPSTREAM_QUEUE_TIMEOUT_MS=30000
```

部署：

```bash
sudo /usr/local/sbin/openclaw-eduvision-root deploy
sudo /usr/local/sbin/openclaw-eduvision-root status
```

线上地址为 `https://eduvision.sunisalex.org`。

## API

- `POST /api/chat/stream`：SSE 对话流，可传 `skill=general|math|chemistry`。
- `POST /api/tool/result`：浏览器回传工具结果。
- `POST /api/title`：用当前会话模型为会话生成简短标题。
- `GET /api/sessions`：读取当前用户的云端会话列表。
- `GET|PUT|DELETE /api/sessions/:uuid`：读取、保存或删除当前用户的会话。
- `GET /api/auth/status`、`POST /api/auth/(register|login|logout)`：账号鉴权。
- `PUT /api/auth/password`：修改当前用户密码并使旧登录失效。
- `GET /health`：服务状态。


## 从共享密码升级

旧版 `ACCESS_PASSWORD` 若仍存在，会自动作为注册邀请码使用，便于原使用者创建各自账号。完成账号创建后，建议在 `/admin` 中设置 `ALLOW_REGISTRATION=false`，或改用新的 `REGISTRATION_CODE`。

旧版 `.session-data` 快照不会公开列出；登录用户持有原会话 URL 时会将该快照导入自己的账号。浏览器里的旧本地会话索引也只会被第一个登录账号迁移一次。生产用户数据默认保存到 systemd 配置指定的 `/var/lib/eduvision-ai/data`，部署更新不会覆盖。

## 安全

- API Key 只存在于服务端环境文件中。
- JavaScript 工具在浏览器 Web Worker 中执行，无 DOM，禁用网络并设有超时。
- 用户密码使用带随机盐的 scrypt 哈希保存，服务端不保存明文密码。
- 会话同时校验登录账号与 UUID；其他账号即使拿到链接也无法读取。
- VPS 用户数据目录权限为 `eduvision:eduvision 700`，账号和会话文件均以原子方式写入。
