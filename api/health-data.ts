import type { IncomingMessage, ServerResponse } from 'http'
import { Redis } from '@upstash/redis'

/**
 * GET /api/health-data
 *
 * Upstash Redis から直近7日分の HAE データを取得して返す。
 * フロントの useHealthAutoExport フックが起動時に呼び出す。
 *
 * Env vars: KV_REST_API_URL, KV_REST_API_TOKEN
 *
 * レスポンス:
 * {
 *   bodyRecords:     HaeBodyRecord[]
 *   sleepRecords:    HaeSleepRecord[]
 *   activityRecords: HaeActivityRecord[]
 * }
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Method not allowed' }))
    return
  }

  // 直近7日の日付リスト（今日含む）
  const dates = Array.from({ length: 7 }, (_, i) => {
    const d = new Date()
    d.setDate(d.getDate() - i)
    return d.toISOString().slice(0, 10)
  })

  try {
    const redisUrl   = process.env['KV_REST_API_URL']
    const redisToken = process.env['KV_REST_API_TOKEN']
    if (!redisUrl || !redisToken) throw new Error('KV_REST_API_URL / KV_REST_API_TOKEN not set')
    const redis = new Redis({ url: redisUrl, token: redisToken })

    // 各カテゴリの key リスト → mget で一括取得
    const bodyKeys     = dates.map(d => `hae:body:${d}`)
    const sleepKeys    = dates.map(d => `hae:sleep:${d}`)
    const activityKeys = dates.map(d => `hae:activity:${d}`)

    const [rawBodies, rawSleeps, rawActs] = await Promise.all([
      redis.mget<StoredBody[]>(...bodyKeys),
      redis.mget<StoredSleep[]>(...sleepKeys),
      redis.mget<StoredActivity[]>(...activityKeys),
    ])

    const bodyRecords     = toBodyRecords(dates, rawBodies)
    const sleepRecords    = toSleepRecords(dates, rawSleeps)
    const activityRecords = toActivityRecords(dates, rawActs)

    console.log(`[health-data] body=${bodyRecords.length} sleep=${sleepRecords.length} activity=${activityRecords.length}`)

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ bodyRecords, sleepRecords, activityRecords }))
  } catch (e) {
    console.error('[health-data] error:', e)
    // KV 未設定でもアプリを壊さない
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ bodyRecords: [], sleepRecords: [], activityRecords: [], error: String(e) }))
  }
}

// ── Redis 保存型 ──────────────────────────────────────────────────────────────

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
  steps?:            number
  restingHeartRate?: number
}

// ── フロント向け型 ─────────────────────────────────────────────────────────────

interface HaeBodyRecord {
  id:                   string
  date:                 string
  weight?:              number
  bodyFatPct?:          number
  leanBodyMass?:        number
  estimatedMuscleMass?: number
  source:               'health_auto_export'
}
interface HaeSleepRecord {
  id:            string
  date:          string
  totalMinutes?: number
  deepMinutes?:  number
  remMinutes?:   number
  source:        'health_auto_export'
}
interface HaeActivityRecord {
  date:              string
  steps?:            number
  restingHeartRate?: number
}

// ── パーサー ──────────────────────────────────────────────────────────────────

function toBodyRecords(dates: string[], raw: (StoredBody | null)[]): HaeBodyRecord[] {
  return raw
    .map((v, i) => v == null ? null : { id: `hae-body-${dates[i]}`, date: dates[i], source: 'health_auto_export' as const, ...v })
    .filter((r): r is HaeBodyRecord => r !== null)
    .sort((a, b) => a.date.localeCompare(b.date))
}
function toSleepRecords(dates: string[], raw: (StoredSleep | null)[]): HaeSleepRecord[] {
  return raw
    .map((v, i) => v == null ? null : { id: `hae-sleep-${dates[i]}`, date: dates[i], source: 'health_auto_export' as const, ...v })
    .filter((r): r is HaeSleepRecord => r !== null)
    .sort((a, b) => a.date.localeCompare(b.date))
}
function toActivityRecords(dates: string[], raw: (StoredActivity | null)[]): HaeActivityRecord[] {
  return raw
    .map((v, i) => v == null ? null : { date: dates[i], ...v })
    .filter((r): r is HaeActivityRecord => r !== null)
    .sort((a, b) => a.date.localeCompare(b.date))
}
