import type { IncomingMessage, ServerResponse } from 'http'

/**
 * POST /api/post-to-slack
 *   認証: ?token=<SLACK_RELAY_TOKEN>
 *   body: { "text": string }
 *   → Slack Incoming Webhook へ転送
 *
 * GET /api/post-to-slack
 *   認証: ?token=<SLACK_RELAY_TOKEN>
 *   → Notion ページ (BRIEFING_PAGE_ID) の本文をプレーンテキスト化して Slack へ投稿
 *   Cowork などの GET のみ可能なサンドボックスからのトリガー用。
 *
 * Env vars:
 *   SLACK_RELAY_TOKEN   — 認証トークン（GET/POST 共通）
 *   SLACK_WEBHOOK_URL   — Slack Incoming Webhook URL
 *   NOTION_API_KEY      — Notion Integration トークン
 *   BRIEFING_PAGE_ID    — 本文を読み取る Notion ページ ID
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  // ── 共通: クエリ文字列パース ──────────────────────────────────────────────────
  const url     = req.url ?? ''
  const qsStart = url.indexOf('?')
  const qs      = qsStart >= 0 ? new URLSearchParams(url.slice(qsStart)) : null

  // ── 共通: 認証 ────────────────────────────────────────────────────────────────
  const expectedToken = process.env['SLACK_RELAY_TOKEN']
  if (!expectedToken) return json(res, 500, { error: 'SLACK_RELAY_TOKEN is not configured' })

  const token = qs?.get('token') ?? ''
  if (!token || token !== expectedToken) return json(res, 401, { error: 'Unauthorized' })

  // ── 共通: Webhook URL ─────────────────────────────────────────────────────────
  const webhookUrl = process.env['SLACK_WEBHOOK_URL']
  if (!webhookUrl) return json(res, 500, { error: 'SLACK_WEBHOOK_URL is not configured' })

  // =========================================================================
  // GET: Notion ページ → Slack
  // =========================================================================
  if (req.method === 'GET') {
    const notionKey = process.env['NOTION_API_KEY']
    const pageId    = process.env['BRIEFING_PAGE_ID'] ?? '3833ce20d6c0813e9a37fb9d31b370d2'

    if (!notionKey) return json(res, 500, { error: 'NOTION_API_KEY is not configured' })

    // ── Notion ブロック取得 ────────────────────────────────────────────────────
    let blocks: NotionBlock[]
    try {
      const notionRes = await fetch(
        `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`,
        {
          headers: {
            'Authorization':  `Bearer ${notionKey}`,
            'Notion-Version': '2022-06-28',
          },
        },
      )
      if (!notionRes.ok) {
        const body = await notionRes.text()
        return json(res, 500, { error: 'Notion API error', notionStatus: notionRes.status, body })
      }
      const data = await notionRes.json() as { results: NotionBlock[] }
      blocks = data.results ?? []
    } catch (e) {
      return json(res, 500, { error: 'Failed to fetch Notion page', detail: String(e) })
    }

    // ── code ブロックを先頭1つだけ抽出 ──────────────────────────────────────
    const codeBlock = blocks.find(b => b.type === 'code')
    if (!codeBlock) {
      return json(res, 200, { ok: true, skipped: 'no code block' })
    }

    const text = richTextToString(codeBlock.code?.rich_text ?? []).trim()
    if (!text) {
      return json(res, 200, { ok: true, skipped: 'empty page' })
    }

    // ── Slack へ投稿 ──────────────────────────────────────────────────────────
    try {
      const slackRes = await fetch(webhookUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text }),
      })
      if (slackRes.ok) {
        return json(res, 200, { ok: true, posted: true })
      } else {
        const slackBody = await slackRes.text()
        return json(res, 500, { ok: false, message: `Slack returned ${slackRes.status}`, body: slackBody })
      }
    } catch (e) {
      return json(res, 500, { ok: false, message: 'Failed to reach Slack', detail: String(e) })
    }
  }

  // =========================================================================
  // POST: テキストをそのまま Slack へ転送（既存実装・変更なし）
  // =========================================================================
  if (req.method === 'POST') {
    let rawBody = ''
    try { rawBody = await readBody(req) }
    catch (e) { return json(res, 400, { error: 'readBody failed', detail: String(e) }) }

    let payload: Record<string, unknown>
    try { payload = JSON.parse(rawBody) as Record<string, unknown> }
    catch { return json(res, 400, { error: 'Invalid JSON' }) }

    const text = typeof payload['text'] === 'string' ? payload['text'].trim() : ''
    if (!text) return json(res, 400, { error: '"text" is required and must be a non-empty string' })

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
        return json(res, 200, { status: 'error', slackStatus: slackRes.status, body: slackBody })
      }
    } catch (e) {
      return json(res, 500, { error: 'Failed to reach Slack', detail: String(e) })
    }
  }

  return json(res, 405, { error: 'Method not allowed' })
}

// ─────────────────────────────────────────────────────────────────────────────
// Notion ブロック型
// ─────────────────────────────────────────────────────────────────────────────

interface RichText {
  plain_text: string
}

interface NotionBlock {
  type: string
  heading_1?:        { rich_text: RichText[] }
  heading_2?:        { rich_text: RichText[] }
  heading_3?:        { rich_text: RichText[] }
  paragraph?:        { rich_text: RichText[] }
  bulleted_list_item?: { rich_text: RichText[] }
  numbered_list_item?: { rich_text: RichText[] }
  quote?:            { rich_text: RichText[] }
  callout?:          { rich_text: RichText[] }
  toggle?:           { rich_text: RichText[] }
  to_do?:            { rich_text: RichText[]; checked: boolean }
  code?:             { rich_text: RichText[] }
  [key: string]: unknown
}

// ─────────────────────────────────────────────────────────────────────────────
// ブロック → Slack テキスト変換
// ─────────────────────────────────────────────────────────────────────────────

function richTextToString(rich: RichText[]): string {
  return (rich ?? []).map(r => r.plain_text).join('')
}

function blocksToText(blocks: NotionBlock[]): string {
  const lines: string[] = []

  for (const block of blocks) {
    const type = block.type

    if (type === 'heading_1') {
      const t = richTextToString(block.heading_1?.rich_text ?? [])
      if (t) lines.push(`*${t}*`)

    } else if (type === 'heading_2') {
      const t = richTextToString(block.heading_2?.rich_text ?? [])
      if (t) lines.push(`*${t}*`)

    } else if (type === 'heading_3') {
      const t = richTextToString(block.heading_3?.rich_text ?? [])
      if (t) lines.push(`*${t}*`)

    } else if (type === 'paragraph') {
      const t = richTextToString(block.paragraph?.rich_text ?? [])
      if (t) lines.push(t)

    } else if (type === 'bulleted_list_item') {
      const t = richTextToString(block.bulleted_list_item?.rich_text ?? [])
      if (t) lines.push(`• ${t}`)

    } else if (type === 'numbered_list_item') {
      const t = richTextToString(block.numbered_list_item?.rich_text ?? [])
      if (t) lines.push(`• ${t}`)

    } else if (type === 'quote') {
      const t = richTextToString(block.quote?.rich_text ?? [])
      if (t) lines.push(`> ${t}`)

    } else if (type === 'callout') {
      const t = richTextToString(block.callout?.rich_text ?? [])
      if (t) lines.push(t)

    } else if (type === 'toggle') {
      const t = richTextToString(block.toggle?.rich_text ?? [])
      if (t) lines.push(t)

    } else if (type === 'to_do') {
      const t = richTextToString(block.to_do?.rich_text ?? [])
      if (t) {
        const prefix = block.to_do?.checked ? '☑' : '☐'
        lines.push(`${prefix} ${t}`)
      }

    } else if (type === 'code') {
      const t = richTextToString(block.code?.rich_text ?? [])
      if (t) lines.push(`\`\`\`\n${t}\n\`\`\``)

    } else if (type === 'divider') {
      lines.push('──────────')
    }
    // image / video / embed 等は無視
  }

  return lines.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// ユーティリティ
// ─────────────────────────────────────────────────────────────────────────────

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
