import type { IncomingMessage, ServerResponse } from 'http'
import { Redis } from '@upstash/redis'
import { jstDateKey } from '../lib/jst.js'

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
 * GET /api/post-to-slack?action=feed&k=<ALEXA_FEED_KEY>
 *   認証: ?k=<ALEXA_FEED_KEY>（不一致・未設定は 404）
 *   → 直近の Slack 投稿本文を Alexa フラッシュブリーフィング形式の JSON で返す
 *   Vercel Hobby の 12 関数上限のため、専用ファイルを作らずここに同居させている。
 *
 * Env vars:
 *   SLACK_RELAY_TOKEN   — 認証トークン（GET/POST 共通）
 *   SLACK_WEBHOOK_URL   — Slack Incoming Webhook URL
 *   NOTION_API_KEY      — Notion Integration トークン
 *   BRIEFING_PAGE_ID    — 本文を読み取る Notion ページ ID
 *   ALEXA_FEED_KEY      — フラッシュブリーフィング取得用の秘密キー
 *   KV_REST_API_URL     — Upstash Redis（ブリーフィング本文の保存先）
 *   KV_REST_API_TOKEN   — 同上
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

  // ── Alexa フラッシュブリーフィング用フィード ─────────────────────────────────
  // Alexa は SLACK_RELAY_TOKEN を持てないので、共通認証より前に分岐する。
  if (req.method === 'GET' && qs?.get('action') === 'feed') {
    return handleFeed(res, qs.get('k') ?? '')
  }

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
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
    res.setHeader('CDN-Cache-Control', 'no-store')
    res.setHeader('Vercel-CDN-Cache-Control', 'no-store')

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

    const codeText = richTextToString(codeBlock.code?.rich_text ?? []).trim()
    if (!codeText) {
      return json(res, 200, { ok: true, skipped: 'empty page' })
    }

    // ── メンションを先頭に付与（未設定時は U0B72CUC57V をデフォルト）────────
    const mentionId = (process.env['SLACK_MENTION_USER_ID'] ?? 'U0B72CUC57V').trim()
    const mention   = `<@${mentionId}>`
    const text      = codeText.startsWith(mention)
      ? codeText
      : `${mention} ${codeText}`

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
        // Alexa 用に本文を保存する。失敗しても Slack 投稿の結果は変えない。
        try { await saveBriefing(text) }
        catch (e) { console.warn('[post-to-slack] briefing save failed (non-fatal):', e) }
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

// ─────────────────────────────────────────────────────────────────────────────
// Alexa フラッシュブリーフィング
// ─────────────────────────────────────────────────────────────────────────────

const BRIEFING_KEY  = 'briefing:latest'
const BRIEFING_TTL  = 60 * 60 * 24 * 3        // 3日
const BRIEFING_URL  = 'https://health-tracker-murex-chi.vercel.app/'
const SPEECH_LIMIT  = 4400                     // Alexa の mainText 上限に対する安全域
const NO_DATA_TEXT  = '本日の健康ブリーフィングはまだ準備できていません。'

interface StoredBriefing {
  text:    string
  savedAt: string
  dateKey: string
}

function getRedis(): Redis | null {
  const url   = process.env['KV_REST_API_URL']
  const token = process.env['KV_REST_API_TOKEN']
  if (!url || !token) return null
  return new Redis({ url, token })
}

/** Slack へ投稿した本文を Alexa 用に保存する */
async function saveBriefing(text: string): Promise<void> {
  const redis = getRedis()
  if (!redis) {
    console.warn('[post-to-slack] KV_REST_API_URL / KV_REST_API_TOKEN not set — briefing not saved')
    return
  }
  const now: Date = new Date()
  const stored: StoredBriefing = {
    text,
    savedAt: now.toISOString(),
    dateKey: jstDateKey(now),
  }
  await redis.set(BRIEFING_KEY, JSON.stringify(stored), { ex: BRIEFING_TTL })
  console.log(`[post-to-slack] briefing saved (${stored.dateKey}, ${text.length} chars)`)
}

