import type { IncomingMessage, ServerResponse } from 'http'

/**
 * POST /api/withings-data
 * body (JSON): { access_token: string, refresh_token: string }
 *
 * Withings measure/getmeas を呼び出して体組成データを返す。
 * トークンが期限切れの場合は自動リフレッシュして再取得する。
 *
 * レスポンス:
 * {
 *   records: BodyRecord[],
 *   newTokens?: { access_token, refresh_token, expires_at }  // リフレッシュした場合のみ
 * }
 *
 * 環境変数:
 *   WITHINGS_CLIENT_ID
 *   WITHINGS_CLIENT_SECRET
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Method not allowed' }))
    return
  }

  // Parse request body
  let body: RequestBody
  try {
    const raw = await readBody(req)
    body = JSON.parse(raw) as RequestBody
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Invalid JSON body' }))
    return
  }

  const { access_token, refresh_token } = body
  if (!access_token || !refresh_token) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'access_token and refresh_token are required' }))
    return
  }

  const clientId     = process.env.WITHINGS_CLIENT_ID
  const clientSecret = process.env.WITHINGS_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Missing server environment variables' }))
    return
  }

  // Fetch data (auto-retry once after token refresh on 401)
  let currentToken = access_token
  let newTokens: NewTokens | undefined

  const result = await fetchMeasures(currentToken)

  if (result.status === 401 || result.status === 100) {
    // Token expired — refresh and retry
    const refreshed = await refreshToken(clientId, clientSecret, refresh_token)
    if (!refreshed) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Token refresh failed. Please reconnect Withings.' }))
      return
    }
    currentToken = refreshed.access_token
    newTokens = refreshed
    const retried = await fetchMeasures(currentToken)
    if (retried.status !== 0) {
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `Withings API error after refresh: ${retried.status}` }))
      return
    }
    const records = parseMeasures(retried.body?.measuregrps ?? [])
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ records, newTokens }))
    return
  }

  if (result.status !== 0) {
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: `Withings API error: ${result.status}` }))
    return
  }

  const records = parseMeasures(result.body?.measuregrps ?? [])
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ records }))
}

// ── 型定義 ───────────────────────────────────────────────────────────────────

interface RequestBody {
  access_token:  string
  refresh_token: string
}

interface NewTokens {
  access_token:  string
  refresh_token: string
  expires_at:    number
}

interface WithingsMeasure {
  value: number
  type:  number
  unit:  number
}

interface WithingsMeasureGrp {
  grpid:    number
  date:     number   // Unix timestamp
  measures: WithingsMeasure[]
}

interface WithingsMeasResponse {
  status: number
  body?: {
    measuregrps: WithingsMeasureGrp[]
  }
}

// measure type → field name mapping
const MEAS_TYPES: Record<number, string> = {
  1:   'weight',
  6:   'bodyFatPct',    // fat ratio %
  5:   'fatFreeMass',   // fat free mass kg
  8:   'fatMass',       // fat mass weight kg
  76:  'muscleMass',
  77:  'hydration',
  88:  'boneMass',
  170: 'fatMassFull',   // intracellular water / alt fat mass
}

const MEAS_TYPES_PARAM = [1, 5, 6, 8, 76, 77, 88, 170].join(',')

// ── Withings API helpers ──────────────────────────────────────────────────────

async function fetchMeasures(token: string): Promise<WithingsMeasResponse> {
  const params = new URLSearchParams({
    action:     'getmeas',
    meastypes:  MEAS_TYPES_PARAM,
    category:   '1',
    lastupdate: '0',
  })
  const url = `https://wbsapi.withings.net/measure?${params.toString()}`
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    })
    return await resp.json() as WithingsMeasResponse
  } catch {
    return { status: -1 }
  }
}

async function refreshToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<NewTokens | null> {
  try {
    const body = new URLSearchParams({
      action:        'requesttoken',
      grant_type:    'refresh_token',
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    })
    const resp = await fetch('https://wbsapi.withings.net/v2/oauth2', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
    })
    const json = await resp.json() as { status: number; body: { access_token: string; refresh_token: string; expires_in: number } }
    if (json.status !== 0) return null
    return {
      access_token:  json.body.access_token,
      refresh_token: json.body.refresh_token,
      expires_at:    Math.floor(Date.now() / 1000) + (json.body.expires_in ?? 10800),
    }
  } catch {
    return null
  }
}

// ── Measure parser ────────────────────────────────────────────────────────────

interface ParsedRecord {
  id:          string
  date:        string
  weight?:     number
  bodyFatPct?: number
  fatMass?:    number
  fatFreeMass?: number
  muscleMass?: number
  hydration?:  number
  boneMass?:   number
  bmi?:        number
  source:      'withings_csv'
}

function parseMeasures(grps: WithingsMeasureGrp[]): ParsedRecord[] {
  // Group by date (YYYY-MM-DD)
  const byDate: Record<string, Partial<ParsedRecord>> = {}

  for (const grp of grps) {
    const date = new Date(grp.date * 1000).toISOString().slice(0, 10)
    if (!byDate[date]) byDate[date] = { date, id: String(grp.date), source: 'withings_csv' }

    for (const m of grp.measures) {
      const actualValue = m.value * Math.pow(10, m.unit)
      const rounded     = Math.round(actualValue * 10) / 10
      const field       = MEAS_TYPES[m.type]
      if (!field) continue

      if (field === 'bodyFatPct') {
        // Withings returns fat_ratio as integer percentage (e.g., 150 = 15.0%)
        byDate[date][field] = rounded
      } else if (field !== 'fatMassFull') {
        (byDate[date] as Record<string, number>)[field] = rounded
      }
    }
  }

  // Calculate derived values
  const records: ParsedRecord[] = []
  for (const [_date, r] of Object.entries(byDate)) {
    const rec = r as ParsedRecord

    // Derive fatFreeMass if not present
    if (!rec.fatFreeMass && rec.weight != null && rec.fatMass != null) {
      rec.fatFreeMass = Math.round((rec.weight - rec.fatMass) * 10) / 10
    }

    records.push(rec)
  }

  return records.sort((a, b) => a.date.localeCompare(b.date))
}

// ── Request body reader ───────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => { data += chunk.toString() })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}
