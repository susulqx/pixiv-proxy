/** Vercel Edge Function — Pixiv 反代（端点与 pxve-api 一致）
 *
 * 端点对齐 pxve-api：
 *   /pixiv-app-api/*  → app-api.pixiv.net   (剥离 /pixiv-app-api 前缀)
 *   /pixiv-oauth/*    → oauth.secure.pixiv.net (剥离 /pixiv-oauth 前缀)
 *   /pximg/*          → i.pximg.net（剥离 /pximg 前缀）
 *
 * 回源头对齐 pxve（PIXIV_API_HEADERS），并原样转发
 * Authorization / X-Client-Time / X-Client-Hash。
 * 响应管线对齐 pxve（prettyJSON / ETag / 304 / 安全响应头 / CORS），
 * 可作为 pxve 的直接替代品用于 Pixiv-Shaft 等客户端。
 */
export const config = { runtime: 'edge' }

// ========== 可配置项 ==========
const ENABLE_API_PROXY = true    // App API 反代（对应 pxve /pixiv-app-api）
const ENABLE_IMAGE_PROXY = false  // 图片反代（对应 pxve /pximg）
const ENABLE_OAUTH_PROXY = true  // OAuth 反代（对应 pxve /pixiv-oauth；Shaft 刷新 token 需要）

// ========== Pixiv 服务主机 ==========
const PIXIV_API_HOST = 'app-api.pixiv.net'
const PIXIV_OAUTH_HOST = 'oauth.secure.pixiv.net'
const PIXIV_IMG_HOST = 'i.pximg.net'      // 作品图：img-master / img-original / user-profile
const PIXIV_REFERER = 'https://www.pixiv.net/'

// 统一的 Pixiv App UA（去除随机 UA）
const PIXIV_APP_UA = 'PixivAndroidApp/6.168.0 (Android 15.0; Pixel 9)'

// pxve PIXIV_API_HEADERS（app-api / oauth 回源时使用）
const PIXIV_API_HEADERS = {
  'App-OS': 'Android',
  'App-OS-Version': 'Android 15.0',
  'App-Version': '6.168.0',
  'Accept-Language': 'zh-CN',
  'User-Agent': PIXIV_APP_UA,
}
// 从客户端原样转发的请求头（登录态 / 签名）
const FORWARD_HEADERS = ['Authorization', 'Content-Type', 'X-Client-Time', 'X-Client-Hash']

export default async function handler(req) {
  const url = new URL(req.url)
  let path = url.pathname

  // Vercel 将函数挂在 /api 下，剥掉可选的 /api 前缀
  if (path.startsWith('/api/')) path = path.slice(4)
  else if (path === '/api') path = '/'

  // CORS 预检：全局返回 204（对齐 pxve 的 cors()）
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() })
  }

  // ---- 图片代理：/pximg/* ----
  if (ENABLE_IMAGE_PROXY && path.startsWith('/pximg')) {
    return handleImage(url, path)
  }

  // ---- App API / OAuth ----
  let targetHost = null
  let upstreamPath = path
  if (ENABLE_OAUTH_PROXY && path.startsWith('/pixiv-oauth')) {
    targetHost = PIXIV_OAUTH_HOST
    upstreamPath = path.replace('/pixiv-oauth', '') || '/'
  } else if (ENABLE_API_PROXY && path.startsWith('/pixiv-app-api')) {
    targetHost = PIXIV_API_HOST
    upstreamPath = path.replace('/pixiv-app-api', '') || '/'
  }

  if (!targetHost) {
    return json(
      {
        error: 'Endpoint not found',
        hint: 'Use /pixiv-app-api/* for App API, /pixiv-oauth/* for OAuth, /pximg/* for images',
      },
      404
    )
  }

  const targetUrl = `https://${targetHost}${upstreamPath}${url.search}`

  // 回源头 = pxve PIXIV_API_HEADERS + 入站请求原样转发（不覆盖 Host/Referer）
  const headers = new Headers()
  for (const [k, v] of Object.entries(PIXIV_API_HEADERS)) headers.set(k, v)
  for (const k of FORWARD_HEADERS) {
    const v = req.headers.get(k)
    if (v) headers.set(k, v)
  }

  const init = { method: req.method, headers }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = req.body
    // 转发流式 body（POST 如换 token / 发评论）时 Edge/undici 要求显式声明 duplex
    init.duplex = 'half'
  }

  try {
    const upstream = await fetch(targetUrl, init)
    return await applyPxvePipeline(upstream, req)
  } catch (e) {
    return json({ error: e.message }, 502)
  }
}

// ---------- 图片代理（端点 /pximg，与 pxve 一致，单上游 i.pximg.net，无缓存） ----------
async function handleImage(url, path) {
  const imgPath = path.replace('/pximg', '') || '/'
  if (imgPath === '/') return json({ error: 'Image path required' }, 400)

  const targetUrl = `https://${PIXIV_IMG_HOST}${imgPath}${url.search}`

  const headers = new Headers()
  headers.set('Referer', PIXIV_REFERER)
  headers.set('User-Agent', PIXIV_APP_UA)

  const upstream = await fetch(targetUrl, { method: 'GET', headers })
  const resp = new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  })
  resp.headers.set('Access-Control-Allow-Origin', '*')
  return resp
}

// ---------- pxve 等价响应管线（prettyJSON / etag / 304 / 安全头 / CORS） ----------
async function applyPxvePipeline(resp, req) {
  const headers = new Headers(resp.headers)

  // CORS（对齐 pxve cors() 默认配置）
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, PUT, POST, DELETE, PATCH')
  headers.set('Access-Control-Allow-Headers', '*')

  // 安全响应头（对齐 pxve secureHeaders({crossOriginResourcePolicy:'same-site'})）
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-Frame-Options', 'DENY')
  headers.set('X-Download-Options', 'noopen')
  headers.set('Referrer-Policy', 'no-referrer')
  headers.set('X-Permitted-Cross-Domain-Policies', 'none')
  headers.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains')
  headers.set('Cross-Origin-Resource-Policy', 'same-site')

  const contentType = headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    const text = await resp.text()
    // prettyJSON：重排为 2 空格缩进（对齐 pxve prettyJSON()）
    let pretty = text
    try {
      pretty = JSON.stringify(JSON.parse(text), null, 2)
    } catch (_) {
      pretty = text
    }
    // etag()：弱 ETag，命中 If-None-Match 返回 304
    const etag = `W/"${await sha1(pretty)}"`
    headers.set('ETag', etag)
    const inm = req.headers.get('if-none-match')
    if (inm && inm === etag) {
      return new Response(null, { status: 304, headers })
    }
    // 重排后删除过期跳跳头
    headers.delete('content-encoding')
    headers.delete('content-length')
    headers.delete('transfer-encoding')
    headers.delete('connection')
    headers.set('content-type', 'application/json; charset=UTF-8')
    return new Response(pretty, { status: resp.status, statusText: resp.statusText, headers })
  }

  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers })
}

// ---------- 工具 ----------
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, PUT, POST, DELETE, PATCH',
    'Access-Control-Allow-Headers': '*',
  }
}

async function sha1(str) {
  const data = new TextEncoder().encode(str)
  const buf = await crypto.subtle.digest('SHA-1', data)
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
