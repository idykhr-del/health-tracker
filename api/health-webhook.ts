import type { IncomingMessage, ServerResponse } from 'http'
import { Redis } from '@upstash/redis'

/**
 * POST /api/health-webhook
 *
 * Health Auto Export からの体組成・睡眠・活動データを Upstash Redis に保存する。
 *
 * Env vars (Upstash dashboard → REST API):
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
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

  console.log('[health-webhook] keys:', Object.keys(payload).join(', '))

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
    for (const entry of (payload[sleepKey] as Metric).data as SleepEntry[]) {
      const date = toDate(entry.date)
      if (!date) continue
      const s = upsertSleep(sleepMap, date)
      s.totalMinutes = toMin(entry.totalSleep) ?? s.totalMinutes
      s.deepMinutes  = toMin(entry.deep)       ?? s.deepMinutes
      s.remMinutes   = toMin(entry.rem)        ?? s.remMinutes
    }
  }

  // 歩数
  for (const { date, qty } of extractQty(payload, ['step_count', 'steps', 'HKQuantityTypeIdentifierStepCount'])) {
    upsertAct(actMap, date).steps = Math.round(qty)
  }
  // 心拍数
  const hrKey = ['heart_rate', 'HKQuantityTypeIdentifierHeartRate']
    .find(k => Array.isArray((payload[k] as Metric | undefined)?.data))
  if (hrKey) {
    for (const entry of (payload[hrKey] as Metric).data as HrEntry[]) {
      const date = toDate(entry.date)
      if (!date || entry.Avg == null) continue
      upsertAct(actMap, date).heartRateAvg = Math.round(entry.Avg)
    }
  }

  // ── ④ Upstash Redis に保存 ────────────────────────────────────────────────
  let redis: Redis
  try { redis = Redis.fromEnv() }
  catch (e) { return jsonRes(res, 500, { error: 'Redis init failed', detail: String(e) }) }

  const ops: Promise<unknown>[] = []

  for (const [date, v] of bodyMap)  ops.push(redis.set(`hae:body:${date}`,     JSON.stringify(v), { ex: 60 * 60 * 24 * 365 }))
  for (const [date, v] of sleepMap) ops.push(redis.set(`hae:sleep:${date}`,    JSON.stringify(v), { ex: 60 * 60 * 24 * 365 }))
  for (const [date, v] of actMap)   ops.push(redis.set(`hae:activity:${date}`, JSON.stringify(v), { ex: 60 * 60 * 24 * 365 }))

  try { await Promise.all(ops) }
  catch (e) { return jsonRes(res, 500, { error: 'Redis write failed', detail: String(e) }) }

  const saved = { body: bodyMap.size, sleep: sleepMap.size, activity: actMap.size }
  console.log('[health-webhook] saved:', saved)
  return jsonRes(res, 200, { status: 'ok', saved })
}

// ── 保存型 ────────────────────────────────────────────────────────────────────

interface StoredBody {
  weight?:              number
  bodyFatPct?:          number
  leanBodyMass?:        number
  estimatedMuscleMass?: number
}
interface StoredSleep {
  totalMinutes?: number
  deepMinutes?:  number
  remMinutes?:   number
}
interface StoredActivity {
  steps?:        number
  heartRateAvg?: number
}

// ── 受信データ型 ──────────────────────────────────────────────────────────────

interface Metric    { data: unknown[]; units?: string }
interface QtyEntry  { date: string; qty: number }
interface SleepEntry { date: string; totalSleep?: number | string; deep?: number | string; rem?: number | string }
interface HrEntry    { date: string; Avg?: number }

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
        .filter((e): e is QtyEntry => !!e && typeof (e as QtyEntry).qty === 'number' && !!(e as QtyEntry).date)
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
