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
  ├─ URL 会话持久化
  └─ 前端静态资源
          │
          ▼
MyTokk Anthropic-compatible API → claude-sonnet-4-6
```

项目不再包含 Cloudflare Worker、Wrangler、EdgeOne Functions 或 R2 部署代码。

## 功能

- Claude 原生多模态读图与连续对话，保留历史文字和图片。
- 可选 adaptive thinking 摘要。
- SSE 流式答案、工具调用卡片和原始响应调试面板。
- VPS 加固版 calculator 与浏览器 Web Worker JavaScript 沙箱。
- 每个会话生成不可猜测的 URL，可跨设备恢复并分享调试。
- Markdown、GFM、KaTeX 渲染，兼容多工具回合间相邻公式块。

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
npm run test:tools
```

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
# 可选：向 Desmos 申请的生产嵌入 key；缺省时绘图卡片降级显示表达式
DESMOS_API_KEY=...
# 可选：启用全站 API 密码鉴权（密码仅保存在服务器，不要提交到 Git）
ACCESS_PASSWORD=...
# 管理面板 /admin 的独立密码
ADMIN_ACCESS_PASSWORD=...
```

部署：

```bash
sudo /usr/local/sbin/openclaw-eduvision-root deploy
sudo /usr/local/sbin/openclaw-eduvision-root status
```

线上地址为 `https://eduvision.sunisalex.org`。

## API

- `POST /api/chat/stream`：SSE 对话流。
- `POST /api/tool/result`：浏览器回传工具结果。
- `POST /api/upload`：压缩图片转为 data URL。
- `GET|PUT /api/sessions/:uuid`：读取或保存 URL 会话。
- `GET /health`：服务状态。

## 安全

- API Key 只存在于服务端环境文件中。
- JavaScript 工具在浏览器 Web Worker 中执行，无 DOM，禁用网络并设有超时。
- 会话 UUID 相当于访问凭证；拿到会话链接的人可以读取其内容，请勿公开敏感链接。
- VPS 会话目录权限为 `eduvision:eduvision 700`，文件以原子方式写入。
