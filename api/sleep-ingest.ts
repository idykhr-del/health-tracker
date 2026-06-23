import type { IncomingMessage, ServerResponse } from 'http'
import { Redis } from '@upstash/redis'

/**
 * POST /api/sleep-ingest
 *
 * Apple Shortcuts から AutoSleep の計測データを受け取り Redis に保存する。
 * Apple Health 経由では失われる AutoSleep 独自指標（スコア・覚醒回数・HRV 等）を
 * 直接取り込むためのエンドポイント。
 *
 * 認証:
 *   ?token=<SLEEP_INGEST_TOKEN>  または
 *   ヘッダ X-Ingest-Token: <SLEEP_INGEST_TOKEN>
 *   環境変数 SLEEP_INGEST_TOKEN と照合する。
 *
 * リクエスト body (JSON):
 *   date        string   YYYY-MM-DD または M/D/YYYY (必須)
 *   sleepScore  number   AutoSleep スコア (0–100)
 *   totalSleep  number   総睡眠時間（時間単位 e.g. 7.5、または分 e.g. 450）
 *   deepSleep   number   深睡眠（同上）
 *   remSleep    number   REM 睡眠（同上）
 *   awakenings  number   覚醒回数
 *   hrv         number   HRV (ms)
 *   wakingBPM   number   起床時心拍数
 *   sleepStart  string   就寝時刻 "HH:MM" or "HH:MM:SS"
 *   sleepEnd    string   起床時刻 "HH:MM" or "HH:MM:SS"
 *
 * Redis キー: autosleep:sleep:YYYY-MM-DD (TTL 90日)
 *
 * Env vars:
 *   SLEEP_INGEST_TOKEN
 *   KV_REST_API_URL
 *   KV_REST_API_TOKEN
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Ingest-Token')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' })

  // ── 認証 ─────────────────────────────────────────────────────────────────────
  const expectedToken = process.env['SLEEP_INGEST_TOKEN']
  if (!expectedToken) return json(res, 500, { error: 'SLEEP_INGEST_TOKEN is not configured' })

  // URL からトークン取得（Apple Shortcuts は URL 埋め込みが最も簡単）
  const url      = req.url ?? ''
  const qsStart  = url.indexOf('?')
  const qs       = qsStart >= 0 ? new URLSearchParams(url.slice(qsStart)) : null
  const tokenQs  = qs?.get('token') ?? ''
  const tokenHdr = (req.headers['x-ingest-token'] as string | undefined) ?? ''
  const token    = tokenQs || tokenHdr

  if (!token || token !== expectedToken) {
    console.warn('[sleep-ingest] Auth failed. provided token length:', token.length)
    return json(res, 401, { error: 'Unauthorized' })
  }

  // ── ボディ読み取り ────────────────────────────────────────────────────────────
  let rawBody = ''
  try { rawBody = await readBody(req) }
  catch (e) { return json(res, 400, { error: 'readBody failed', detail: String(e) }) }

  let payload: Record<string, unknown>
  try { payload = JSON.parse(rawBody) as Record<string, unknown> }
  catch { return json(res, 400, { error: 'Invalid JSON' }) }

  // ── date 正規化 ───────────────────────────────────────────────────────────────
  const rawDate = (payload['date'] as string | undefined) ?? ''
  const date    = normalizeDate(rawDate)
  if (!date) return json(res, 400, { error: `Invalid or missing date: "${rawDate}". Use YYYY-MM-DD.` })

  // ── 受信内容をログ（Vercel Logs で確認可能）────────────────────────────────────
  console.log('[sleep-ingest] payload keys:', Object.keys(payload).join(', '))
  console.log('[sleep-ingest] raw payload:', JSON.stringify(payload))

  // ── フィールド抽出・正規化 ─────────────────────────────────────────────────────
  // Shortcuts からはすべて文字列で届く。toNum が parseFloat で数値化する。
  const stored: AutoSleepStored = {}

  // sleepScore: 0–100 の整数に丸める
  const sleepScore = toNum(payload['sleepScore'])
  if (sleepScore != null) stored.sleepScore = Math.min(100, Math.max(0, Math.round(sleepScore)))

  // totalSleep / deepSleep / qualitySleep: 時間単位→分に変換
  const totalMin = toSleepMin(payload['totalSleep'])
  if (totalMin != null) stored.totalMinutes = totalMin

  const deepMin = toSleepMin(payload['deepSleep'])
  if (deepMin != null) stored.deepMinutes = deepMin

  // qualitySleep = AutoSleep の「質の良い睡眠」時間（REM相当）
  const qualityMin = toSleepMin(payload['qualitySleep'])
  if (qualityMin != null) stored.qualityMinutes = qualityMin

  // heartRate = 起床時心拍数
  const heartRate = toNum(payload['heartRate'])
  if (heartRate != null) stored.wakingBPM = Math.round(heartRate)

  // hrv
  const hrv = toNum(payload['hrv'])
  if (hrv != null) stored.hrv = r2(hrv)

  // 以下は Shortcuts から来ない場合もある補助フィールド
  const awakenings = toNum(payload['awakenings'])
  if (awakenings != null) stored.awakenings = Math.round(awakenings)

  const startMin = toStartMin(payload['sleepStart'] as string | undefined)
  if (startMin != null) stored.sleepStartMinutes = startMin

  const endMin = toStartMin(payload['sleepEnd'] as string | undefined)
  if (endMin != null) stored.sleepEndMinutes = endMin

  console.log('[sleep-ingest] stored:', JSON.stringify(stored))

  if (Object.keys(stored).length === 0) {
    return json(res, 400, { error: 'No valid fields found in payload' })
  }

  // ── Redis 保存 ────────────────────────────────────────────────────────────────
  const redisUrl   = process.env['KV_REST_API_URL']
  const redisToken = process.env['KV_REST_API_TOKEN']
  if (!redisUrl || !redisToken) return json(res, 500, { error: 'Redis env vars not set' })

  let redis: Redis
  try { redis = new Redis({ url: redisUrl, token: redisToken }) }
  catch (e) { return json(res, 500, { error: 'Redis init failed', detail: String(e) }) }

  try {
    await redis.set(`autosleep:sleep:${date}`, JSON.stringify(stored), { ex: 60 * 60 * 24 * 90 })
    console.log(`[sleep-ingest] saved autosleep:sleep:${date} =`, JSON.stringify(stored))
  } catch (e) {
    return json(res, 500, { error: 'Redis write failed', detail: String(e) })
  }

  // ── Notion へ直接同期（アプリを開かなくても反映される） ──────────────────────────
  // 失敗してもレスポンスはブロックしない。Redis 保存は既に成功しているため、
  // 同期のリトライは次回 Shortcuts 実行 or アプリ起動時の health-data 経由でも行われる。
  let notionSynced = false
  try {
    notionSynced = await syncToNotion(date, stored)
  } catch (e) {
    console.error('[sleep-ingest] Notion sync failed:', e)
  }

  return json(res, 200, { status: 'ok', date, saved: stored, notionSynced })
}

// ── Notion 同期 ────────────────────────────────────────────────────────────────

const NOTION_BASE    = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'

/**
 * AutoSleep データを sleep_records DB に upsert する。
 * NOTION_API_KEY / NOTION_SLEEP_DB_ID が未設定なら何もせず false を返す。
 */
