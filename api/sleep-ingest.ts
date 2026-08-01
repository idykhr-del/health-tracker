import type { IncomingMessage, ServerResponse } from 'http'
import { createHash } from 'node:crypto'
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
  // 環境変数・ショートカット双方で末尾改行や前後空白が混入しやすいため、両側を
  // trim() してから比較する。判定・以降の処理はすべて trim 後の値を使う。
  const expectedRaw = process.env['SLEEP_INGEST_TOKEN']
  if (!expectedRaw) return json(res, 500, { error: 'SLEEP_INGEST_TOKEN is not configured' })
  const expectedToken = expectedRaw.trim()

  // URL からトークン取得（Apple Shortcuts は URL 埋め込みが最も簡単）
  const url      = req.url ?? ''
  const qsStart  = url.indexOf('?')
  const qs       = qsStart >= 0 ? new URLSearchParams(url.slice(qsStart)) : null
  const tokenQs  = qs?.get('token') ?? ''
  const tokenHdr = (req.headers['x-ingest-token'] as string | undefined) ?? ''
  const tokenRaw = tokenQs || tokenHdr
  const token    = tokenRaw.trim()

  if (!token || token !== expectedToken) {
    // 診断用フィンガープリント。値そのもの・その部分文字列は絶対に出さない
    // （Vercel はクエリパラメータをリクエストログに記録するため二重露出になる）。
    console.warn('[sleep-ingest] Auth failed.', JSON.stringify({
      providedLen:         tokenRaw.length,
      providedLenTrimmed:  token.length,
      expectedLen:         expectedRaw.length,
      expectedLenTrimmed:  expectedToken.length,
      providedFp:          fp(token),
      expectedFp:          fp(expectedToken),
      // 判定自体が trim 後の比較なので、ここに到達した時点で必ず false。
      // 「trim では救済できない＝値が別物」であることを明示するために出す。
      wouldMatchAfterTrim: token === expectedToken,
    }))
    return json(res, 401, { error: 'Unauthorized' })
  }

  // trim でのみ一致した場合は、どちら側に空白が混入しているかを残す。
  if (tokenRaw !== expectedRaw) {
    console.warn('[sleep-ingest] Auth matched only after trim(); surrounding whitespace present.', JSON.stringify({
      providedLen: tokenRaw.length,
      expectedLen: expectedRaw.length,
      trimmedLen:  token.length,
    }))
  }

  // ── ボディ読み取り ────────────────────────────────────────────────────────────
  let rawBody = ''
  try { rawBody = await readBody(req) }
  catch (e) { return json(res, 400, { error: 'readBody failed', detail: String(e) }) }

  let payload: Record<string, unknown>
  try { payload = JSON.parse(rawBody) as Record<string, unknown> }
  catch { return json(res, 400, { error: 'Invalid JSON' }) }

  // ── action=notion-write: 汎用 Notion ページ書き込み ────────────────────────────
  // Notion MCP 経由の rich_text 書き込みで "[" "{" 直前に "\" が混入する不具合を回避する
  // 専用経路。sleep 取り込みと同じ POST/認証/NOTION_API_KEY/notionFetch を再利用する。
  if (payload['action'] === 'notion-write') {
    return await handleNotionWrite(res, payload)
  }

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

  // ── Notion へ upsert 同期（アプリを開かなくても反映される） ─────────────────────
  // date をキーに既存ページを探し、totalSleep が変わっていれば全項目を上書きする。
  // 失敗してもレスポンスはブロックしない。Redis 保存は既に成功しているため、
  // 同期のリトライは次回 Shortcuts 実行 or アプリ起動時の health-data 経由でも行われる。
  let sync: NotionSyncResult
  try {
    sync = await syncToNotion(date, stored)
  } catch (e) {
    console.error('[sleep-ingest] Notion sync failed:', e)
    sync = { action: 'error', notionError: { status: 0, message: String(e) } }
  }

  return json(res, 200, {
    date,
    action: sync.action,
    ...(sync.notionError ? { notionError: sync.notionError } : {}),
  })
}

