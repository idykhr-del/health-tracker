import type { IncomingMessage, ServerResponse } from 'http'

/**
 * POST /api/health-webhook
 *
 * Health Auto Export アプリからの REST API リクエストを受け取るエンドポイント。
 * 受け取った JSON ボディをそのまま console.log で出力する（デバッグ用）。
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Method not allowed' }))
    return
  }

  // ボディ読み取り
  let rawBody = ''
  try {
    rawBody = await new Promise<string>((resolve, reject) => {
      let data = ''
      req.on('data', (chunk: Buffer) => { data += chunk.toString() })
      req.on('end',  () => resolve(data))
      req.on('error', reject)
    })
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Failed to read body', detail: String(e) }))
    return
  }

  // JSON パース & ログ出力
  let parsed: unknown = null
  try {
    parsed = JSON.parse(rawBody)
    console.log('[health-webhook] received body:', JSON.stringify(parsed, null, 2))
  } catch {
    // JSON でない場合は生テキストをログ
    console.log('[health-webhook] received raw body (non-JSON):', rawBody.slice(0, 1000))
  }

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ status: 'ok' }))
}
