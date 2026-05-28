import type { IncomingMessage, ServerResponse } from 'http'

/**
 * POST /api/withings-data  ── デバッグ用シンプル版
 *
 * body: { access_token: string, refresh_token?: string }
 *
 * Withings measure?action=getmeas&meastype=1（体重のみ）を呼び出し、
 * APIレスポンスをそのまま返す。パース・変換処理は一切行わない。
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  // ── CORS ──────────────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return
  }

  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' })
  }

  // ── ① リクエストボディ取得 ────────────────────────────────────────────────
  let rawBody = ''
  try {
    rawBody = await readBody(req)
  } catch (e) {
    return json(res, 400, { step: 'readBody', error: String(e) })
  }

  let parsedBody: { access_token?: string; refresh_token?: string }
  try {
    parsedBody = JSON.parse(rawBody)
  } catch (e) {
    return json(res, 400, { step: 'parseBody', error: String(e), rawBody })
  }

  const { access_token } = parsedBody
  if (!access_token) {
    return json(res, 400, { step: 'validateToken', error: 'access_token is required' })
  }

  // ── ② Withings API 呼び出し（meastype=1 のみ・生レスポンス返却）────────────
  const startdate = Math.floor(Date.now() / 1000) - 30 * 24 * 3600  // 30日前

  // URLSearchParams はカンマを %2C にエンコードするため手動結合
  const url = 'https://wbsapi.withings.net/measure'
    + '?action=getmeas'
    + '&meastype=1'                    // 体重のみ（シンプル疎通確認）
    + '&category=1'
    + `&startdate=${startdate}`
    + '&offset=0'

  let rawApiResponse = ''
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${access_token}` },
    })

    const httpStatus = resp.status
    rawApiResponse = await resp.text()

    // APIの生テキストをそのまま返す（パース処理なし）
    return json(res, 200, {
      step:           'withings_api_call_done',
      httpStatus,
      url_called:     url.replace(access_token, '[TOKEN]'),  // トークンをマスク
      rawApiResponse,
    })
  } catch (e) {
    return json(res, 502, {
      step:  'fetch_failed',
      error: String(e),
      url_called: url,
    })
  }
}

// ── ユーティリティ ─────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: object) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => { data += chunk.toString() })
    req.on('end',  () => resolve(data))
    req.on('error', reject)
  })
}