/** GET ?action=feed — Alexa フラッシュブリーフィング JSON */
async function handleFeed(res: ServerResponse, key: string): Promise<void> {
  const expected = (process.env['ALEXA_FEED_KEY'] ?? '').trim()
  if (!expected || key.trim() !== expected) {
    console.warn('[post-to-slack] feed: key mismatch')
    return json(res, 404, { error: 'Not found' })
  }

  let stored: StoredBriefing | null = null
  try {
    const redis = getRedis()
    if (redis) {
      const raw = await redis.get<StoredBriefing | string>(BRIEFING_KEY)
      stored = typeof raw === 'string' ? JSON.parse(raw) as StoredBriefing : raw
    }
  } catch (e) {
    console.warn('[post-to-slack] feed: Redis read failed:', e)
  }

  // データが無くても 200 を返す（Alexa 側でエラー表示にならないようにする）
  const dateKey  = stored?.dateKey ?? jstDateKey()
  const mainText = stored?.text ? sanitizeForSpeech(stored.text) : NO_DATA_TEXT

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
  res.setHeader('CDN-Cache-Control', 'no-store')
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store')
  return json(res, 200, {
    uid:             `briefing-${dateKey}`,
    updateDate:      toAlexaDate(stored?.savedAt),
    titleText:       titleFromDateKey(dateKey),
    mainText:        mainText || NO_DATA_TEXT,
    redirectionUrl:  BRIEFING_URL,
  })
}

/** ISO 文字列 → Alexa が要求する UTC の YYYY-MM-DDTHH:mm:ss.0Z */
function toAlexaDate(iso?: string): string {
  const d = iso ? new Date(iso) : new Date()
  const valid = Number.isNaN(d.getTime()) ? new Date() : d
  return valid.toISOString().replace(/\.\d{3}Z$/, '.0Z')
}

/** YYYY-MM-DD → 「健康ブリーフィング M月D日」 */
function titleFromDateKey(dateKey: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey)
  if (!m) return '健康ブリーフィング'
  return `健康ブリーフィング ${Number(m[2])}月${Number(m[3])}日`
}

/**
 * 読み上げ用サニタイズ。
 * Slack 記法・Markdown 記号・絵文字を落とし、行ごとに「。」で区切って
 * Alexa が自然に読めるプレーンテキストにする。
 */
function sanitizeForSpeech(raw: string): string {
  let t = raw

  // Slack 記法
  t = t.replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, '')            // ユーザーメンション → 除去
  t = t.replace(/<#[A-Z0-9]+\|([^>]*)>/g, '$1')             // チャンネル → 名前だけ残す
  t = t.replace(/<#[A-Z0-9]+>/g, '')
  t = t.replace(/<!(?:here|channel|everyone)(?:\|[^>]*)?>/g, '')
  t = t.replace(/<(?:https?|mailto):[^>|]*\|([^>]*)>/g, '$1') // リンク → ラベルだけ残す
  t = t.replace(/<(?:https?|mailto):[^>]*>/g, '')
  t = t.replace(/https?:\/\/\S+/g, '')                      // 裸の URL は読み上げない

  // 絵文字・記号
  // :smile: 形式。英字を1つ以上含み前後が英数字でないものだけ（7:30:00 のような時刻を壊さない）
  t = t.replace(/(?<![0-9A-Za-z]):([a-z0-9_+-]*[a-z_][a-z0-9_+-]*):(?![0-9A-Za-z])/gi, '')
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{20E3}\u{2190}-\u{21FF}\u{2500}-\u{257F}]/gu, '')

  // HTML エンティティ（Slack が送ってくる形）
  t = t.replace(/&amp;/g, 'と').replace(/&lt;/g, '').replace(/&gt;/g, '')

  const lines: string[] = []
  for (const rawLine of t.split(/\r?\n/)) {
    let line = rawLine.replace(/[ \t\u3000]+/g, ' ')
    line = line.replace(/^[\s・•▪◦\-–—*＊＋+>＞#＃|｜]+/, '')  // 行頭の箇条書き・引用記号
    line = line.replace(/[*_`~#>|＊＿｀～＃＞｜]/g, '')          // 残りの Markdown 記号
    line = line.replace(/[ \t\u3000]+/g, ' ').trim()

    if (!line) {
      if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('')  // 空行は1つに畳む
      continue
    }
    if (!/[。！？!?、]$/.test(line)) line += '。'
    else if (/[、]$/.test(line))    line = line.slice(0, -1) + '。'
    lines.push(line)
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  return truncateForSpeech(lines.join('\n'))
}

/** 上限で打ち切る。可能なら直前の「。」で切る。 */
function truncateForSpeech(text: string, limit: number = SPEECH_LIMIT): string {
  if (text.length <= limit) return text
  const head = text.slice(0, limit)
  const idx  = head.lastIndexOf('。')
  return idx > 0 ? head.slice(0, idx + 1) : head
}
