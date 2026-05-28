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
  // startdate は除去して全期間取得。startdate=0 や直近30日だとデータが返らないケースがある。
  // Withings API: startdate なし = 全件、または startdate=1577836800 (2020-01-01) で固定

  const params: Record<string, string> = {
    action:   'getmeas',
    meastype: '1',       // 体重のみ（疎通確認）
    category: '1',
    // startdate は意図的に除去（全期間取得）
    // lastupdate も除去
    offset:   '0',
  }

  // URLSearchParams はカンマを %2C にエンコードするため手動結合
  // エンドポイントを /v2/measure に変更（/measure で 0件になる問題の調査）
  const queryString = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&')
  const url = `https://wbsapi.withings.net/v2/measure?${queryString}`

  let rawApiResponse = ''
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${access_token}` },
    })

    const httpStatus = resp.status
    rawApiResponse = await resp.text()

    // APIの生テキストをそのまま返す（パース処理なし）
    return json(res, 200, {
      step:            'withings_api_call_done',
      httpStatus,
      params_sent:     params,              // ← 送ったパラメータ（デバッグ用）
      url_called:      url,                 // トークンはヘッダー送信のため URLに含まれない
      rawApiResponse,
    })
  } catch (e) {
    return json(res, 502, {
      step:        'fetch_failed',
      error:       String(e),
      params_sent: params,
      url_called:  url,
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