async function syncToNotion(date: string, stored: AutoSleepStored): Promise<boolean> {
  const apiKey = process.env['NOTION_API_KEY']
  const dbId   = process.env['NOTION_SLEEP_DB_ID']
  if (!apiKey || !dbId) {
    console.warn('[sleep-ingest] Notion sync skipped: NOTION_API_KEY / NOTION_SLEEP_DB_ID not set')
    return false
  }

  const props: Record<string, unknown> = {
    Name: { title: [{ text: { content: date } }] },
    date: { date:  { start: date } },
    source: { select: { name: 'autosleep_shortcut' } },
  }
  if (stored.totalMinutes      != null) props['asleepMinutes']     = { number: stored.totalMinutes }
  if (stored.deepMinutes       != null) props['deepMinutes']       = { number: stored.deepMinutes }
  if (stored.qualityMinutes    != null) props['qualityMinutes']    = { number: stored.qualityMinutes }
  if (stored.sleepStartMinutes != null) props['sleepStartMinutes'] = { number: stored.sleepStartMinutes }
  if (stored.sleepScore        != null) props['sleepScore']        = { number: stored.sleepScore }
  if (stored.awakenings        != null) props['awakenings']        = { number: stored.awakenings }
  if (stored.hrv               != null) props['hrv']               = { number: stored.hrv }
  if (stored.wakingBPM         != null) props['wakingBPM']         = { number: stored.wakingBPM }

  const existingId = await findNotionPageId(date, apiKey, dbId)
  if (existingId) {
    await notionFetch(`/pages/${existingId}`, 'PATCH', apiKey, { properties: props })
  } else {
    await notionFetch('/pages', 'POST', apiKey, { parent: { database_id: dbId }, properties: props })
  }
  console.log(`[sleep-ingest] Notion sleep_records synced for ${date}`)
  return true
}

