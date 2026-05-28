import type { IncomingMessage, ServerResponse } from 'http'

/**
 * POST /api/withings-data
 * body: { access_token: string, refresh_token?: string }
 *
 * Withings v2/measure?action=getmeas を呼び出して体組成データを返す。
 * - startdate なし（全期間）
 * - ページネーション対応
 * - measuregrp ごとに全計測値をまとめて1レコードに変換
 * - トークン期限切れ時は自動リフレッシュ
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  if (req.method !== 'POST')   { return json(res, 405, { error: 'Method not allowed' }) }

  // ── ① ボディ取得 ──────────────────────────────────────────────────────────
  let rawBody = ''
  try { rawBody = await readBody(req) }
  catch (e) { return json(res, 400, { step: 'readBody', error: String(e) }) }

  let parsedBody: { access_token?: string; refresh_token?: string }
  try { parsedBody = JSON.parse(rawBody) }
  catch (e) { return json(res, 400, { step: 'parseBody', error: String(e), rawBody }) }

  const { access_token, refresh_token } = parsedBody
  if (!access_token) {
    return json(res, 400, { step: 'validateToken', error: 'access_token is required' })
  }

  const clientId     = process.env.WITHINGS_CLIENT_ID
  const clientSecret = process.env.WITHINGS_CLIENT_SECRET

  // ── ② Withings API 呼び出し（ページネーション） ───────────────────────────
  let currentToken = access_token
  let newTokens: NewTokens | undefined

  let fetchResult = await fetchAllMeasures(currentToken)

  // 認証エラー時はリフレッシュを試みる
  if (fetchResult.authError) {
    if (!clientId || !clientSecret || !refresh_token) {
      return json(res, 401, { error: 'Token expired. Please reconnect Withings.' })
    }
    const refreshed = await doRefreshToken(clientId, clientSecret, refresh_token)
    if (!refreshed) return json(res, 401, { error: 'Token refresh failed. Please reconnect Withings.' })
    currentToken = refreshed.access_token
    newTokens    = refreshed
    fetchResult  = await fetchAllMeasures(currentToken)
    if (fetchResult.authError) return json(res, 502, { error: 'Withings API error after token refresh' })
  }

  if (fetchResult.apiError) {
    return json(res, 502, {
      error:      'Withings API error',
      detail:     fetchResult.apiError,
      apiStatus:  fetchResult.apiStatus,
      rawSample:  fetchResult.rawSample,
    })
  }

  // ── ③ パース ──────────────────────────────────────────────────────────────
  const grps    = fetchResult.grps ?? []
  const parsed  = parseMeasureGroups(grps)
  const records = parsed.records
  const debug   = parsed.debug

  console.log(`[withings-data] records=${records.length} grps=${grps.length}`)
  console.log(`[withings-data] meastypesFound:`, debug.meastypesFound)
  console.log(`[withings-data] firstRecord:`, JSON.stringify(records[0] ?? null))

  return json(res, 200, {
    records,
    debug,
    ...(newTokens ? { newTokens } : {}),
  })
}

// ── 型定義 ────────────────────────────────────────────────────────────────────

interface NewTokens { access_token: string; refresh_token: string; expires_at: number }

interface WithingsMeasure    { value: number; type: number; unit: number }
interface WithingsMeasureGrp { grpid: number; date: number; measures: WithingsMeasure[] }
interface WithingsMeasBody   { measuregrps: WithingsMeasureGrp[]; more: number; offset: number }
interface WithingsMeasResponse { status: number; body?: WithingsMeasBody }

interface FetchResult {
  grps?:      WithingsMeasureGrp[]
  authError?: boolean
  apiError?:  string
  apiStatus?: number
  rawSample?: string  // デバッグ用: 生レスポンスの先頭300文字
}

// ── meastype → フィールド名 ───────────────────────────────────────────────────

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

// ── Withings API 呼び出し（全ページ） ────────────────────────────────────────

async function fetchAllMeasures(token: string): Promise<FetchResult> {
  const allGrps: WithingsMeasureGrp[] = []
  let offset = 0

  for (let page = 0; page < 20; page++) {
    // URLSearchParams はカンマを %2C にエンコードするため手動結合
    // meastype を個別に指定（meastypes ではなく meastype）
    const measTypeParams = Object.keys(MEAS_FIELD)
      .map(t => `meastype=${t}`)
      .join('&')

    const url = `https://wbsapi.withings.net/v2/measure`
      + `?action=getmeas`
      + `&${measTypeParams}`
      + `&category=1`
      + `&offset=${offset}`
      // startdate は除去（全期間取得）

    let rawText = ''
    try {
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      })
      rawText = await resp.text()
    } catch (e) {
      return { apiError: `Network error: ${String(e)}` }
    }

    console.log(`[withings-data] page ${page + 1} raw(200): ${rawText.slice(0, 200)}`)

    let data: WithingsMeasResponse
    try {
      data = JSON.parse(rawText) as WithingsMeasResponse
    } catch (e) {
      return {
        apiError:  `JSON parse failed: ${String(e)}`,
        rawSample: rawText.slice(0, 300),
      }
    }

    if (data.status === 401 || data.status === 100) return { authError: true }
    if (data.status !== 0 || !data.body) {
      return {
        apiError:  `Withings status=${data.status}`,
        apiStatus: data.status,
        rawSample: rawText.slice(0, 300),
      }
    }

    allGrps.push(...data.body.measuregrps)
    console.log(`[withings-data] page ${page + 1}: ${data.body.measuregrps.length} grps (total ${allGrps.length})`)

    if (!data.body.more) break
    offset = data.body.offset
  }

  return { grps: allGrps }
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
  source:        'withings'
}

interface ParseResult {
  records: ParsedRecord[]
  debug: {
    totalGrps:       number
    totalSessions:   number
    recordsReturned: number
    meastypesFound:  number[]
    meastypeCounts:  Record<number, number>
    firstRecord:     Partial<ParsedRecord> | null
    latestRecord:    Partial<ParsedRecord> | null
  }
}

function parseMeasureGroups(grps: WithingsMeasureGrp[]): ParseResult {
  // meastype の出現集計（デバッグ用）
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
    // UTC → JST (+9h) で日付文字列
    const jstMs  = grp.date * 1000 + 9 * 3600 * 1000
    const jstIso = new Date(jstMs).toISOString()
    const date   = jstIso.slice(0, 10)   // YYYY-MM-DD
    const time   = jstIso.slice(11, 16)  // HH:MM

    const fields: Record<string, number> = {}
    for (const m of grp.measures) {
      const field = MEAS_FIELD[m.type]
      if (!field) continue
      // 実際の値 = value * 10^unit
      const actual = m.value * Math.pow(10, m.unit)
      fields[field] = Math.round(actual * 100) / 100  // 小数2桁で丸め
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

  const records: ParsedRecord[] = []
  for (const s of byDate.values()) {
    if (s.fields['weight'] == null) continue   // 体重のない記録は除外
    records.push({
      id:           String(s.grpid),
      date:         s.date,
      time:         s.time,
      source:       'withings',
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

  // 日付昇順でソート
  records.sort((a, b) => a.date.localeCompare(b.date))

  return {
    records,
    debug: {
      totalGrps:       grps.length,
      totalSessions:   sessions.size,
      recordsReturned: records.length,
      meastypesFound,
      meastypeCounts,
      firstRecord:     records.length > 0 ? records[0]                     : null,
      latestRecord:    records.length > 0 ? records[records.length - 1]    : null,
    },
  }
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
