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

    const params = new URLSearchParams({
      withings_token:   access_token,
      withings_refresh: refresh_token,
      withings_userid:  userid,
      withings_expires: String(expires_at),
    })

    const appBase = `${protocol}://${host}`
    const redirectUrl = `${appBase}/#/settings?${params.toString()}`

    console.log('[withings-callback] host:', host)
    console.log('[withings-callback] redirectUrl:', redirectUrl)

    // ── デバッグ用中間ページ ────────────────────────────────────────────────
    // 302 直接リダイレクトではなく、画面に情報を表示してからアプリへ誘導する。
    // iPhoneの画面上でリダイレクト先URLと動作状況を確認するため。
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(buildDebugPage(redirectUrl, userid))
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

// ── デバッグ用中間ページ ──────────────────────────────────────────────────────
// 認証後にSafariで開かれるこのページで、リダイレクト先URLを画面表示する。
// 「アプリに戻る」ボタンでリダイレクトURLへ遷移し、トークン解析を試みる。
function buildDebugPage(redirectUrl: string, userid: string): string {
  const safeUrl = redirectUrl.replace(/withings_token=[^&]+/, 'withings_token=***')
                             .replace(/withings_refresh=[^&]+/, 'withings_refresh=***')
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Withings連携 - デバッグ</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,sans-serif;background:#0f0f1a;color:#fff;padding:1.5rem;min-height:100vh}
    h2{color:#00d4ff;margin-bottom:1rem}
    .card{background:#16213e;border-radius:12px;padding:1rem;margin-bottom:1rem;font-size:0.75rem}
    .label{color:#8892a4;margin-bottom:0.25rem}
    .val{color:#e2e8f0;word-break:break-all;font-family:monospace}
    .btn{display:block;width:100%;padding:0.875rem;border-radius:12px;border:none;
         font-size:1rem;font-weight:700;cursor:pointer;margin-bottom:0.75rem;text-decoration:none;text-align:center}
    .btn-primary{background:#00d4ff;color:#0f0f1a}
    .btn-secondary{background:#1a1a2e;color:#8892a4;border:1px solid #2a2a3e}
    #log{background:#0a0a14;border-radius:8px;padding:0.75rem;font-size:0.7rem;font-family:monospace;
         color:#4ade80;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow-y:auto}
  </style>
</head>
<body>
  <h2>✅ Withings認証成功</h2>
  <div class="card">
    <div class="label">userid</div>
    <div class="val">${userid}</div>
  </div>
  <div class="card">
    <div class="label">リダイレクト先URL（トークン省略）</div>
    <div class="val">${safeUrl}</div>
  </div>
  <div class="card">
    <div class="label">このページのURL（Safari or PWA?）</div>
    <div class="val" id="current-url">読み込み中...</div>
    <div class="label" style="margin-top:0.5rem">スタンドアロン（PWA）モード</div>
    <div class="val" id="standalone">読み込み中...</div>
    <div class="label" style="margin-top:0.5rem">localStorage 書き込みテスト</div>
    <div class="val" id="ls-test">読み込み中...</div>
  </div>

  <a id="app-link" class="btn btn-primary" href="${redirectUrl}">📱 アプリに戻ってトークンを取得</a>
  <button class="btn btn-secondary" onclick="copyUrl()">URLをコピー</button>
  <button class="btn btn-secondary" onclick="trySaveNow()">このページでlocalStorageに保存を試みる</button>

  <div style="margin-top:1rem;margin-bottom:0.5rem;font-size:0.75rem;color:#8892a4">ログ</div>
  <div id="log">起動...</div>

  <script>
    var redirectUrl = ${JSON.stringify(redirectUrl)};
    var log = document.getElementById('log');

    function addLog(msg) {
      log.textContent += '\\n' + new Date().toISOString().slice(11,23) + ' ' + msg;
      log.scrollTop = log.scrollHeight;
      console.log('[callback-debug]', msg);
    }

    // 現在のURLを表示
    document.getElementById('current-url').textContent = window.location.href;
    addLog('current href: ' + window.location.href);

    // PWAモード判定
    var standalone = window.navigator.standalone;
    document.getElementById('standalone').textContent = standalone ? '✅ PWAモード' : '❌ Safariブラウザ';
    addLog('navigator.standalone: ' + standalone);

    // localStorage 書き込みテスト
    try {
      localStorage.setItem('_withings_debug_test', '1');
      var ok = localStorage.getItem('_withings_debug_test') === '1';
      localStorage.removeItem('_withings_debug_test');
      document.getElementById('ls-test').textContent = ok ? '✅ 書き込み成功' : '❌ 書き込み失敗';
      addLog('localStorage write test: ' + (ok ? 'OK' : 'FAIL'));
    } catch(e) {
      document.getElementById('ls-test').textContent = '❌ エラー: ' + e;
      addLog('localStorage write test ERROR: ' + e);
    }

    // URLパラメータのパース確認
    var hash = redirectUrl.indexOf('#');
    var hashPart = hash >= 0 ? redirectUrl.slice(hash + 1) : '';
    var qIdx = hashPart.indexOf('?');
    var paramStr = qIdx >= 0 ? hashPart.slice(qIdx + 1) : '';
    var params = new URLSearchParams(paramStr);
    addLog('parsed withings_token: ' + (params.get('withings_token') ? 'EXISTS(' + params.get('withings_token').slice(0,8) + '...)' : 'MISSING'));
    addLog('parsed withings_refresh: ' + (params.get('withings_refresh') ? 'EXISTS' : 'MISSING'));
    addLog('parsed withings_userid: ' + params.get('withings_userid'));
    addLog('parsed withings_expires: ' + params.get('withings_expires'));

    function trySaveNow() {
      try {
        var tokensObj = {
          access_token:  params.get('withings_token'),
          refresh_token: params.get('withings_refresh'),
          userid:        params.get('withings_userid'),
          expires_at:    parseInt(params.get('withings_expires') || '0', 10),
        };
        localStorage.setItem('withings_tokens', JSON.stringify(tokensObj));
        localStorage.setItem('withings_last_sync', '0');
        addLog('✅ このページ（Safari）のlocalStorageに保存しました');
        addLog('→ アプリに戻ったとき同じストレージなら連携済みになるはず');
      } catch(e) {
        addLog('❌ 保存エラー: ' + e);
      }
    }

    function copyUrl() {
      navigator.clipboard.writeText(redirectUrl).then(function() {
        addLog('URLをクリップボードにコピーしました');
      }).catch(function() {
        addLog('クリップボードへのコピー失敗');
        prompt('URLをコピーしてください:', redirectUrl);
      });
    }

    addLog('ページ準備完了 — 上の「アプリに戻って」ボタンをタップしてください');
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
