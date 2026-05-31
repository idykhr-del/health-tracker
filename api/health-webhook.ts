import type { IncomingMessage, ServerResponse } from 'http'
import { kv } from '@vercel/kv'

/**
 * POST /api/health-webhook
 *
 * Health Auto Export アプリからの体組成・睡眠データを受け取り Vercel KV に保存する。
 *
 * 期待するリクエストボディ（フラット形式 or ネスト形式の両方に対応）:
 *   {
 *     weight_body_mass:      { data: [{date, qty, source}], units: "kg" }
 *     body_fat_percentage:   { data: [{date, qty, source}], units: "%" }
 *     sleep_analysis:        { data: [{date, totalSleep, deep, rem, core, sleepStart, sleepEnd}] }
 *     heart_rate:            { data: [{date, Avg, Min, Max}] }
 *   }
 *
 * または Health Auto Export の標準ネスト形式:
 *   { data: { metrics: [{name, units, data:[...]}], sleepAnalysis: [...] } }
 *
 * KV キー:
 *   hae:body  (hash)  date → JSON BodyRecord
 *   hae:sleep (hash)  date → JSON SleepRecord
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Method not allowed' }))
    return
  }

  // ── ① ボディ読み取り ──────────────────────────────────────────────────────
  let rawBody = ''
  try {
    rawBody = await readBody(req)
  } catch (e) {
    return jsonResp(res, 400, { error: 'Failed to read body', detail: String(e) })
  }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>
  } catch (e) {
    console.log('[health-webhook] non-JSON body:', rawBody.slice(0, 500))
    return jsonResp(res, 400, { error: 'Invalid JSON', detail: String(e) })
  }

  console.log('[health-webhook] received keys:', Object.keys(payload).join(', '))

  // ── ② データ抽出（フラット形式 / ネスト形式の両方に対応） ──────────────
  // Health Auto Export は 2 種類のフォーマットで送ってくる可能性がある
  let flatPayload = payload

  // ネスト形式 { data: { metrics: [...], sleepAnalysis: [...] } } を展開
  if (payload['data'] && typeof payload['data'] === 'object') {
    const dataObj = payload['data'] as Record<string, unknown>
    if (Array.isArray(dataObj['metrics'])) {
      flatPayload = {}
      for (const metric of dataObj['metrics'] as MetricEntry[]) {
        if (metric.name) flatPayload[metric.name] = { data: metric.data, units: metric.units }
      }
      if (Array.isArray(dataObj['sleepAnalysis'])) {
        flatPayload['sleep_analysis'] = { data: dataObj['sleepAnalysis'] }
      }
    }
  }

  // ── ③ 体組成データの保存 ─────────────────────────────────────────────────
  const bodyUpdates: Record<string, string> = {}

  // 体重
  const weightEntries = extractQtyData(flatPayload, ['weight_body_mass', 'body_mass', 'HKQuantityTypeIdentifierBodyMass'])
  for (const { date, qty } of weightEntries) {
    const rec = getOrCreateBody(bodyUpdates, date)
    rec.weight = round2(qty)
    bodyUpdates[date] = JSON.stringify(rec)
  }

  // 体脂肪率
  const fatEntries = extractQtyData(flatPayload, ['body_fat_percentage', 'HKQuantityTypeIdentifierBodyFatPercentage'])
  for (const { date, qty } of fatEntries) {
    const rec = getOrCreateBody(bodyUpdates, date)
    rec.bodyFatPct = round2(qty)
    bodyUpdates[date] = JSON.stringify(rec)
  }

  // ── ④ 睡眠データの保存 ───────────────────────────────────────────────────
  const sleepUpdates: Record<string, string> = {}

  const sleepKey = ['sleep_analysis', 'HKCategoryTypeIdentifierSleepAnalysis']
    .find(k => Array.isArray((flatPayload[k] as { data?: unknown })?.data))

  if (sleepKey) {
    const sleepData = ((flatPayload[sleepKey] as { data: unknown[] }).data) as SleepEntry[]
    for (const entry of sleepData) {
      const date = parseDate(entry.date)
      if (!date) continue

      const rec: StoredSleepRecord = {
        id:            `hae-${date}`,
        date,
        source:        'health_auto_export',
        asleepMinutes: toMinutes(entry.totalSleep),
        deepMinutes:   toMinutes(entry.deep),
        remMinutes:    toMinutes(entry.rem),
        lightMinutes:  toMinutes(entry.core),   // "core" = light/core sleep
        bedtime:       entry.sleepStart ?? undefined,
        waketime:      entry.sleepEnd   ?? undefined,
      }
      sleepUpdates[date] = JSON.stringify(rec)
    }
  }

  // ── ⑤ KV に保存 ─────────────────────────────────────────────────────────
  const savedBody  = Object.keys(bodyUpdates).length
  const savedSleep = Object.keys(sleepUpdates).length

  try {
    if (savedBody  > 0) await kv.hset('hae:body',  bodyUpdates)
    if (savedSleep > 0) await kv.hset('hae:sleep', sleepUpdates)
    console.log(`[health-webhook] saved body=${savedBody} sleep=${savedSleep}`)
  } catch (e) {
    console.error('[health-webhook] KV save error:', e)
    return jsonResp(res, 500, { error: 'KV save failed', detail: String(e) })
  }

  return jsonResp(res, 200, {
    status:     'ok',
    savedBody,
    savedSleep,
  })
}

// ── ヘルパー型 ────────────────────────────────────────────────────────────────

interface MetricEntry { name: string; units?: string; data: unknown[] }
interface QtyEntry    { date: string; qty: number; source?: string }
interface SleepEntry  { date: string; totalSleep?: number | string; deep?: number | string; rem?: number | string; core?: number | string; sleepStart?: string; sleepEnd?: string }

interface StoredBodyRecord {
  id:          string
  date:        string
  weight?:     number
  bodyFatPct?: number
  source:      'health_auto_export'
}

interface StoredSleepRecord {
  id:            string
  date:          string
  asleepMinutes?: number
  deepMinutes?:   number
  remMinutes?:    number
  lightMinutes?:  number
  bedtime?:       string
  waketime?:      string
  source:         'health_auto_export'
}

// ── ユーティリティ ────────────────────────────────────────────────────────────

function getOrCreateBody(map: Record<string, string>, date: string): StoredBodyRecord {
  if (map[date]) return JSON.parse(map[date]) as StoredBodyRecord
  return { id: `hae-${date}`, date, source: 'health_auto_export' }
}

function extractQtyData(
  payload: Record<string, unknown>,
  keys: string[],
): QtyEntry[] {
  for (const key of keys) {
    const val = payload[key]
    if (val && typeof val === 'object' && Array.isArray((val as { data?: unknown }).data)) {
      return ((val as { data: unknown[] }).data as QtyEntry[])
        .filter(e => e && typeof e.qty === 'number' && e.date)
    }
  }
  return []
}

/** "2026-05-30 08:00:00 +0900" | "2026-05-30T08:00:00+09:00" → "2026-05-30" */
function parseDate(raw: string): string | null {
  if (!raw) return null
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : null
}

/** 時間（時間数 or 秒数）→ 分 */
function toMinutes(val?: number | string): number | undefined {
  if (val == null) return undefined
  const n = typeof val === 'string' ? parseFloat(val) : val
  if (isNaN(n)) return undefined
  // Withings は秒、Health Auto Export は時間単位が多い
  return n > 1000 ? Math.round(n / 60) : Math.round(n * 60)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function jsonResp(res: ServerResponse, status: number, body: object) {
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
