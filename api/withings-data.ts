import type { IncomingMessage, ServerResponse } from 'http'

/**
 * POST /api/withings-data
 * body (JSON): { access_token: string, refresh_token?: string }
 *
 * Withings measure API から体組成データを取得する。
 *
 * リクエスト仕様:
 *   URL     : https://wbsapi.withings.net/measure
 *   Method  : POST
 *   Headers : Authorization: Bearer {token}
 *             Content-Type: application/x-www-form-urlencoded
 *   Body    : action=getmeas&meastype=1&meastype=6&...  (手動文字列・URLSearchParams不使用)
 *   category: 省略（全カテゴリ）
 *   startdate: 省略（全期間）
 *
 * meastype マッピング:
 *   1  → weight     (kg)
 *   6  → bodyFatPct (%)
 *   8  → muscleMass (kg)
 *   76 → boneMass   (kg)
 *   88 → visceralFat (指数)
 *   77 → hydration   (%)
 *
 * レスポンス: { records: BodyRecord[], debug, newTokens? }
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  if (req.method !== 'POST')   { return json(res, 405, { error: 'Method not allowed' }) }

  // ── ① リクエストボディ取得 ────────────────────────────────────────────────
  let rawBody = ''
  try { rawBody = await readBody(req) }
  catch (e) { return json(res, 400, { error: 'readBody failed', detail: String(e) }) }

  let parsed: { access_token?: string; refresh_token?: string }
  try { parsed = JSON.parse(rawBody) }
  catch (e) { return json(res, 400, { error: 'JSON parse failed', detail: String(e) }) }

  const { access_token, refresh_token } = parsed
  if (!access_token) {
    return json(res, 400, { error: 'access_token is required' })
  }

  const clientId     = process.env.WITHINGS_CLIENT_ID
  const clientSecret = process.env.WITHINGS_CLIENT_SECRET

  // ── ② データ取得（トークンエラー時は1回だけリフレッシュ） ─────────────────
  let currentToken = access_token
  let newTokens: NewTokens | undefined

  let result = await fetchAllPages(currentToken)

  if (result.authError) {
    if (!clientId || !clientSecret || !refresh_token) {
      return json(res, 401, { error: 'Token expired. Please reconnect Withings.' })
    }
    const refreshed = await refreshAccessToken(clientId, clientSecret, refresh_token)
    if (!refreshed) {
      return json(res, 401, { error: 'Token refresh failed. Please reconnect Withings.' })
    }
    currentToken = refreshed.access_token
    newTokens    = refreshed
    result       = await fetchAllPages(currentToken)
    if (result.authError) {
      return json(res, 502, { error: 'Withings auth error after token refresh' })
    }
  }

  if (result.error) {
    return json(res, 502, {
      error:          result.error,
      withingsStatus: result.withingsStatus,
      requestBody:    result.requestBody,
      rawSample:      result.rawSample,
    })
  }

  // ── ③ パース & レスポンス ──────────────────────────────────────────────────
  const grps = result.grps ?? []
  const { records, debug } = parseGroups(grps)

  console.log(`[withings-data] OK: records=${records.length} grps=${grps.length}`)
  console.log(`[withings-data] meastypeCounts:`, JSON.stringify(debug.meastypeCounts))

  return json(res, 200, {
    records,
    debug,
    ...(newTokens ? { newTokens } : {}),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 型定義
// ─────────────────────────────────────────────────────────────────────────────

interface NewTokens {
  access_token:  string
  refresh_token: string
  expires_at:    number
}

interface WithingsMeasure    { value: number; type: number; unit: number }
interface WithingsMeasureGrp { grpid: number; date: number; measures: WithingsMeasure[] }
interface WithingsMeasBody   { measuregrps: WithingsMeasureGrp[]; more: number; offset: number }
interface WithingsMeasResponse { status: number; body?: WithingsMeasBody }

interface FetchResult {
  grps?:          WithingsMeasureGrp[]
  authError?:     boolean
  error?:         string
  withingsStatus?: number
  requestBody?:   string
  rawSample?:     string
}

// ─────────────────────────────────────────────────────────────────────────────
// meastype → フィールド名マッピング
//   1  = weight     (体重, kg)
//   6  = bodyFatPct (体脂肪率, %)
//   8  = muscleMass (筋肉量, kg)
//   76 = boneMass   (骨量, kg)
//   88 = visceralFat (内臓脂肪指数)
//   77 = hydration   (水分量, %)
// ─────────────────────────────────────────────────────────────────────────────

const MEAS_FIELD: Record<number, string> = {
  1:  'weight',
  6:  'bodyFatPct',
  8:  'muscleMass',
  76: 'boneMass',
  88: 'visceralFat',
  77: 'hydration',
}

// ─────────────────────────────────────────────────────────────────────────────
// Withings API 呼び出し（全ページ取得）
// ─────────────────────────────────────────────────────────────────────────────

async function fetchAllPages(token: string): Promise<FetchResult> {
  const allGrps: WithingsMeasureGrp[] = []
  let offset = 0

  // meastype を "&meastype=N" 形式で手動結合
  const measTypeParts = Object.keys(MEAS_FIELD)
    .map(t => `meastype=${t}`)
    .join('&')

  for (let page = 0; page < 20; page++) {
    // ボディ文字列を手動構築（URLSearchParams/JSON.stringify は使わない）
    const bodyStr = `action=getmeas&${measTypeParts}&offset=${offset}`

    console.log(`[withings-data] page=${page + 1} body="${bodyStr}"`)

    let rawText = ''
    let httpStatus = 0
    try {
      const resp = await fetch('https://wbsapi.withings.net/measure', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type':  'application/x-www-form-urlencoded',
        },
        body: bodyStr,
      })
      httpStatus = resp.status
      rawText    = await resp.text()
    } catch (e) {
      return { error: `Network error: ${String(e)}`, requestBody: bodyStr }
    }

    console.log(`[withings-data] page=${page + 1} HTTP=${httpStatus} raw="${rawText.slice(0, 200)}"`)

    let data: WithingsMeasResponse
    try {
      data = JSON.parse(rawText) as WithingsMeasResponse
    } catch (e) {
      return {
        error:       `JSON parse failed: ${String(e)}`,
        requestBody: bodyStr,
        rawSample:   rawText.slice(0, 300),
      }
    }

    // 認証エラー
    if ([100, 101, 102, 401].includes(data.status)) {
      return { authError: true, requestBody: bodyStr }
    }
    if (data.status !== 0 || !data.body) {
      return {
        error:          `Withings returned status=${data.status}`,
        withingsStatus: data.status,
        requestBody:    bodyStr,
        rawSample:      rawText.slice(0, 300),
      }
    }

    // 各 grp の measures を全出力（type / value / unit）
    data.body.measuregrps.forEach((grp, i) => {
      const mStr = grp.measures
        .map(m => `{type:${m.type},value:${m.value},unit:${m.unit}}`)
        .join(', ')
      console.log(`[withings-data] grp[${i}] date=${grp.date} grpid=${grp.grpid} measures=[${mStr}]`)
    })

    allGrps.push(...data.body.measuregrps)
    console.log(`[withings-data] page=${page + 1}: ${data.body.measuregrps.length} grps (total ${allGrps.length})`)

    if (!data.body.more) break
    offset = data.body.offset
  }

  return { grps: allGrps }
}

// ─────────────────────────────────────────────────────────────────────────────
// トークンリフレッシュ
// ─────────────────────────────────────────────────────────────────────────────

async function refreshAccessToken(
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
      body:   { access_token: string; refresh_token: string; expires_in: number }
    }
    if (data.status !== 0) return null
    return {
      access_token:  data.body.access_token,
      refresh_token: data.body.refresh_token,
      expires_at:    Math.floor(Date.now() / 1000) + (data.body.expires_in ?? 10800),
    }
  } catch { return null }
}

// ─────────────────────────────────────────────────────────────────────────────
// パーサー
// ─────────────────────────────────────────────────────────────────────────────

interface BodyRecord {
  id:           string
  date:         string
  time?:        string
  weight:       number
  bodyFatPct?:  number
  muscleMass?:  number
  boneMass?:    number
  visceralFat?: number
  hydration?:   number
  source:       'withings'
}

interface ParseResult {
  records: BodyRecord[]
  debug: {
    totalGrps:       number
    totalSessions:   number
    recordsReturned: number
    meastypesFound:  number[]
    meastypeCounts:  Record<number, number>
    firstRecord:     Partial<BodyRecord> | null
    latestRecord:    Partial<BodyRecord> | null
  }
}

function parseGroups(grps: WithingsMeasureGrp[]): ParseResult {
  // meastype 出現集計
  const meastypeCounts: Record<number, number> = {}
  for (const grp of grps) {
    for (const m of grp.measures) {
      meastypeCounts[m.type] = (meastypeCounts[m.type] ?? 0) + 1
    }
  }
  const meastypesFound = Object.keys(meastypeCounts).map(Number).sort((a, b) => a - b)

  // grpid → セッション
  const sessions = new Map<number, {
    grpid:  number
    date:   string
    time:   string
    fields: Record<string, number>
  }>()

  for (const grp of grps) {
    // UTC → JST (+9h)
    const jstMs  = grp.date * 1000 + 9 * 3600 * 1000
    const jstIso = new Date(jstMs).toISOString()
    const date   = jstIso.slice(0, 10)   // YYYY-MM-DD
    const time   = jstIso.slice(11, 16)  // HH:MM

    const fields: Record<string, number> = {}
    for (const m of grp.measures) {
      const field = MEAS_FIELD[m.type]
      if (!field) continue
      // 実際の値 = value × 10^unit
      fields[field] = Math.round(m.value * Math.pow(10, m.unit) * 100) / 100
    }

    sessions.set(grp.grpid, { grpid: grp.grpid, date, time, fields })
  }

  // 同日複数セッション → フィールド数が最多のものを採用
  const byDate = new Map<string, { grpid: number; date: string; time: string; fields: Record<string, number> }>()
  for (const s of sessions.values()) {
    const existing = byDate.get(s.date)
    if (!existing || Object.keys(s.fields).length > Object.keys(existing.fields).length) {
      byDate.set(s.date, s)
    }
  }

  // BodyRecord 配列に変換
  const records: BodyRecord[] = []
  for (const s of byDate.values()) {
    if (s.fields['weight'] == null) continue  // 体重なしは除外
    records.push({
      id:          String(s.grpid),
      date:        s.date,
      time:        s.time,
      source:      'withings',
      weight:      s.fields['weight'],
      bodyFatPct:  s.fields['bodyFatPct'],
      muscleMass:  s.fields['muscleMass'],
      boneMass:    s.fields['boneMass'],
      visceralFat: s.fields['visceralFat'],
      hydration:   s.fields['hydration'],
    })
  }

  records.sort((a, b) => a.date.localeCompare(b.date))

  return {
    records,
    debug: {
      totalGrps:       grps.length,
      totalSessions:   sessions.size,
      recordsReturned: records.length,
      meastypesFound,
      meastypeCounts,
      firstRecord:  records.length > 0 ? records[0]                  : null,
      latestRecord: records.length > 0 ? records[records.length - 1] : null,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ユーティリティ
// ─────────────────────────────────────────────────────────────────────────────

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
