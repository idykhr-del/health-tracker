import type { IncomingMessage, ServerResponse } from 'http'
import { URL } from 'url'

/**
 * GET /api/withings-callback?code=xxx&state=health-tracker
 *
 * authorization_code を access_token + refresh_token に交換し、
 * localStorage に保存してアプリへリダイレクトするHTMLを返す。
 *
 * 環境変数:
 *   WITHINGS_CLIENT_ID
 *   WITHINGS_CLIENT_SECRET
 *   WITHINGS_REDIRECT_URI
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const host = req.headers.host ?? 'localhost'
  const protocol = host.startsWith('localhost') ? 'http' : 'https'
  const fullUrl = new URL(req.url ?? '/', `${protocol}://${host}`)
  const code  = fullUrl.searchParams.get('code')
  const error = fullUrl.searchParams.get('error')

  if (error) {
    return sendErrorPage(res, `Withings認証エラー: ${error}`)
  }
  if (!code) {
    return sendErrorPage(res, 'codeパラメータが見つかりません。')
  }

  const clientId     = process.env.WITHINGS_CLIENT_ID
  const clientSecret = process.env.WITHINGS_CLIENT_SECRET
  const redirectUri  = process.env.WITHINGS_REDIRECT_URI

  if (!clientId || !clientSecret || !redirectUri) {
    return sendErrorPage(res, 'サーバーの環境変数が設定されていません。')
  }

  try {
    const body = new URLSearchParams({
      action:        'requesttoken',
      grant_type:    'authorization_code',
      client_id:     clientId,
      client_secret: clientSecret,
      code,
      redirect_uri:  redirectUri,
    })

    console.log('[withings-callback] Exchanging code for tokens...')

    const response = await fetch('https://wbsapi.withings.net/v2/oauth2', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
    })

    const json = await response.json() as WithingsTokenResponse
    console.log('[withings-callback] Token response status:', json.status)

    if (json.status !== 0) {
      return sendErrorPage(res, `トークン取得エラー: ${json.error ?? json.status}`)
    }

    const { access_token, refresh_token, userid, expires_in } = json.body
    const expires_at = Math.floor(Date.now() / 1000) + (expires_in ?? 10800)

    // ── iOS PWA対応: URLハッシュパラメータ方式 ───────────────────────────────
    // iOS SafariとPWA(Standalone)はlocalStorage/Cookieが分離されるケースがある。
    // リダイレクト先URLのハッシュにトークンを埋め込み、フロント側で読み取る方式が最も確実。
    const params = new URLSearchParams({
      withings_token:   access_token,
      withings_refresh: refresh_token,
      withings_userid:  userid,
      withings_expires: String(expires_at),
    })

    const appBase = `${protocol}://${host}`
    const redirectUrl = `${appBase}/#/settings?${params.toString()}`

    console.log('[withings-callback] Redirecting to app with token params:', appBase + '/#/settings?...')

    res.writeHead(302, { Location: redirectUrl })
    res.end()
  } catch (e) {
    console.error('[withings-callback] Error:', e)
    return sendErrorPage(res, `ネットワークエラー: ${String(e)}`)
  }
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

function sendErrorPage(res: ServerResponse, message: string) {
  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>エラー</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #0f0f1a; color: #fff;
           display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .box { text-align: center; padding: 2rem; }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    p { color: #8892a4; }
    a { color: #00d4ff; }
  </style>
</head>
<body>
  <div class="box">
    <div class="icon">❌</div>
    <h2>エラーが発生しました</h2>
    <p>${message}</p>
    <p><a href="/">アプリに戻る</a></p>
  </div>
</body>
</html>`
  res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
}