/** トークンのフィンガープリント（SHA-256 hex 先頭 8 文字）。値の復元はできない。 */
function fp(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 8)
}

// ── Notion 同期 ────────────────────────────────────────────────────────────────

const NOTION_BASE    = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'

type NotionAction = 'created' | 'updated' | 'unchanged' | 'skipped' | 'error'

/** Notion 側のエラー概要。ショートカットの実行結果にそのまま出す（トークン類は含めない）。 */
interface NotionErrorInfo { status: number; code?: string; message?: string }

interface NotionSyncResult { action: NotionAction; notionError?: NotionErrorInfo }

/**
 * AutoSleep データを sleep_records DB に upsert する。
 *
 *   既存ページなし         → 新規作成し 'created' を返す
 *   既存あり・totalSleep 差 → 全項目を上書きし 'updated' を返す
 *   既存あり・totalSleep 同 → Notion 更新をスキップし 'unchanged' を返す
 *   Notion が HTTP エラーを返した → 'error' + notionError を返す
 *
 * NOTION_API_KEY / NOTION_SLEEP_DB_ID が未設定なら何もせず 'skipped' を返す。
 */
async function syncToNotion(date: string, stored: AutoSleepStored): Promise<NotionSyncResult> {
  const apiKey = process.env['NOTION_API_KEY']
  const dbId   = process.env['NOTION_SLEEP_DB_ID']
  if (!apiKey || !dbId) {
    console.warn('[sleep-ingest] Notion sync skipped: NOTION_API_KEY / NOTION_SLEEP_DB_ID not set')
    return { action: 'skipped' }
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

  const existing = await findNotionPage(date, apiKey, dbId)

  // 既存なし → 新規作成
  if (!existing) {
    const created = await notionFetch('/pages', 'POST', apiKey, { parent: { database_id: dbId }, properties: props })
    if (!created.ok) return notionFailure('create', date, created)
    console.log(`[sleep-ingest] Notion sleep_records created for ${date}`)
    return { action: 'created' }
  }

  // 既存あり → totalSleep（asleepMinutes）を比較。一致すれば更新スキップ。
  const newTotal = stored.totalMinutes ?? null
  if (existing.asleepMinutes === newTotal) {
    console.log(`[sleep-ingest] Notion sleep_records unchanged for ${date} (asleepMinutes=${newTotal})`)
    return { action: 'unchanged' }
  }

  const updated = await notionFetch(`/pages/${existing.id}`, 'PATCH', apiKey, { properties: props })
  if (!updated.ok) return notionFailure('update', date, updated)
  console.log(`[sleep-ingest] Notion sleep_records updated for ${date} (${existing.asleepMinutes} → ${newTotal})`)
  return { action: 'updated' }
}

/** notionFetch の失敗レスポンスをログに出し、'error' + エラー概要へ変換する。 */
function notionFailure(
  op: string, date: string, result: { status: number; json: unknown },
): NotionSyncResult {
  const err = result.json as { code?: string; message?: string } | null
  console.error(`[sleep-ingest] Notion sleep_records ${op} failed for ${date}:`, result.status, err?.code, err?.message)
  return {
    action: 'error',
    notionError: { status: result.status, code: err?.code, message: err?.message },
  }
}

/**
 * date プロパティで既存ページを検索する。
 * 同じ日付が複数ヒットした場合は最終更新が最も新しい 1 件を対象とする。
 * 比較用に現在の asleepMinutes（totalSleep 相当）も返す。
 */
async function findNotionPage(
  date: string, apiKey: string, dbId: string,
): Promise<{ id: string; asleepMinutes: number | null } | null> {
  const res = await notionFetch(`/databases/${dbId}/query`, 'POST', apiKey, {
    page_size: 10,
    filter: { property: 'date', date: { equals: date } },
    sorts:  [{ timestamp: 'last_edited_time', direction: 'descending' }],
  })
  const data = res.json as {
    results?: Array<{
      id: string
      archived: boolean
      properties?: { asleepMinutes?: { number?: number | null } }
    }>
  }
  const page = (data.results ?? []).find(p => !p.archived)
  if (!page) return null
  const asleep = page.properties?.asleepMinutes?.number
  return { id: page.id, asleepMinutes: typeof asleep === 'number' ? asleep : null }
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

// ── 汎用 Notion 書き込み（action=notion-write）─────────────────────────────────
//
// body: { action:"notion-write", pageId: string, properties: { [name]: string|number } }
//   プロパティ名・型はペイロードから動的に組み立てる（ハードコードしない）:
//     string → rich_text  { rich_text: [{ text: { content: value } }] }
//     number → number     { number: value }
//   rich_text 文字列が "[" or "{" で始まる場合は JSON.parse で妥当性検証し、
//   失敗したら 400 で書き込み全体を拒否（壊れた JSON 保存の再発防止）。
//   認証は sleep-ingest と同じトークン、書き込みは NOTION_API_KEY + notionFetch を再利用。

const RICH_TEXT_CHUNK = 1900  // Notion rich_text 1オブジェクトの content 上限は 2000 文字

async function handleNotionWrite(res: ServerResponse, payload: Record<string, unknown>) {
  const apiKey = process.env['NOTION_API_KEY']
  if (!apiKey) return json(res, 500, { error: 'NOTION_API_KEY is not configured' })

  const pageId = payload['pageId']
  if (typeof pageId !== 'string' || !pageId.trim()) {
    return json(res, 400, { error: 'pageId (non-empty string) is required' })
  }
  const properties = payload['properties']
  if (properties == null || typeof properties !== 'object' || Array.isArray(properties)) {
    return json(res, 400, { error: 'properties (object) is required' })
  }

  const built = buildNotionProperties(properties as Record<string, unknown>)
  if (built.error) return json(res, 400, { error: built.error })
  if (Object.keys(built.props!).length === 0) {
    return json(res, 400, { error: 'properties is empty; nothing to write' })
  }

  console.log('[notion-write] pageId:', pageId, 'props:', Object.keys(built.props!).join(', '))

  const result = await notionFetch(`/pages/${pageId}`, 'PATCH', apiKey, { properties: built.props })
  if (!result.ok) {
    const err = result.json as { code?: string; message?: string } | null
    console.error('[notion-write] Notion PATCH failed:', result.status, err?.code, err?.message)
    return json(res, result.status || 502, {
      error: 'Notion write failed', status: result.status, code: err?.code, message: err?.message,
    })
  }
  const id = (result.json as { id?: string } | null)?.id
  console.log('[notion-write] updated page', id ?? pageId)
  return json(res, 200, { ok: true, pageId: id ?? pageId, updated: Object.keys(built.props!) })
}

/** ペイロードの properties を Notion プロパティ値へ変換（string→rich_text / number→number）。 */
function buildNotionProperties(input: Record<string, unknown>): { props?: Record<string, unknown>; error?: string } {
  const props: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return { error: `Property "${name}": number is not finite` }
      props[name] = { number: value }
    } else if (typeof value === 'string') {
      const head = value.trimStart()
      if (head.startsWith('[') || head.startsWith('{')) {
        try {
          JSON.parse(value)
        } catch {
          return {
            error: `Property "${name}": value starts with "[" or "{" but is not valid JSON. ` +
              `Write rejected to avoid saving broken JSON.`,
          }
        }
      }
      props[name] = { rich_text: richTextChunks(value) }
    } else {
      return { error: `Property "${name}": unsupported value type "${value === null ? 'null' : typeof value}" (only string or number)` }
    }
  }
  return { props }
}

/** 文字列を Notion rich_text の text オブジェクト配列へ（2000字上限対策で ≤1900 に分割）。 */
function richTextChunks(s: string): { text: { content: string } }[] {
  const chunks: { text: { content: string } }[] = []
  for (let i = 0; i < s.length; i += RICH_TEXT_CHUNK) {
    chunks.push({ text: { content: s.slice(i, i + RICH_TEXT_CHUNK) } })
  }
  return chunks.length ? chunks : [{ text: { content: '' } }]
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
