import type { IncomingMessage, ServerResponse } from 'http'
import { Redis } from '@upstash/redis'

/**
 * POST /api/health-webhook
 *
 * Health Auto Export からの体組成・睡眠・活動データを Upstash Redis に保存する。
 *
 * Env vars (Vercel KV / Upstash):
 *   KV_REST_API_URL
 *   KV_REST_API_TOKEN
 *
 * Redis キー:
 *   hae:body:YYYY-MM-DD     → { weight, bodyFatPct, leanBodyMass, estimatedMuscleMass }
 *   hae:sleep:YYYY-MM-DD    → { totalMinutes, deepMinutes, remMinutes }
 *   hae:activity:YYYY-MM-DD → { steps, heartRateAvg }
 *
 * 対応メトリクス:
 *   weight_body_mass / body_mass      → body.weight
 *   body_fat_percentage               → body.bodyFatPct
 *   lean_body_mass                    → body.leanBodyMass
 *     ↳ estimatedMuscleMass = leanBodyMass × 0.45（推定値）
 *   sleep_analysis                    → sleep.*
 *   step_count / steps                → activity.steps
 *   heart_rate                        → activity.heartRateAvg
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  if (req.method !== 'POST') {
    return jsonRes(res, 405, { error: 'Method not allowed' })
  }

  // ── ① ボディ読み取り ──────────────────────────────────────────────────────
  let raw = ''
  try { raw = await readBody(req) }
  catch (e) { return jsonRes(res, 400, { error: 'readBody failed', detail: String(e) }) }

  let payload: Record<string, unknown>
  try { payload = JSON.parse(raw) as Record<string, unknown> }
  catch { return jsonRes(res, 400, { error: 'Invalid JSON' }) }

  console.log('[health-webhook] TOP-LEVEL keys:', Object.keys(payload).join(', '))

  // ── ② ネスト形式の展開 ────────────────────────────────────────────────────
  // Health Auto Export は { data: { metrics: [...], sleepAnalysis: [...] } } でも届く
  if (payload['data'] && typeof payload['data'] === 'object') {
    const d = payload['data'] as Record<string, unknown>
    if (Array.isArray(d['metrics'])) {
      const flat: Record<string, unknown> = {}
      for (const m of d['metrics'] as Array<{ name: string; units?: string; data: unknown[] }>) {
        flat[m.name] = { data: m.data, units: m.units }
      }
      if (Array.isArray(d['sleepAnalysis'])) flat['sleep_analysis'] = { data: d['sleepAnalysis'] }
      payload = flat
    }
  }

  // 展開後のキー一覧（ネスト形式なら展開後）
  console.log('[health-webhook] FLAT keys:', Object.keys(payload).join(', '))
  // body_fat_percentage の生データを確認
  const bfpRaw = payload['body_fat_percentage']
  if (bfpRaw && typeof bfpRaw === 'object' && Array.isArray((bfpRaw as { data?: unknown[] }).data)) {
    const bfpData = (bfpRaw as { data: unknown[] }).data
    console.log('[health-webhook] body_fat_percentage entries:', bfpData.length,
      'first:', JSON.stringify(bfpData[0] ?? null))
  } else {
    console.log('[health-webhook] body_fat_percentage: NOT FOUND or no data array')
  }

  // ── ③ データ抽出 ─────────────────────────────────────────────────────────
  // body: date → StoredBody
  const bodyMap  = new Map<string, StoredBody>()
  const sleepMap = new Map<string, StoredSleep>()
  const actMap   = new Map<string, StoredActivity>()

  // 体重
  for (const { date, qty } of extractQty(payload, ['weight_body_mass', 'body_mass'])) {
    upsertBody(bodyMap, date).weight = r2(qty)
  }
  // 体脂肪率
  for (const { date, qty } of extractQty(payload, ['body_fat_percentage'])) {
    upsertBody(bodyMap, date).bodyFatPct = r2(qty)
  }
  // 除脂肪体重
  for (const { date, qty } of extractQty(payload, ['lean_body_mass'])) {
    const b = upsertBody(bodyMap, date)
    b.leanBodyMass        = r2(qty)
    // 推定筋肉量 = 除脂肪体重 × 0.45（推定値として保存）
    b.estimatedMuscleMass = r2(qty * 0.45)
  }

  // 睡眠
  const sleepKey = ['sleep_analysis', 'HKCategoryTypeIdentifierSleepAnalysis']
    .find(k => Array.isArray((payload[k] as Metric | undefined)?.data))
  if (sleepKey) {
    console.log('[health-webhook] sleep_analysis first entry:',
      JSON.stringify((payload[sleepKey] as Metric).data[0] ?? null))
    for (const entry of (payload[sleepKey] as Metric).data as SleepEntry[]) {
      const date = toDate(entry.date)
      if (!date) continue
      const s = upsertSleep(sleepMap, date)
      s.totalMinutes      = toMin(entry.totalSleep)         ?? s.totalMinutes
      s.deepMinutes       = toMin(entry.deep)               ?? s.deepMinutes
      s.remMinutes        = toMin(entry.rem)                ?? s.remMinutes
      s.awakeMinutes      = toMin(entry.awake)              ?? s.awakeMinutes
      s.sleepStartMinutes = toStartMin(entry.sleepStart)    ?? s.sleepStartMinutes
    }
  }

  // 歩数（同日に複数エントリがある場合は合算）
  for (const { date, qty } of extractQty(payload, ['step_count', 'steps', 'HKQuantityTypeIdentifierStepCount'])) {
    const act = upsertAct(actMap, date)
    act.steps = (act.steps ?? 0) + Math.round(qty)
  }
  // 安静時心拍数（resting_heart_rate: 1日1値）
  for (const { date, qty } of extractQty(payload, ['resting_heart_rate', 'HKQuantityTypeIdentifierRestingHeartRate'])) {
    upsertAct(actMap, date).restingHeartRate = Math.round(qty)
  }

  // ── ④ Upstash Redis に保存 ────────────────────────────────────────────────
  const redisUrl   = process.env['KV_REST_API_URL']
  const redisToken = process.env['KV_REST_API_TOKEN']
  if (!redisUrl || !redisToken) {
    return jsonRes(res, 500, { error: 'Redis env vars not set (KV_REST_API_URL / KV_REST_API_TOKEN)' })
  }
  let redis: Redis
  try { redis = new Redis({ url: redisUrl, token: redisToken }) }
  catch (e) { return jsonRes(res, 500, { error: 'Redis init failed', detail: String(e) }) }

  const ops: Promise<unknown>[] = []

  // デバッグ: 保存するbodyデータの内容を全件出力
  console.log('[health-webhook] bodyMap size:', bodyMap.size)
  for (const [date, v] of bodyMap) {
    console.log(`[health-webhook] SAVE hae:body:${date} =`, JSON.stringify(v))
    ops.push(redis.set(`hae:body:${date}`, JSON.stringify(v), { ex: 60 * 60 * 24 * 365 }))
  }
  // デバッグ: sleepデータの内容を全件出力
  console.log('[health-webhook] sleepMap size:', sleepMap.size)
  for (const [date, v] of sleepMap) {
    console.log(`[health-webhook] SAVE hae:sleep:${date} =`, JSON.stringify(v))
    ops.push(redis.set(`hae:sleep:${date}`, JSON.stringify(v), { ex: 60 * 60 * 24 * 365 }))
  }
  // デバッグ: activityデータの内容を全件出力
  console.log('[health-webhook] actMap size:', actMap.size)
  for (const [date, v] of actMap) {
    console.log(`[health-webhook] SAVE hae:activity:${date} =`, JSON.stringify(v))
    ops.push(redis.set(`hae:activity:${date}`, JSON.stringify(v), { ex: 60 * 60 * 24 * 365 }))
  }

  try { await Promise.all(ops) }
  catch (e) { return jsonRes(res, 500, { error: 'Redis write failed', detail: String(e) }) }

  // ── ⑤ Notion body_records へ非同期 upsert ────────────────────────────────
  for (const [date, v] of bodyMap) {
    syncBodyToNotion(date, v).catch(e =>
      console.error(`[health-webhook] notion body sync failed for ${date}:`, e),
    )
  }

  const saved = { body: bodyMap.size, sleep: sleepMap.size, activity: actMap.size }
  console.log('[health-webhook] saved:', saved)
  return jsonRes(res, 200, { status: 'ok', saved })
}

// ── Notion body_records 同期 ──────────────────────────────────────────────────

const NOTION_BASE    = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'

async function syncBodyToNotion(date: string, body: StoredBody): Promise<void> {
  const apiKey = process.env['NOTION_API_KEY']
  const dbId   = process.env['NOTION_BODY_DB_ID']
  if (!apiKey || !dbId) {
    console.warn('[health-webhook] Notion body sync skipped: NOTION_API_KEY / NOTION_BODY_DB_ID not set')
    return
  }

  const props: Record<string, unknown> = {
    Name:   { title:     [{ text: { content: date } }] },
    date:   { date:      { start: date } },
    source: { rich_text: [{ text: { content: 'health_auto_export' } }] },
  }
  if (body.weight              != null) props['weight']              = { number: body.weight }
  if (body.bodyFatPct          != null) props['bodyFat']             = { number: body.bodyFatPct }
  if (body.leanBodyMass        != null) props['leanBodyMass']        = { number: body.leanBodyMass }
  if (body.estimatedMuscleMass != null) props['estimatedMuscleMass'] = { number: body.estimatedMuscleMass }

  const existing = await notionFindByDate(dbId, apiKey, date)
  if (existing) {
    await notionFetch(`/pages/${existing}`, 'PATCH', apiKey, { properties: props })
  } else {
    await notionFetch('/pages', 'POST', apiKey, { parent: { database_id: dbId }, properties: props })
  }
  console.log(`[health-webhook] notion body saved: ${date}`)
}

async function notionFindByDate(dbId: string, apiKey: string, date: string): Promise<string | null> {
  const r = await notionFetch(`/databases/${dbId}/query`, 'POST', apiKey, {
    page_size: 10,
    filter: { property: 'date', date: { equals: date } },
  })
  const data = r.json as { results?: Array<{ id: string; archived: boolean }> }
  return (data.results ?? []).find(p => !p.archived)?.id ?? null
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

// ── 保存型 ────────────────────────────────────────────────────────────────────

interface StoredBody {
  weight?:              number
  bodyFatPct?:          number
  leanBodyMass?:        number
  estimatedMuscleMass?: number
}
interface StoredSleep {
  totalMinutes?:      number
  deepMinutes?:       number
  remMinutes?:        number
  sleepStartMinutes?: number  // 0:00からの経過分 (例: 00:27→27, 23:50→1430)
  awakeMinutes?:      number  // 覚醒時間（分）
}
interface StoredActivity {
  steps?:            number
  restingHeartRate?: number
}

// ── 受信データ型 ──────────────────────────────────────────────────────────────

interface Metric    { data: unknown[]; units?: string }
interface QtyEntry  { date: string; qty: number }
interface SleepEntry { date: string; totalSleep?: number | string; deep?: number | string; rem?: number | string; sleepStart?: string; awake?: number | string }

// ── ユーティリティ ────────────────────────────────────────────────────────────

function upsertBody(m: Map<string, StoredBody>, date: string): StoredBody {
  if (!m.has(date)) m.set(date, {})
  return m.get(date)!
}
function upsertSleep(m: Map<string, StoredSleep>, date: string): StoredSleep {
  if (!m.has(date)) m.set(date, {})
  return m.get(date)!
}
function upsertAct(m: Map<string, StoredActivity>, date: string): StoredActivity {
  if (!m.has(date)) m.set(date, {})
  return m.get(date)!
}

function extractQty(payload: Record<string, unknown>, keys: string[]): QtyEntry[] {
  for (const key of keys) {
    const val = payload[key]
    if (val && typeof val === 'object' && Array.isArray((val as Metric).data)) {
      return (val as Metric).data
        .map(e => {
          if (!e || typeof e !== 'object') return null
          const entry = e as Record<string, unknown>
          const rawDate = entry['date'] as string | undefined
          // "2026-05-25 08:04:00 +0900" → "2026-05-25" に正規化
          const date = rawDate ? (rawDate.match(/^(\d{4}-\d{2}-\d{2})/) ?? [])[1] : undefined
          // qty は数値 or 数値文字列 どちらも受け付ける
          const rawQty = entry['qty'] ?? entry['value']
          const qty = typeof rawQty === 'number' ? rawQty : typeof rawQty === 'string' ? parseFloat(rawQty) : NaN
          if (!date || isNaN(qty)) return null
          return { date, qty } as QtyEntry
        })
        .filter((e): e is QtyEntry => e !== null)
    }
  }
  return []
}

/** "2026-05-30 08:00:00 +0900" | ISO → "YYYY-MM-DD" */
function toDate(raw: string): string | null {
  if (!raw) return null
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

/** "HH:MM" or "YYYY-MM-DD HH:MM:SS +ZZZZ" → 0:00からの経過分 */
function toStartMin(raw?: string): number | undefined {
  if (!raw) return undefined
  const m = raw.match(/(\d{1,2}):(\d{2})/)
  if (!m) return undefined
  return parseInt(m[1]) * 60 + parseInt(m[2])
}

/** 時間数 or 秒数 → 分 */
function toMin(v?: number | string): number | undefined {
  if (v == null) return undefined
  const n = typeof v === 'string' ? parseFloat(v) : v
  if (isNaN(n)) return undefined
  return n > 1000 ? Math.round(n / 60) : Math.round(n * 60) // 秒 → 分 or 時間 → 分
}

function r2(n: number) { return Math.round(n * 100) / 100 }

function jsonRes(res: ServerResponse, status: number, body: object) {
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
