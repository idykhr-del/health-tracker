import type { IncomingMessage, ServerResponse } from 'http'

/**
 * POST /api/withings-data
 * body (JSON): { access_token: string, refresh_token: string }
 *
 * Withings measure/getmeas を呼び出して体組成データを返す。
 * - 取得期間: 過去365日
 * - ページネーション対応（more=1 の間ループ）
 * - measuregrp ごとに全計測値をまとめて1レコードに変換
 * - トークン期限切れ時は自動リフレッシュ
 *
 * レスポンス: { records: BodyRecord[], newTokens? }
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    return json(res, 405, { error: 'Method not allowed' })
  }

  let body: RequestBody
  try {
    body = JSON.parse(await readBody(req)) as RequestBody
  } catch {
    return json(res, 400, { error: 'Invalid JSON body' })
  }

  const { access_token, refresh_token } = body
  if (!access_token || !refresh_token) {
    return json(res, 400, { error: 'access_token and refresh_token are required' })
  }

  const clientId     = process.env.WITHINGS_CLIENT_ID
  const clientSecret = process.env.WITHINGS_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    return json(res, 500, { error: 'Missing server environment variables' })
  }

  let currentToken = access_token
  let newTokens: NewTokens | undefined

  // Fetch (auto-refresh once on auth error)
  let grps = await fetchAllMeasures(currentToken)

  if (grps === null) {
    // Token error — try refresh
    const refreshed = await doRefreshToken(clientId, clientSecret, refresh_token)
    if (!refreshed) return json(res, 401, { error: 'Token refresh failed. Please reconnect Withings.' })
    currentToken = refreshed.access_token
    newTokens    = refreshed
    grps         = await fetchAllMeasures(currentToken)
    if (grps === null) return json(res, 502, { error: 'Withings API error after token refresh' })
  }

  const records = parseMeasureGroups(grps)
  console.log(`[withings-data] Returning ${records.length} records`)
  return json(res, 200, { records, ...(newTokens ? { newTokens } : {}) })
}

// ── 型定義 ───────────────────────────────────────────────────────────────────

interface RequestBody { access_token: string; refresh_token: string }

interface NewTokens { access_token: string; refresh_token: string; expires_at: number }

interface WithingsMeasure { value: number; type: number; unit: number }

interface WithingsMeasureGrp {
  grpid:    number
  date:     number   // Unix timestamp (UTC)
  measures: WithingsMeasure[]
}

interface WithingsMeasBody {
  measuregrps: WithingsMeasureGrp[]
  more:        number   // 1 = has next page
  offset:      number   // next page offset
}

interface WithingsMeasResponse { status: number; body?: WithingsMeasBody }

// ── meastype → フィールド名マッピング ────────────────────────────────────────
// Withings Body Smart 実機で確認した値に基づく（ユーザー指定）

const MEAS_FIELD: Record<number, string> = {
  1:   'weight',
  6:   'bodyFatPct',
  8:   'muscleMass',
  73:  'bmi',
  76:  'fatFreeMass',
  77:  'hydration',
  88:  'boneMass',
  170: 'visceralFat',
  226: 'bmr',
  227: 'metabolicAge',
}

const MEAS_TYPES_PARAM = Object.keys(MEAS_FIELD).join(',')

// ── Withings API: ページネーションを含む全件取得 ──────────────────────────────

/**
 * null を返したとき = 認証エラー（トークン再取得が必要）
 */
