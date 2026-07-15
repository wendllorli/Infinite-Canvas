# Duomi Adapter

将 Duomi 异步生成接口转换为 infinite-canvas 可使用的 OpenAI 兼容接口。真实 Duomi API Key 只保存在服务端环境变量中，不会发送到浏览器。

## 接口

- `GET /health`
- `GET /v1/models`
- `POST /v1/images/generations`
- `POST /v1/images/edits`
- `POST /v1/uploads`
- `POST /v1/videos`
- `GET /v1/videos/{id}`

图片生成会提交 `POST /v1/images/generations?async=true`，轮询 `/v1/tasks/{id}`，并将成功结果转换为 `data[].url`。

图片编辑既兼容 infinite-canvas 原有 multipart 参考图，也支持把预上传后的公网 URL 以 JSON `image` 数组提交。`POST /v1/uploads` 每次接收一张不超过 20 MB 的常见图片并返回公网 URL。视频接口同时支持原有 multipart 和 JSON `image_urls`，并把请求转换为 Duomi VEO/GROK JSON、映射异步任务状态。

## 本地启动

```bash
cp .env.example .env
npm install
npm run dev
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

服务默认监听 `http://localhost:8787`。前端开发服务器会把 `/api/duomi/*` 转发到该端口。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | Adapter 监听端口 |
| `DUOMI_API_BASE` | `https://duomiapi.com` | Duomi 服务地址 |
| `DUOMI_API_KEY` | 无 | 真实服务端密钥，必填 |
| `DUOMI_AUTH_MODE` | `raw` | `raw` 发送 `Authorization: API_KEY`；`bearer` 发送 Bearer Token |
| `DUOMI_POLL_INTERVAL_MS` | `15000` | 图片任务轮询间隔；兼顾 Cloudflare 免费版子请求额度 |
| `DUOMI_TIMEOUT_MS` | `600000` | 图片任务总超时，默认 10 分钟 |
| `DUOMI_IMAGE_MODEL` | `gpt-image-2` | 模型列表和缺省图片模型 |
| `DUOMI_VIDEO_MODELS` | VEO/GROK 四个模型 | 逗号分隔的视频模型列表 |
| `STORAGE_ENDPOINT` | 无 | S3 API 地址；Cloudflare R2 使用账户级 endpoint |
| `STORAGE_REGION` | `auto` | S3 region；Cloudflare R2 固定使用 `auto` |
| `STORAGE_BUCKET` | 无 | 参考图存储桶 |
| `STORAGE_ACCESS_KEY` | 无 | S3/R2 Access Key ID |
| `STORAGE_SECRET_KEY` | 无 | S3/R2 Secret Access Key |
| `STORAGE_PUBLIC_BASE_URL` | 无 | Duomi 可以匿名访问的存储桶公开域名 |
| `STORAGE_FORCE_PATH_STYLE` | `false` | 仅部分 S3 兼容服务需要设为 `true` |

Cloudflare R2 示例：

```env
STORAGE_ENDPOINT=https://你的_ACCOUNT_ID.r2.cloudflarestorage.com
STORAGE_REGION=auto
STORAGE_BUCKET=infinite-canvas
STORAGE_ACCESS_KEY=你的_R2_ACCESS_KEY_ID
STORAGE_SECRET_KEY=你的_R2_SECRET_ACCESS_KEY
STORAGE_PUBLIC_BASE_URL=https://images.example.com
STORAGE_FORCE_PATH_STYLE=false
```

`STORAGE_PUBLIC_BASE_URL` 不能填写 S3 API endpoint，必须使用 R2 自定义公开域名或仅供开发的 `r2.dev` 地址。建议给 `duomi-references/` 前缀配置 7 天后自动删除的生命周期。

## infinite-canvas 配置

```text
API 格式：OpenAI
Base URL：http://localhost:3000/api/duomi/v1
API Key：local-duomi
图片模型：gpt-image-2
```

需要视频时，在同一渠道添加并勾选以下视频模型之一：

```text
veo3.1-fast
veo3.1-pro
grok-video
grok-video-1.5
```

VEO 时长固定为 8 秒，可选 720p、1080p、4K；Grok Video 和 Grok Video 1.5 可选 6、10、15 秒，固定为 720p。画布只显示横屏 16:9 和竖屏 9:16，视频任务每 60 秒查询一次，不设置主动超时，直到任务成功或失败。

VEO 最多 3 张参考图；`REFERENCE` 模式不支持 9:16。`grok-video` 最多 7 张参考图，`grok-video-1.5` 最多 1 张，Grok 单张参考图最大 10 MB。当前明确拒绝 mask 蒙版重绘。

生产环境将 Base URL 换成 `https://canvas.example.com/api/duomi/v1`。`local-duomi` 只是满足前端必填检查的占位值，不是真实 Duomi 密钥，也不能保护公开接口；公开部署应通过站点登录、VPN 或外部网关限制访问。

## 检查

```bash
npm run typecheck
npm test
npm run build
```

测试使用本地 Duomi 与 S3 Mock Server，不会请求真实服务或消耗额度。

Cloudflare 单 Worker 部署使用 R2 binding，不需要在云端配置 S3 Access Key。详见 [Cloudflare Worker 部署](../cloudflare-worker/README.md)。
