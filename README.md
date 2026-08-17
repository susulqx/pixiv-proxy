# Pixiv Proxy（Vercel 版，端点与 pxve-api 一致）

Pixiv **App API / 图片 / OAuth** 反向代理，部署到 Vercel（Edge Function）。
端点与 [pxve-api](https://github.com) 完全一致，可作为其直接替代品（例如用于 Pixiv-Shaft）。

> 已移除 Cloudflare Workers 版本，仅保留 Vercel。

## 端点对照（与 pxve-api 一致）

| 路径 | 转发目标 | 说明 |
|---|---|---|
| `/pixiv-app-api/*` | `app-api.pixiv.net` | 剥离 `/pixiv-app-api` 前缀 |
| `/pixiv-oauth/*` | `oauth.secure.pixiv.net` | 剥离 `/pixiv-oauth` 前缀 |
| `/pximg/*` | `i.pximg.net` | 剥离 `/pximg` 前缀 |

示例：

```
# App API
GET  /pixiv-app-api/v1/illust/recommended?filter=for_android
  → https://app-api.pixiv.net/v1/illust/recommended?filter=for_android

# OAuth 刷新 token（Shaft 自动调用）
POST /pixiv-oauth/auth/token
  → https://oauth.secure.pixiv.net/auth/token

# 作品图
GET  /pximg/c/540x540_70/img-master/img/2025/12/18/00/00/34/138723545_p0_master1200.jpg
  → https://i.pximg.net/c/540x540_70/img-master/img/2025/12/18/00/00/34/138723545_p0_master1200.jpg
```

## 与 pxve-api 一致的响应处理

- 回源头使用 pxve 的 `PIXIV_API_HEADERS`，并原样转发 `Authorization` / `X-Client-Time` / `X-Client-Hash`（登录态 / 签名）。
- 响应管线对齐 pxve：prettyJSON（2 空格缩进）、弱 ETag + `If-None-Match` → 304、安全响应头、CORS 预检 204。
- 图片代理单上游转发到 `i.pximg.net`，带 `Referer: https://www.pixiv.net/`，不缓存。

## 部署

1. Fork 本仓库（或直接克隆）。
2. 在 [Vercel](https://vercel.com) 导入仓库并部署。
3. 默认域名 `https://<project>.vercel.app` 即可使用；如需自定义域名在 Vercel 项目设置中绑定。

## 在 Pixiv-Shaft 中使用

Shaft 的「App API 代理（PxveAPI）」设置里填入你的 Vercel 域名即可，其内部会把
`app-api.pixiv.net/v1/*` → `{域名}/pixiv-app-api/v1/*`、
`oauth.secure.pixiv.net/auth/*` → `{域名}/pixiv-oauth/auth/*`，
与本项目端点完全匹配。

## 配置项（`api/index.js` 顶部）

```
const ENABLE_API_PROXY = true    // App API 反代
const ENABLE_IMAGE_PROXY = true  // 图片反代
const ENABLE_OAUTH_PROXY = true  // OAuth 反代（Shaft 刷新 token 需要）
```