async function fetchAllMeasures(token: string): Promise<WithingsMeasureGrp[] | null> {
  const startdate = Math.floor(Date.now() / 1000) - 365 * 24 * 3600  // 1年前
  const allGrps: WithingsMeasureGrp[] = []
  let offset = 0

  for (let page = 0; page < 20; page++) {  // 安全上限 20ページ
    const params = new URLSearchParams({
      action:     'getmeas',
      meastypes:  MEAS_TYPES_PARAM,
      category:   '1',
      startdate:  String(startdate),
      offset:     String(offset),
    })

    let data: WithingsMeasResponse
    try {
      const resp = await fetch(`https://wbsapi.withings.net/measure?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      data = await resp.json() as WithingsMeasResponse
    } catch {
      return null
    }

    // 認証エラー
    if (data.status === 401 || data.status === 100) return null
    if (data.status !== 0 || !data.body) {
      console.error('[withings-data] API error status:', data.status)
      return null
    }

    allGrps.push(...data.body.measuregrps)
    console.log(`[withings-data] page ${page + 1}: got ${data.body.measuregrps.length} grps (total ${allGrps.length})`)

    if (!data.body.more) break
    offset = data.body.offset
  }

  return allGrps
}

// ── トークンリフレッシュ ──────────────────────────────────────────────────────

async function doRefreshToken(
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
    const data = await resp.json() as {
      status: number
      body: { access_token: string; refresh_token: string; expires_in: number }
    }
    if (data.status !== 0) return null
    return {
      access_token:  data.body.access_token,
      refresh_token: data.body.refresh_token,
      expires_at:    Math.floor(Date.now() / 1000) + (data.body.expires_in ?? 10800),
    }
  } catch { return null }
}

// ── パーサー ──────────────────────────────────────────────────────────────────

interface ParsedRecord {
  id:            string
  date:          string
  time?:         string
  weight:        number
  bodyFatPct?:   number
  muscleMass?:   number
  fatFreeMass?:  number
  hydration?:    number
  boneMass?:     number
  bmi?:          number
  visceralFat?:  number
  bmr?:          number
  metabolicAge?: number
  source:        'withings_csv'
}

/**
 * measuregrp ごとに全フィールドをまとめて ParsedRecord に変換する。
 * 同じ日に複数の計測がある場合はフィールド数が最も多いものを採用。
 */
function parseMeasureGroups(grps: WithingsMeasureGrp[]): ParsedRecord[] {
  // grpid → セッションデータ
  const sessions = new Map<number, {
    grpid:  number
    date:   string
    time:   string
    fields: Partial<Record<string, number>>
  }>()

  for (const grp of grps) {
    // UTC → JST(+09:00) で日付文字列を作る
    const jstMs = grp.date * 1000 + 9 * 3600 * 1000
    const jstIso = new Date(jstMs).toISOString()
    const date   = jstIso.slice(0, 10)   // YYYY-MM-DD
    const time   = jstIso.slice(11, 16)  // HH:MM

    const fields: Partial<Record<string, number>> = {}
    for (const m of grp.measures) {
      const field = MEAS_FIELD[m.type]
      if (!field) continue
      const actual  = m.value * Math.pow(10, m.unit)
      fields[field] = Math.round(actual * 10) / 10
    }

    sessions.set(grp.grpid, { grpid: grp.grpid, date, time, fields })
  }

  // 同日複数セッション → フィールド数が最も多いものを採用
  const byDate = new Map<string, typeof sessions extends Map<unknown, infer V> ? V : never>()
  for (const s of sessions.values()) {
    const existing = byDate.get(s.date)
    if (!existing || Object.keys(s.fields).length > Object.keys(existing.fields).length) {
      byDate.set(s.date, s)
    }
  }

  const records: ParsedRecord[] = []
  for (const s of byDate.values()) {
    if (s.fields['weight'] == null) continue  // 体重のない記録は除外
    records.push({
      id:           String(s.grpid),
      date:         s.date,
      time:         s.time,
      source:       'withings_csv',
      weight:       s.fields['weight'],
      bodyFatPct:   s.fields['bodyFatPct'],
      muscleMass:   s.fields['muscleMass'],
      fatFreeMass:  s.fields['fatFreeMass'],
      hydration:    s.fields['hydration'],
      boneMass:     s.fields['boneMass'],
      bmi:          s.fields['bmi'],
      visceralFat:  s.fields['visceralFat'],
      bmr:          s.fields['bmr'],
      metabolicAge: s.fields['metabolicAge'],
    })
  }

  return records.sort((a, b) => a.date.localeCompare(b.date))
}

// ── ユーティリティ ────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: object) {
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
