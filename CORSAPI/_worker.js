// 统一入口：兼容 Cloudflare Workers 和 Pages Functions
export default {
  async fetch(request, env, ctx) {
    // 同时兼容文档中的 CONFIG_KV 与旧版 KV 绑定名称
    const kvBinding = env?.CONFIG_KV || env?.KV
    if (kvBinding && typeof globalThis.KV === 'undefined') {
      globalThis.KV = kvBinding
    }

    return handleRequest(request, env || {}, ctx)
  }
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Content-Type, Range, X-Requested-With',
  'Access-Control-Max-Age': '86400',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Alt-Svc': 'h3=":443"; ma=86400',
}

const EXCLUDE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding',
  'connection', 'keep-alive', 'set-cookie', 'set-cookie2'
])

const FORWARDED_REQUEST_HEADERS = new Set([
  'accept', 'accept-language', 'content-type', 'if-modified-since',
  'if-none-match', 'range', 'user-agent',
  'referer', 'origin', 'x-requested-with'
])

const WORKER_QUERY_KEYS = new Set([
  'url', 'format', 'source', 'prefix', 'nocache'
])

const CONFIG_CACHE_TTL_SECONDS = 1800
const M3U8_CACHE_TTL_SECONDS = 300
const CONFIG_FETCH_TIMEOUT_MS = 8000
const API_FETCH_TIMEOUT_MS = 9000
const M3U8_FETCH_TIMEOUT_MS = 15000
const SEGMENT_FETCH_TIMEOUT_MS = 30000
const ALLOWED_HOSTS_CACHE_MS = 5 * 60 * 1000
const MAX_REDIRECTS = 3
const MAX_M3U8_BYTES = 2 * 1024 * 1024
let allowedHostsCache = { expiresAt: 0, hosts: null }

const JSON_SOURCES = {
  'jin18': 'https://raw.githubusercontent.com/Berserker8888/LunaTV-config/refs/heads/main/jin18.json',
  'jingjian': 'https://raw.githubusercontent.com/Berserker8888/LunaTV-config/refs/heads/main/jingjian.json',
  'full': 'https://raw.githubusercontent.com/Berserker8888/LunaTV-config/refs/heads/main/LunaTV-config.json'
}

