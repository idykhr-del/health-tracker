import type { IncomingMessage, ServerResponse } from 'http'
import { kv } from '@vercel/kv'

/**
 * GET /api/health-data
 *
 * Vercel KV に保存された Health Auto Export データを取得して返す。
 * フロントエンドが起動時に呼び出し、Withings データとマージして表示する。
 *
 * レスポンス:
 *   { bodyRecords: BodyRecord[], sleepRecords: SleepRecord[] }
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

  try {
    // KV から全レコードを取得（hgetall は hash の全フィールドを返す）
    const [rawBody, rawSleep] = await Promise.all([
      kv.hgetall<Record<string, string>>('hae:body'),
      kv.hgetall<Record<string, string>>('hae:sleep'),
    ])

    const bodyRecords  = parseBodyHash(rawBody)
    const sleepRecords = parseSleepHash(rawSleep)

    console.log(`[health-data] GET body=${bodyRecords.length} sleep=${sleepRecords.length}`)

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ bodyRecords, sleepRecords }))
  } catch (e) {
    console.error('[health-data] KV error:', e)
    // KV が未設定の場合は空配列を返す（アプリを壊さない）
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ bodyRecords: [], sleepRecords: [], error: String(e) }))
  }
}

// ── 型（フロントエンドの BodyRecord / SleepRecord に合わせる） ─────────────────

interface BodyRecord {
  id:          string
  date:        string
  weight?:     number
  bodyFatPct?: number
  source:      'health_auto_export'
}

interface SleepRecord {
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

// ── パーサー ──────────────────────────────────────────────────────────────────

function parseBodyHash(hash: Record<string, string> | null): BodyRecord[] {
  if (!hash) return []
  return Object.values(hash)
    .map(v => {
      try { return JSON.parse(typeof v === 'string' ? v : JSON.stringify(v)) as BodyRecord }
      catch { return null }
    })
    .filter((r): r is BodyRecord => r !== null && !!r.date)
    .sort((a, b) => a.date.localeCompare(b.date))
}

function parseSleepHash(hash: Record<string, string> | null): SleepRecord[] {
  if (!hash) return []
  return Object.values(hash)
    .map(v => {
      try { return JSON.parse(typeof v === 'string' ? v : JSON.stringify(v)) as SleepRecord }
      catch { return null }
    })
    .filter((r): r is SleepRecord => r !== null && !!r.date)
    .sort((a, b) => a.date.localeCompare(b.date))
}
