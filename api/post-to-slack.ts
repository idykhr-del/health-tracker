import type { IncomingMessage, ServerResponse } from 'http'

/**
 * POST /api/post-to-slack
 *
 * Slack Incoming Webhook への中継エンドポイント。
 * Apple Shortcuts 等から text を受け取り、Slack に転送する。
 *
 * 認証: ?token=<SLACK_RELAY_TOKEN>
 *
 * リクエスト body (JSON): { "text": string }
 *
 * Env vars:
 *   SLACK_RELAY_TOKEN  — 認証トークン
 *   SLACK_WEBHOOK_URL  — Slack Incoming Webhook URL
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' })

  // ── 認証 ─────────────────────────────────────────────────────────────────────
  const expectedToken = process.env['SLACK_RELAY_TOKEN']
  if (!expectedToken) return json(res, 500, { error: 'SLACK_RELAY_TOKEN is not configured' })

  const url     = req.url ?? ''
  const qsStart = url.indexOf('?')
  const qs      = qsStart >= 0 ? new URLSearchParams(url.slice(qsStart)) : null
  const token   = qs?.get('token') ?? ''

  if (!token || token !== expectedToken) {
    return json(res, 401, { error: 'Unauthorized' })
  }

  // ── Webhook URL チェック ───────────────────────────────────────────────────
  const webhookUrl = process.env['SLACK_WEBHOOK_URL']
  if (!webhookUrl) return json(res, 500, { error: 'SLACK_WEBHOOK_URL is not configured' })

  // ── ボディ読み取り ────────────────────────────────────────────────────────────
  let rawBody = ''
  try { rawBody = await readBody(req) }
  catch (e) { return json(res, 400, { error: 'readBody failed', detail: String(e) }) }

  let payload: Record<string, unknown>
  try { payload = JSON.parse(rawBody) as Record<string, unknown> }
  catch { return json(res, 400, { error: 'Invalid JSON' }) }

  const text = typeof payload['text'] === 'string' ? payload['text'].trim() : ''
  if (!text) return json(res, 400, { error: '"text" is required and must be a non-empty string' })

  // ── Slack へ転送 ──────────────────────────────────────────────────────────────
  try {
    const slackRes = await fetch(webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text }),
    })

    const slackBody = await slackRes.text()

    if (slackRes.ok) {
      return json(res, 200, { status: 'ok' })
    } else {
      return json(res, 200, {
        status:      'error',
        slackStatus: slackRes.status,
        body:        slackBody,
      })
    }
  } catch (e) {
    return json(res, 500, { error: 'Failed to reach Slack', detail: String(e) })
  }
}

// ── ユーティリティ ────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let d = ''
    req.on('data', (c: Buffer) => { d += c.toString() })
    req.on('end',  () => resolve(d))
    req.on('error', reject)
  })
}
