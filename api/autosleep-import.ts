import type { IncomingMessage, ServerResponse } from 'http'

/**
 * POST /api/autosleep-import
 * body (JSON): { content: string, filename: string }
 *
 * JSONまたはCSVを自動判定してパースし、統一フォーマットで返す。
 *
 * レスポンス: { records: SleepRecord[] } | { error: string }
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Method not allowed' }))
    return
  }

  let body: { content: string; filename: string }
  try {
    const raw = await readBody(req)
    body = JSON.parse(raw) as { content: string; filename: string }
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'リクエストボディの解析に失敗しました' }))
    return
  }

  const { content, filename } = body
  if (!content || !filename) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'content と filename は必須です' }))
    return
  }

  try {
    const isJson = filename.toLowerCase().endsWith('.json')
    const records = isJson
      ? parseHealthAutoExportJSON(content)
      : parseAutoSleepCSV(content)

    if (!records.length) {
      res.writeHead(422, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'データが見つかりませんでした。ファイル形式を確認してください。' }))
      return
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ records }))
  } catch (e) {
    res.writeHead(422, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: `パースエラー: ${String(e)}` }))
  }
}

// ── 型定義（フロントエンドの SleepRecord と一致） ──────────────────────────

type SleepSource = 'autosleep_csv' | 'health_auto_export'

interface SleepRecord {
  id:             string
  date:           string
  bedtime?:       string
  waketime?:      string
  inBedMinutes?:  number
  asleepMinutes?: number
  awakeMinutes?:  number
  sleepScore?:    number
  quality?:       number
  deepMinutes?:   number
  remMinutes?:    number
  lightMinutes?:  number
  wakingBPM?:     number
  hrv?:           number
  spo2Avg?:       number
  spo2Min?:       number
  respAvg?:       number
  source:         SleepSource
}

// ── UUID生成 ─────────────────────────────────────────────────────────────────

function uuid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

// ── AutoSleep History Export CSV parser ──────────────────────────────────────
// ISO8601,Bedtime,Waketime,InBed,Asleep,Quality,SleepScore,
// Deep,Rem,Light,WakingBPM,HRV,SpO2Avg,SpO2Min,RespAvg

function hhmmssToMinutes(s: string): number {
  if (!s) return NaN
  const parts = s.split(':').map(Number)
  if (parts.length === 3) return parts[0] * 60 + parts[1] + Math.round(parts[2] / 60)
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return NaN
}

function parseAutoSleepCSV(text: string): SleepRecord[] {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) return []

  const records: SleepRecord[] = []

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim())
    if (cols.length < 5) continue

    const [iso8601, bedtime, waketime, inBed, asleep, quality, sleepScore,
           deep, rem, light, wakingBPM, hrv, spo2Avg, spo2Min, respAvg] = cols

    if (!iso8601) continue
    const date = iso8601.slice(0, 10)

    const inBedMin    = hhmmssToMinutes(inBed)
    const asleepMin   = hhmmssToMinutes(asleep)
    const deepMin     = hhmmssToMinutes(deep)
    const remMin      = hhmmssToMinutes(rem)
    const lightMin    = hhmmssToMinutes(light)
    const awakeMin    = !isNaN(inBedMin) && !isNaN(asleepMin) ? inBedMin - asleepMin : undefined

    records.push({
      id:             uuid(),
      date,
      bedtime:        bedtime  || undefined,
      waketime:       waketime || undefined,
      inBedMinutes:   isNaN(inBedMin)  ? undefined : inBedMin,
      asleepMinutes:  isNaN(asleepMin) ? undefined : asleepMin,
      awakeMinutes:   awakeMin,
      quality:        parseFloat(quality)    || undefined,
      sleepScore:     parseFloat(sleepScore) || undefined,
      deepMinutes:    isNaN(deepMin)  ? undefined : deepMin,
      remMinutes:     isNaN(remMin)   ? undefined : remMin,
      lightMinutes:   isNaN(lightMin) ? undefined : lightMin,
      wakingBPM:      parseFloat(wakingBPM) || undefined,
      hrv:            parseFloat(hrv)        || undefined,
      spo2Avg:        parseFloat(spo2Avg)    || undefined,
      spo2Min:        parseFloat(spo2Min)    || undefined,
      respAvg:        parseFloat(respAvg)    || undefined,
      source:         'autosleep_csv',
    })
  }

  return records
}

// ── Health Auto Export JSON parser ────────────────────────────────────────────

interface HaeDataPoint {
  date:        string
  inBedStart?: string
  inBedEnd?:   string
  inBed?:      number
  deep?:       number
  rem?:        number
  core?:       number
  awake?:      number
  sleepScore?: number
}

interface HaeRoot {
  data?: {
    metrics?: Array<{ name: string; data: HaeDataPoint[] }>
  }
}

function extractTime(s?: string): string | undefined {
  if (!s) return undefined
  const m = s.match(/\d{2}:\d{2}/)
  return m ? m[0] : undefined
}

function parseHealthAutoExportJSON(text: string): SleepRecord[] {
  let root: HaeRoot
  try { root = JSON.parse(text) as HaeRoot } catch { return [] }

  const metrics = root?.data?.metrics
  if (!Array.isArray(metrics)) return []

  const sleepMetric = metrics.find(m => m.name === 'sleep_analysis')
  if (!sleepMetric || !sleepMetric.data.length) return []

  return sleepMetric.data.map((d): SleepRecord => {
    const date          = d.date.slice(0, 10)
    const inBedMinutes  = d.inBed  != null ? Math.round(d.inBed  * 60) : undefined
    const deepMinutes   = d.deep   != null ? Math.round(d.deep   * 60) : undefined
    const remMinutes    = d.rem    != null ? Math.round(d.rem    * 60) : undefined
    const lightMinutes  = d.core   != null ? Math.round(d.core   * 60) : undefined
    const awakeMinutes  = d.awake  != null ? Math.round(d.awake  * 60) : undefined
    const asleepMinutes = inBedMinutes != null && awakeMinutes != null
      ? inBedMinutes - awakeMinutes : undefined

    return {
      id:             uuid(),
      date,
      bedtime:        extractTime(d.inBedStart),
      waketime:       extractTime(d.inBedEnd),
      inBedMinutes,
      asleepMinutes,
      awakeMinutes,
      deepMinutes,
      remMinutes,
      lightMinutes,
      sleepScore:     d.sleepScore,
      source:         'health_auto_export',
    }
  })
}

// ── Request body reader ───────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => { data += chunk.toString() })
    req.on('end',  () => resolve(data))
    req.on('error', reject)
  })
}
