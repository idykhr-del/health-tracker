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

    const tokensObj = { access_token, refresh_token, userid, expires_at }
    const tokensJson = JSON.stringify(tokensObj)

    // ── iOS PWA対応: CookieとlocalStorage両方に書く ──────────────────────────
    // iOS SafariとPWA(Standalone)はlocalStorageが別々だが、Cookieは共有される。
    // Set-CookieでサーバーサイドからもCookieを書く（フォールバック）。
    const cookieValue = encodeURIComponent(tokensJson)
    const cookieHeader = `withings_pending=${cookieValue}; Path=/; SameSite=Lax; Max-Age=300`

    console.log('[withings-callback] Setting withings_pending cookie and returning success page')

    const html = buildSuccessPage(tokensJson)
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie':   cookieHeader,
    })
    res.end(html)
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

// ── HTML生成ヘルパー ──────────────────────────────────────────────────────────

function buildSuccessPage(tokensJson: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Withings連携完了</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #0f0f1a; color: #fff;
           display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .box { text-align: center; padding: 2rem; }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    p { color: #8892a4; }
    #status { font-size: 0.75rem; color: #8892a4; margin-top: 1rem; word-break: break-all; }
  </style>
</head>
<body>
  <div class="box">
    <div class="icon">✅</div>
    <h2>Withings連携が完了しました</h2>
    <p>アプリに戻ってデータを同期します...</p>
    <div id="status">処理中...</div>
  </div>
  <script>
    var tokensJson = ${JSON.stringify(tokensJson)};
    var status = document.getElementById('status');

    // ── 1. localStorage に書く（PWAコンテキストで開かれた場合に有効）──
    try {
      localStorage.setItem('withings_tokens', tokensJson);
      localStorage.setItem('withings_last_sync', '0');
      console.log('[callback] localStorage write OK');
      status.textContent = 'localStorage: 書き込み成功';
    } catch(e) {
      console.warn('[callback] localStorage write failed (expected in Safari context):', e);
      status.textContent = 'localStorage: ' + e;
    }

    // ── 2. Cookie に書く（SafariとPWAでCookieは共有される）──────────────
    try {
      var encoded = encodeURIComponent(tokensJson);
      document.cookie = 'withings_pending=' + encoded + '; Path=/; SameSite=Lax; Max-Age=300';
      console.log('[callback] cookie write OK');
      status.textContent += ' / Cookie: 書き込み成功';
    } catch(e) {
      console.warn('[callback] cookie write failed:', e);
      status.textContent += ' / Cookie: ' + e;
    }

    // ── 3. アプリへリダイレクト ─────────────────────────────────────────
    console.log('[callback] redirecting to app in 1s...');
    setTimeout(function() {
      window.location.href = '/#settings';
    }, 1000);
  </script>
</body>
</html>`
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
