# Cloudflare Worker 部署

该 Worker 使用一套 Cloudflare 服务同时托管 `web/dist`、提供 `/api/duomi/*` 接口并通过 R2 binding 保存参考图。真实 Duomi Key 使用 Worker Secret，不会进入网页构建或 Git。

## 本地验证

先构建网页，再启动 Worker：

```bash
cd web
npm ci
npm run build

cd ../cloudflare-worker
npm ci
Copy-Item .dev.vars.example .dev.vars  # Windows PowerShell
npm run dev
```

macOS/Linux 使用 `cp .dev.vars.example .dev.vars`。在 `.dev.vars` 中填写真实 `DUOMI_API_KEY` 和本地使用的 `SITE_PASSWORD`，该文件已被 `.gitignore` 排除。默认本地地址为 Wrangler 输出的 `http://localhost:8787`，健康检查路径为 `/api/duomi/health`。

检查命令：

```bash
npm run typecheck
npm test
npm run build
```

测试使用 Cloudflare 官方 Miniflare 运行时和本地 R2 binding，不会请求真实 Duomi 或消耗额度。

## Cloudflare 资源

1. 创建 R2 bucket，并把 `wrangler.jsonc` 的 `bucket_name` 改为实际名称。
2. 给 bucket 配置公开自定义域名，例如 `https://media.canvas.example.com`，再更新 `STORAGE_PUBLIC_BASE_URL`。不能填写 R2 S3 API endpoint。
3. 在 R2 生命周期规则中为 `duomi-references/` 前缀设置 7 天后删除。
4. 公开资源域名不能启用 Cloudflare Access，否则 Duomi 无法读取参考图；主画布域名应启用 Access。
5. 写入服务端密钥：

```bash
cd cloudflare-worker
npx wrangler secret put DUOMI_API_KEY
npx wrangler secret put SITE_PASSWORD
```

设置 `SITE_PASSWORD` 后，Worker 会在网页和全部 `/api/duomi/*` 接口前增加口令锁。口令只保存在 Worker Secret，不会写入网页代码或 Git；验证成功后使用 HttpOnly Cookie 保持当前浏览器会话。

`DUOMI_API_BASE`、鉴权模式、模型和轮询参数是 `wrangler.jsonc` 中的非敏感变量。免费版默认轮询间隔为 15000ms，十分钟任务最多使用 41 次 Duomi 上游请求。`/v1/media` 会通过同域代理读取 Duomi 结果图片，避免部分 OSS 临时地址缺少 CORS 响应头而无法写入画布。

## GitHub 与 Workers Builds

本地验收后把仓库推送到 GitHub，再在 Cloudflare Workers & Pages 中选择 **Create application → Import a repository**，连接生产分支 `main`。

建议构建配置：

```text
Root directory: /
Build command: cd web && npm ci && npm run build && cd ../cloudflare-worker && npm ci
Deploy command: cd cloudflare-worker && npm run deploy
```

在 Cloudflare 项目设置中创建 `DUOMI_API_KEY` Secret，并确认 R2 binding 名称保持为 `REFERENCES`。部署后将主域名加入 Cloudflare Access，只允许自己的邮箱或身份提供方访问。

## infinite-canvas 配置

```text
API 格式：OpenAI
Base URL：https://canvas.example.com/api/duomi/v1
API Key：local-duomi
图片模型：gpt-image-2
```

`local-duomi` 只是前端必填占位值。参考图会逐张调用 `/v1/uploads` 上传，随后以公网 URL 数组提交图生图或视频任务，避免 Cloudflare 单请求 100MB 限制。

视频模型同时包含 `veo3.1-fast`、`veo3.1-pro`、`grok-video`、`grok-video-1.5` 和 `kling-v1-6`。可灵会复用同一 R2 binding，把公网参考图 URL 转换为 `image_list` 后调用多图参考生视频接口，不需要增加新的 Cloudflare Secret。

## 回滚

Cloudflare 会保留 Worker 部署版本。生产冒烟失败时，在 **Deployments** 中选择上一个成功版本执行 Rollback，不要在回滚时删除 R2 bucket 或 Secret。
