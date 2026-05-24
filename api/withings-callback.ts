import type { IncomingMessage, ServerResponse } from 'http'
import { URL } from 'url'

/**
 * GET /api/withings-callback?code=xxx&state=health-tracker
 *
 * iOS PWA では Service Worker がこの URL を index.html で返すため、
 * フロントエンドが React を起動後に自らこのエンドポイントを fetch する。
 * → 常に JSON を返す（HTML/リダイレクト方式は廃止）
 *
 * レスポンス (成功): { access_token, refresh_token, userid, expires_at }
 * レスポンス (失敗): { error: string }
 *
 * 環境変数: WITHINGS_CLIENT_ID, WITHINGS_CLIENT_SECRET, WITHINGS_REDIRECT_URI
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  // CORS: 同一オリジンからの fetch を許可
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const host     = req.headers.host ?? 'localhost'
  const protocol = host.startsWith('localhost') ? 'http' : 'https'
  const fullUrl  = new URL(req.url ?? '/', `${protocol}://${host}`)
  const code     = fullUrl.searchParams.get('code')
  const error    = fullUrl.searchParams.get('error')

  if (error) {
    return json(res, 400, { error: `Withings認証エラー: ${error}` })
  }
  if (!code) {
    return json(res, 400, { error: 'codeパラメータが見つかりません' })
  }

  const clientId     = process.env.WITHINGS_CLIENT_ID
  const clientSecret = process.env.WITHINGS_CLIENT_SECRET
  const redirectUri  = process.env.WITHINGS_REDIRECT_URI

  if (!clientId || !clientSecret || !redirectUri) {
    return json(res, 500, { error: 'サーバーの環境変数が設定されていません' })
  }

  try {
    console.log('[withings-callback] Exchanging code for tokens...')

    const body = new URLSearchParams({
      action:        'requesttoken',
      grant_type:    'authorization_code',
      client_id:     clientId,
      client_secret: clientSecret,
      code,
      redirect_uri:  redirectUri,
    })

    const response = await fetch('https://wbsapi.withings.net/v2/oauth2', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
    })

    const data = await response.json() as WithingsTokenResponse
    console.log('[withings-callback] Withings status:', data.status)

    if (data.status !== 0) {
      return json(res, 400, { error: `トークン取得エラー: ${data.error ?? data.status}` })
    }

    const { access_token, refresh_token, userid, expires_in } = data.body
    const expires_at = Math.floor(Date.now() / 1000) + (expires_in ?? 10800)

    console.log('[withings-callback] Success, userid:', userid)
    return json(res, 200, { access_token, refresh_token, userid, expires_at })

  } catch (e) {
    console.error('[withings-callback] Error:', e)
    return json(res, 500, { error: `ネットワークエラー: ${String(e)}` })
  }
}

// ── ヘルパー ──────────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: object) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

// ── 型定義 ───────────────────────────────────────────────────────────────────

interface WithingsTokenResponse {
  status: number
  error?: string
  body: {
    userid:        string
    access_token:  string
    refresh_token: string
    expires_in:    number
    scope:         string
    token_type:    string
  }
}