const FORMAT_CONFIG = {
  '0': { proxy: false, base58: false },
  'raw': { proxy: false, base58: false },
  '1': { proxy: true, base58: false },
  'proxy': { proxy: true, base58: false },
  '2': { proxy: false, base58: true },
  'base58': { proxy: false, base58: true },
  '3': { proxy: true, base58: true },
  'proxy-base58': { proxy: true, base58: true }
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58Encode(obj) {
  const str = JSON.stringify(obj)
  const bytes = new TextEncoder().encode(str)

  let intVal = 0n
  for (let b of bytes) {
    intVal = (intVal << 8n) + BigInt(b)
  }

  let result = ''
  while (intVal > 0n) {
    const mod = intVal % 58n
    result = BASE58_ALPHABET[Number(mod)] + result
    intVal = intVal / 58n
  }

  for (let b of bytes) {
    if (b === 0) result = BASE58_ALPHABET[0] + result
    else break
  }

  return result
}

function extractSourceId(apiUrl) {
  try {
    const hostname = new URL(apiUrl).hostname
    const parts = hostname.split('.')
    if (
      parts.length >= 3 &&
      (parts[0] === 'caiji' || parts[0] === 'api' || parts[0] === 'cj' || parts[0] === 'www')
    ) {
      return parts[parts.length - 2].toLowerCase().replace(/[^a-z0-9]/g, '') || 'source'
    }
    let name = parts[0].toLowerCase()
    name = name.replace(/zyapi$/, '').replace(/zy$/, '').replace(/api$/, '')
    return name.replace(/[^a-z0-9]/g, '') || 'source'
  } catch {
    return 'source'
  }
}

function stripExistingProxyPrefix(apiUrl) {
  const urlIndex = apiUrl.indexOf('?url=')
  if (urlIndex === -1) return apiUrl
  return apiUrl.slice(urlIndex + 5)
}

function addOrReplacePrefix(obj, newPrefix, useSourcePath = false) {
  if (typeof obj !== 'object' || obj === null) return obj
  if (Array.isArray(obj)) return obj.map(item => addOrReplacePrefix(item, newPrefix, useSourcePath))
  const newObj = {}
  for (const key in obj) {
    if (key === 'api' && typeof obj[key] === 'string') {
      let apiUrl = stripExistingProxyPrefix(obj[key])
      if (apiUrl.startsWith(newPrefix)) {
        newObj[key] = apiUrl
      } else if (useSourcePath) {
        const sourceId = extractSourceId(apiUrl)
        const origin = newPrefix.replace(/\/?\?url=$/, '')
        newObj[key] = `${origin}/p/${sourceId}?url=${apiUrl}`
      } else {
        newObj[key] = newPrefix + apiUrl
      }
    } else {
      newObj[key] = addOrReplacePrefix(obj[key], newPrefix, useSourcePath)
    }
  }
  return newObj
}

function getKv(env) {
  const kv = env?.CONFIG_KV || env?.KV || (typeof KV !== 'undefined' ? KV : null)
  return kv && typeof kv.get === 'function' ? kv : null
}

async function fetchJson(url) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), CONFIG_FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`Fetch failed: ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timeoutId)
  }
}

async function getCachedJSON(url, env) {
  const kv = getKv(env)
  if (kv) {
    const cacheKey = 'CACHE_' + url
    const cached = await kv.get(cacheKey)
    if (cached) {
      try {
        return JSON.parse(cached)
      } catch (e) {
        await kv.delete(cacheKey)
      }
    }
    const data = await fetchJson(url)
    await kv.put(cacheKey, JSON.stringify(data), { expirationTtl: CONFIG_CACHE_TTL_SECONDS })
    return data
  }
  return fetchJson(url)
}

async function getCachedM3u8(cacheKey, env) {
  const kv = getKv(env)
  if (!kv) return null
  try {
    return await kv.get(cacheKey)
  } catch {
    return null
  }
}

async function setCachedM3u8(cacheKey, text, env) {
  const kv = getKv(env)
  if (!kv || typeof kv.put !== 'function') return
  try {
    await kv.put(cacheKey, text, { expirationTtl: M3U8_CACHE_TTL_SECONDS })
  } catch {
    // 写缓存失败不影响播放
  }
}

function waitUntil(ctx, promise) {
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(promise)
    return
  }
  promise.catch(() => {})
}

async function logError(type, info) {
  console.error('[ERROR]', type, info)
}

function corsHeaders(extra = {}) {
  return { ...CORS_HEADERS, ...extra }
}

async function handleRequest(request, env, ctx) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (!['GET', 'HEAD'].includes(request.method)) {
    return errorResponse('Method not allowed', { allowed: ['GET', 'HEAD', 'OPTIONS'] }, 405)
  }

  const reqUrl = new URL(request.url)
  const pathname = reqUrl.pathname.replace(/\/+$/, '') || '/'
  const targetUrlParam = reqUrl.searchParams.get('url')
  const formatParam = reqUrl.searchParams.get('format')
  const prefixParam = reqUrl.searchParams.get('prefix')
  const sourceParam = reqUrl.searchParams.get('source')
  const currentOrigin = reqUrl.origin
  const defaultPrefix = currentOrigin + '/?url='

  if (pathname === '/health') {
    return new Response('OK', { status: 200, headers: CORS_HEADERS })
  }

  const isSourcePath = pathname.startsWith('/p/')
  const isM3u8Path = pathname === '/m3u8'
  const isSegPath = pathname === '/seg'

  if ((isSourcePath || isM3u8Path || isSegPath) && !targetUrlParam) {
    return errorResponse('Missing url parameter', {}, 400)
  }

  if (targetUrlParam) {
    if (isM3u8Path) {
      return handleM3u8Request(request, currentOrigin, env, ctx)
    }
    return handleProxyRequest(request, currentOrigin, env, {
      mode: isSegPath ? 'media' : 'allowlist',
      timeoutMs: isSegPath ? SEGMENT_FETCH_TIMEOUT_MS : API_FETCH_TIMEOUT_MS,
    })
  }

  if (formatParam !== null) {
    return handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix, env)
  }

  return handleHomePage(currentOrigin, defaultPrefix)
}

function parseTargetURL(request) {
  const reqUrl = new URL(request.url)
  const raw = reqUrl.searchParams.get('url')
  if (!raw) throw new Error('Missing url')
  const targetURL = new URL(raw)
  for (const [key, value] of reqUrl.searchParams) {
    if (WORKER_QUERY_KEYS.has(key)) continue
    targetURL.searchParams.append(key, value)
  }
  return targetURL
}

async function handleProxyRequest(request, currentOrigin, env, options) {
  let targetURL
  try {
    targetURL = parseTargetURL(request)
  } catch {
    await logError('proxy', { message: 'Invalid URL' })
    return errorResponse('Invalid URL', {}, 400)
  }

  if (targetURL.origin === currentOrigin) {
    return errorResponse('Loop detected: self-fetch blocked', {}, 400)
  }

  let validationError
  try {
    validationError = await validateProxyTarget(targetURL, env, currentOrigin, options.mode)
  } catch (error) {
    await logError('allowlist', { message: error.message })
    return errorResponse('Unable to load proxy allowlist', {}, 503)
  }
  if (validationError) {
    return errorResponse('Target URL is not allowed', { reason: validationError }, 403)
  }

  try {
    const requestHeaders = pickForwardHeaders(request.headers)
    applyDefaultHeadersForUpstream(requestHeaders, targetURL)
    const proxyRequest = new Request(targetURL.toString(), {
      method: request.method,
      headers: requestHeaders,
    })

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs)
    let response
    try {
      response = await fetchWithSafeRedirects(
        proxyRequest,
        env,
        controller.signal,
        currentOrigin,
        options.mode
      )
    } finally {
      clearTimeout(timeoutId)
    }

    const responseHeaders = new Headers(CORS_HEADERS)
    for (const [key, value] of response.headers) {
      if (!EXCLUDE_HEADERS.has(key.toLowerCase())) {
        responseHeaders.set(key, value)
      }
    }

    const path = targetURL.pathname.toLowerCase()
    if (options.mode === 'media' && response.status === 200 && (path.endsWith('.ts') || path.endsWith('.m4s'))) {
      responseHeaders.set('Cache-Control', 'public, max-age=3600')
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    })
  } catch (err) {
    const safeTarget = redactUrl(targetURL.toString())
    await logError('proxy', { message: err.message || '代理请求失败', url: safeTarget })
    return errorResponse('Proxy Error', {
      message: err.message || '代理请求失败',
      target: safeTarget,
      timestamp: new Date().toISOString()
    }, 502)
  }
}

function rewriteM3u8Playlist(text, playlistURL, currentOrigin) {
  const wrapBase = (rawUrl) => {
    const lower = (rawUrl || '').toLowerCase()
    if (lower.endsWith('.m3u8') || lower.endsWith('.m3u')) return `${currentOrigin}/m3u8?url=`
    return `${currentOrigin}/seg?url=`
  }

  const wrapAbsolute = (raw) => {
    let abs = raw
    try {
      abs = new URL(raw, playlistURL).toString()
    } catch {
      return raw
    }
    return wrapBase(abs) + encodeURIComponent(abs)
  }

  const wrapSegment = (rawLine) => {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) return line
    return wrapAbsolute(line)
  }

  const isMaster = /#EXT-X-STREAM-INF/i.test(text)
  const lines = text.split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (
      /^#EXT-X-KEY/i.test(line) ||
      /^#EXT-X-MAP/i.test(line) ||
      /^#EXT-X-MEDIA/i.test(line) ||
      /^#EXT-X-I-FRAME-STREAM-INF/i.test(line) ||
      /^#EXT-X-SESSION-KEY/i.test(line) ||
      /^#EXT-X-PART/i.test(line) ||
      /^#EXT-X-PRELOAD-HINT/i.test(line)
    ) {
      out.push(line.replace(/URI="([^"]+)"/gi, (_m, u) => `URI="${wrapAbsolute(u)}"`))
      continue
    }
    if (isMaster && /^#EXT-X-STREAM-INF/i.test(line)) {
      out.push(line)
      if (i + 1 < lines.length) {
        out.push(wrapSegment(lines[i + 1]))
        i++
      }
      continue
    }
    out.push(wrapSegment(line))
  }
  return out.join('\n')
}

async function readTextWithLimit(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text()
    const bytes = new TextEncoder().encode(text)
    if (bytes.length > maxBytes) throw new Error('m3u8 too large')
    return text
  }

  const reader = response.body.getReader()
  const chunks = []
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > maxBytes) {
      try { await reader.cancel() } catch { /* ignore */ }
      throw new Error('m3u8 too large')
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

async function handleM3u8Request(request, currentOrigin, env, ctx) {
  let targetURL
  try {
    targetURL = parseTargetURL(request)
  } catch {
    return errorResponse('Invalid URL', {}, 400)
  }

  if (targetURL.origin === currentOrigin) {
    return errorResponse('Loop detected: self-fetch blocked', {}, 400)
  }

  let validationError
  try {
    validationError = await validateProxyTarget(targetURL, env, currentOrigin, 'media')
  } catch (error) {
    await logError('allowlist', { message: error.message })
    return errorResponse('Unable to load proxy allowlist', {}, 503)
  }
  if (validationError) {
    return errorResponse('Target URL is not allowed', { reason: validationError }, 403)
  }

  const reqUrl = new URL(request.url)
  const nocache = reqUrl.searchParams.get('nocache') === '1'
  const cacheKey = `M3U8_${currentOrigin}_${targetURL.toString()}`
  if (!nocache) {
    const cached = await getCachedM3u8(cacheKey, env)
    if (cached !== null) {
      return new Response(cached, {
        status: 200,
        headers: corsHeaders({
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'public, max-age=60',
          'X-Cache': 'HIT',
        }),
      })
    }
  }

  try {
    const requestHeaders = pickForwardHeaders(request.headers)
    applyDefaultHeadersForUpstream(requestHeaders, targetURL)
    requestHeaders.set('Accept', '*/*')

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), M3U8_FETCH_TIMEOUT_MS)
    let response
    try {
      response = await fetchWithSafeRedirects(
        new Request(targetURL.toString(), { method: 'GET', headers: requestHeaders }),
        env,
        controller.signal,
        currentOrigin,
        'media'
      )
    } finally {
      clearTimeout(timeoutId)
    }

    const text = await readTextWithLimit(response, MAX_M3U8_BYTES)
    const trimmed = text.trimStart()
    if (!trimmed.startsWith('#EXTM3U')) {
      return errorResponse('Upstream response is not an HLS manifest', {}, 415)
    }

    const rewritten = rewriteM3u8Playlist(text, targetURL, currentOrigin)
    if (!nocache) {
      waitUntil(ctx, setCachedM3u8(cacheKey, rewritten, env))
    }

    return new Response(rewritten, {
      status: 200,
      headers: corsHeaders({
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-store',
        'X-Cache': nocache ? 'BYPASS' : 'MISS',
      }),
    })
  } catch (err) {
    const safeTarget = redactUrl(targetURL.toString())
    await logError('m3u8', { message: err.message, url: safeTarget })
    return errorResponse('M3U8 Proxy Error', {
      message: err.message || '代理请求失败',
      target: safeTarget,
    }, 502)
  }
}

function pickForwardHeaders(headers) {
  const safeHeaders = new Headers()
  for (const [key, value] of headers) {
    if (FORWARDED_REQUEST_HEADERS.has(key.toLowerCase())) safeHeaders.set(key, value)
  }
  return safeHeaders
}

function applyDefaultHeadersForUpstream(headers, targetURL) {
  const host = targetURL.hostname.toLowerCase()
  if (host === 'lain.bgm.tv' || host === 'api.bgm.tv' || host === 'bgm.tv' || host.endsWith('.bgm.tv')) {
    if (!headers.has('User-Agent')) {
      headers.set('User-Agent', 'LunaTV/1.0 (https://github.com/Berserker8888/LunaTV)')
    }
    if (!headers.has('Referer')) {
      headers.set('Referer', 'https://bgm.tv/')
    }
  }
  if (!headers.has('User-Agent')) {
    headers.set(
      'User-Agent',
      'Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'
    )
  }
  if (!headers.has('Referer')) {
    headers.set('Referer', targetURL.origin + '/')
  }
  if (!headers.has('Accept')) {
    headers.set('Accept', '*/*')
  }
}

function redactUrl(value) {
  try {
    const url = new URL(value)
    for (const key of url.searchParams.keys()) {
      if (/token|key|auth|sign|password|secret/i.test(key)) url.searchParams.set(key, '[REDACTED]')
    }
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return '[invalid URL]'
  }
}

function isPrivateHostname(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true
  }

  if (host.includes(':')) {
    return host === '::' || host === '::1' || host.startsWith('::ffff:') ||
      host.startsWith('fc') || host.startsWith('fd') || /^fe[89ab]/.test(host)
  }

  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false

  const [a, b] = parts
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
}

function unwrapProxyUrl(value) {
  let current = value
  for (let depth = 0; depth < 3; depth++) {
    const parsed = new URL(current)
    const nested = parsed.searchParams.get('url')
    if (!nested) return parsed
    current = nested
  }
  return new URL(current)
}

async function getConfiguredSourceHosts(env) {
  const now = Date.now()
  if (allowedHostsCache.hosts && allowedHostsCache.expiresAt > now) return allowedHostsCache.hosts

  const config = await getCachedJSON(JSON_SOURCES.full, env)
  const hosts = new Set()
  for (const source of Object.values(config.api_site || {})) {
    try {
      hosts.add(unwrapProxyUrl(source.api).hostname.toLowerCase())
    } catch {
      // 无效来源会由仓库的 verify.js 报告，这里直接忽略。
    }
  }
  allowedHostsCache = { hosts, expiresAt: now + ALLOWED_HOSTS_CACHE_MS }
  return hosts
}

function hostMatchesRule(hostname, rule) {
  const normalizedRule = rule.trim().toLowerCase()
  if (!normalizedRule) return false
  if (normalizedRule.startsWith('*.')) {
    const suffix = normalizedRule.slice(1)
    return hostname.endsWith(suffix) && hostname.length > suffix.length
  }
  return hostname === normalizedRule
}

async function validateProxyTarget(targetURL, env, blockedOrigin = null, mode = 'allowlist') {
  if (!['http:', 'https:'].includes(targetURL.protocol)) return '仅支持 HTTP(S)'
  if (blockedOrigin && targetURL.origin === blockedOrigin) return '禁止代理服务递归调用自身'
  if (targetURL.username || targetURL.password) return 'URL 不得包含账号或密码'
  if (targetURL.port && !['80', '443'].includes(targetURL.port)) return '仅允许 80 与 443 端口'
  if (isPrivateHostname(targetURL.hostname)) return '禁止访问本机或私有网络'

  if (mode === 'media') return null

  const hostname = targetURL.hostname.toLowerCase()
  const extraRules = String(env.PROXY_ALLOWED_HOSTS || '')
    .split(',')
    .map(rule => rule.trim())
    .filter(Boolean)

  if (extraRules.includes('*')) return null
  if (extraRules.some(rule => hostMatchesRule(hostname, rule))) return null

  const configuredHosts = await getConfiguredSourceHosts(env)
  if (configuredHosts.has(hostname)) return null
  return '目标主机不在配置来源或 PROXY_ALLOWED_HOSTS 白名单中'
}

async function fetchWithSafeRedirects(request, env, signal, blockedOrigin, mode = 'allowlist', redirectCount = 0) {
  const response = await fetch(request, { signal, redirect: 'manual' })
  const location = response.headers.get('location')
  if (![301, 302, 303, 307, 308].includes(response.status) || !location) return response

  if (redirectCount >= MAX_REDIRECTS) throw new Error('Too many redirects')
  const redirectURL = new URL(location, request.url)
  const validationError = await validateProxyTarget(redirectURL, env, blockedOrigin, mode)
  if (validationError) throw new Error(`Unsafe redirect blocked: ${validationError}`)

  const method = response.status === 303 ? 'GET' : request.method
  const redirectedRequest = new Request(redirectURL.toString(), {
    method,
    headers: request.headers,
  })
  return fetchWithSafeRedirects(redirectedRequest, env, signal, blockedOrigin, mode, redirectCount + 1)
}

async function handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix, env) {
  try {
    const config = FORMAT_CONFIG[formatParam]
    if (!config) {
      return errorResponse('Invalid format parameter', { format: formatParam }, 400)
    }

    if (sourceParam && !Object.hasOwn(JSON_SOURCES, sourceParam)) {
      return errorResponse('Invalid source parameter', { source: sourceParam }, 400)
    }

    if (prefixParam && !/^https?:\/\//i.test(prefixParam)) {
      return errorResponse('Invalid prefix parameter', { prefix: prefixParam }, 400)
    }

    const selectedSource = JSON_SOURCES[sourceParam || 'full']
    const data = await getCachedJSON(selectedSource, env)
    const useSourcePath = config.proxy && !prefixParam
    const newData = config.proxy
      ? addOrReplacePrefix(data, prefixParam || defaultPrefix, useSourcePath)
      : data

    if (config.base58) {
      const encoded = base58Encode(newData)
      return new Response(encoded, {
        headers: corsHeaders({ 'Content-Type': 'text/plain;charset=UTF-8' }),
      })
    }
    return new Response(JSON.stringify(newData), {
      headers: corsHeaders({ 'Content-Type': 'application/json;charset=UTF-8' }),
    })
  } catch (err) {
    await logError('json', { message: err.message })
    return errorResponse(err.message, {}, 500)
  }
}

async function handleHomePage(currentOrigin, defaultPrefix) {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>API 中转代理服务</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; line-height: 1.6; }
    h1 { color: #333; }
    h2 { color: #555; margin-top: 30px; }
    code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 14px; }
    pre { background: #f4f4f4; padding: 15px; border-radius: 5px; overflow-x: auto; }
    .example { background: #e8f5e9; padding: 15px; border-left: 4px solid #4caf50; margin: 20px 0; }
    .section { background: #f9f9f9; padding: 15px; border-radius: 5px; margin: 15px 0; }
    table { width: 100%; border-collapse: collapse; margin: 15px 0; }
    table td { padding: 8px; border: 1px solid #ddd; }
    table td:first-child { background: #f5f5f5; font-weight: bold; width: 30%; }
  </style>
</head>
<body>
  <h1>🔄 API 中转代理服务</h1>
  <p>配置来源 API 中转代理，默认仅允许已登记或明确加入白名单的公网接口。播放流请走独立的 <code>/m3u8</code> 端点。</p>
  
  <h2>使用方法</h2>
  <p>中转已允许的 API：在请求 URL 后添加 <code>?url=目标地址</code> 参数</p>
  <pre>${defaultPrefix}<示例API地址></pre>

  <h2>播放流加速（m3u8）</h2>
  <div class="section">
    <p>直连失败或源站限速时，把播放地址交给 Worker 重写分片链接：</p>
    <pre>${currentOrigin}/m3u8?url=<编码后的m3u8地址></pre>
    <p>返回的清单会把 <code>.ts</code> / 密钥 / MAP 改写到 <code>/seg?url=</code>，嵌套播放列表改写到 <code>/m3u8?url=</code>。绑定 KV 后，改写结果缓存 5 分钟。</p>
    <p>调试跳过缓存：<code>&nocache=1</code>。响应头 <code>X-Cache: HIT / MISS / BYPASS</code>。</p>
  </div>
  
  <h2>配置订阅参数说明</h2>
  <div class="section">
    <table>
      <tr>
        <td>format</td>
        <td><code>0</code> 或 <code>raw</code> = 原始 JSON<br>
            <code>1</code> 或 <code>proxy</code> = 添加代理前缀（默认 <code>/p/源名?url=</code>）<br>
            <code>2</code> 或 <code>base58</code> = 原始 Base58 编码<br>
            <code>3</code> 或 <code>proxy-base58</code> = 代理 Base58 编码</td>
      </tr>
      <tr>
        <td>source</td>
        <td><code>jin18</code> = 精简版<br>
            <code>jingjian</code> = 精简版+成人<br>
            <code>full</code> = 完整版（默认）</td>
      </tr>
      <tr>
        <td>prefix</td>
        <td>自定义代理前缀（仅在 format=1 或 3 时生效）</td>
      </tr>
    </table>
  </div>
  
  <h2>配置订阅链接示例</h2>
    
  <div class="section">
    <h3>📦 精简版（jin18）</h3>
    <p>原始 JSON：<br><code class="copyable">${currentOrigin}?format=0&source=jin18</code> <button class="copy-btn">复制</button></p>
    <p>中转代理 JSON：<br><code class="copyable">${currentOrigin}?format=1&source=jin18</code> <button class="copy-btn">复制</button></p>
    <p>原始 Base58：<br><code class="copyable">${currentOrigin}?format=2&source=jin18</code> <button class="copy-btn">复制</button></p>
    <p>中转 Base58：<br><code class="copyable">${currentOrigin}?format=3&source=jin18</code> <button class="copy-btn">复制</button></p>
  </div>
  
  <div class="section">
    <h3>📦 精简版+成人（jingjian）</h3>
    <p>原始 JSON：<br><code class="copyable">${currentOrigin}?format=0&source=jingjian</code> <button class="copy-btn">复制</button></p>
    <p>中转代理 JSON：<br><code class="copyable">${currentOrigin}?format=1&source=jingjian</code> <button class="copy-btn">复制</button></p>
    <p>原始 Base58：<br><code class="copyable">${currentOrigin}?format=2&source=jingjian</code> <button class="copy-btn">复制</button></p>
    <p>中转 Base58：<br><code class="copyable">${currentOrigin}?format=3&source=jingjian</code> <button class="copy-btn">复制</button></p>
  </div>
  
  <div class="section">
    <h3>📦 完整版（full，默认）</h3>
    <p>原始 JSON：<br><code class="copyable">${currentOrigin}?format=0&source=full</code> <button class="copy-btn">复制</button></p>
    <p>中转代理 JSON：<br><code class="copyable">${currentOrigin}?format=1&source=full</code> <button class="copy-btn">复制</button></p>
    <p>原始 Base58：<br><code class="copyable">${currentOrigin}?format=2&source=full</code> <button class="copy-btn">复制</button></p>
    <p>中转 Base58：<br><code class="copyable">${currentOrigin}?format=3&source=full</code> <button class="copy-btn">复制</button></p>
  </div>
  
  <h2>支持的功能</h2>
  <ul>
    <li>✅ 默认仅支持 GET、HEAD 与 OPTIONS</li>
    <li>✅ 仅转发必要且安全的请求头</li>
    <li>✅ 默认仅代理配置内的来源，可用 PROXY_ALLOWED_HOSTS 扩充</li>
    <li>✅ CMS 代理与播放流分离：<code>/?url=</code> 走白名单，<code>/m3u8</code> / <code>/seg</code> 仅开放公网 HLS</li>
    <li>✅ 阻挡本机、私有网络与不安全跳转</li>
    <li>✅ 源专属路径 <code>/p/{sourceId}</code>，降低缓存互相污染</li>
    <li>✅ 改写后的 m3u8 可写入 KV（5 分钟）</li>
    <li>✅ 响应头提示 HTTP/3（Alt-Svc）</li>
    <li>✅ 保留原始响应头（除敏感信息）</li>
    <li>✅ 完整的 CORS 支持</li>
    <li>✅ API 超时 9 秒；m3u8 15 秒；分片 30 秒</li>
    <li>✅ 支持多种配置源切换</li>
    <li>✅ 支持 Base58 编码输出</li>
  </ul>
  
  <script>
    document.querySelectorAll('.copy-btn').forEach((btn, idx) => {
      btn.addEventListener('click', () => {
        const text = document.querySelectorAll('.copyable')[idx].innerText;
        navigator.clipboard.writeText(text).then(() => {
          btn.innerText = '已复制！';
          setTimeout(() => (btn.innerText = '复制'), 1500);
        });
      });
    });
  </script>
</body>
</html>`

  return new Response(html, {
    status: 200,
    headers: corsHeaders({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
    })
  })
}

function errorResponse(error, data = {}, status = 400) {
  return new Response(JSON.stringify({ error, ...data }), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
  })
}