async function findNotionPageId(date: string, apiKey: string, dbId: string): Promise<string | null> {
  const res = await notionFetch(`/databases/${dbId}/query`, 'POST', apiKey, {
    page_size: 10,
    filter: { property: 'date', date: { equals: date } },
  })
  const data = res.json as { results?: Array<{ id: string; archived: boolean }> }
  const page = (data.results ?? []).find(p => !p.archived)
  return page?.id ?? null
}

async function notionFetch(
  path: string, method: string, apiKey: string, body?: unknown,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const res = await fetch(`${NOTION_BASE}${path}`, {
    method,
    headers: {
      Authorization:    `Bearer ${apiKey}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type':   'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  let json: unknown
  try { json = await res.json() } catch { json = null }
  return { ok: res.ok, status: res.status, json }
}

// ── 型定義 ────────────────────────────────────────────────────────────────────

interface AutoSleepStored {
  sleepScore?:        number   // AutoSleep 独自スコア (0–100)
  totalMinutes?:      number   // 総睡眠時間（分）
  deepMinutes?:       number   // 深睡眠（分）
  qualityMinutes?:    number   // qualitySleep = 質の良い睡眠時間（分）
  awakenings?:        number   // 覚醒回数
  hrv?:               number   // HRV (ms)
  wakingBPM?:         number   // 起床時心拍数（heartRate フィールドから）
  sleepStartMinutes?: number   // 0:00 からの経過分
  sleepEndMinutes?:   number   // 0:00 からの経過分
}

// ── ユーティリティ ────────────────────────────────────────────────────────────

/**
 * 日付文字列を YYYY-MM-DD に正規化。
 * 対応フォーマット:
 *   "2026-06-11", "2026/06/11", "6/11/2026", "June 11, 2026" 等
 */
function normalizeDate(raw: string): string | null {
  if (!raw) return null
  // YYYY-MM-DD or YYYY/MM/DD
  const iso = raw.match(/^(\d{4})[/-](\d{2})[/-](\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  // M/D/YYYY
  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`
  // Try Date constructor fallback
  const d = new Date(raw)
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  return null
}

/** "HH:MM" または "HH:MM:SS" → 0:00 からの経過分 */
function toStartMin(raw?: string): number | null {
  if (!raw) return null
  const m = raw.match(/(\d{1,2}):(\d{2})/)
  if (!m) return null
  return parseInt(m[1]) * 60 + parseInt(m[2])
}

/**
 * 睡眠時間を分に変換。
 *   > 1000 → 秒として扱う (÷60)
 *   > 60   → 既に分として扱う
 *   ≤ 60   → 時間として扱う (×60)
 */
function toSleepMin(v: unknown): number | null {
  const n = toNum(v)
  if (n == null || n <= 0) return null
  if (n > 1000) return Math.round(n / 60)  // 秒 → 分
  if (n > 60)   return Math.round(n)        // 既に分
  return Math.round(n * 60)                 // 時間 → 分
}

function toNum(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : null
  if (n == null || isNaN(n)) return null
  return n
}

function r2(n: number): number { return Math.round(n * 100) / 100 }

function json(res: ServerResponse, status: number, body: object) {
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
