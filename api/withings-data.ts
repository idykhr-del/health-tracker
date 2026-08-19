import type { IncomingMessage, ServerResponse } from 'http'
import { URL } from 'url'
import { Redis } from '@upstash/redis'
import {
  getValidAccessToken,
  readTokens,
  saveTokens,
  clearTokens,
  readAuthError,
  readLastSync,
} from '../lib/withings.js'

/**
 * /api/withings-data
 *
 * トークンはすべて Redis (`withings:tokens`) で管理する。
 * クライアントはトークンを一切送らず、一切受け取らない。
 *
 *   GET  /api/withings-data                  → 連携ステータス
 *   GET  /api/withings-data?action=status    → 同上
 *   POST /api/withings-data                  → Withings から取得して Redis に保存
 *   POST /api/withings-data?action=disconnect→ Redis のトークンを削除
 *   POST /api/withings-data?action=migrate   → 旧 localStorage トークンを Redis に seed
 *
 * status レスポンス:
 *   { connected: boolean, expires_at: number|null, last_sync: number|null, auth_error: string|null }
 *
 * sync レスポンス:
 *   200 { records: BodyRecord[], debug }
 *   401 { error: 'not_connected' }   … Redis にトークンが無い
 *   401 { error: 'reauth_required' } … refresh に失敗した（再連携が必要）
 *
 * Withings measure API リクエスト仕様:
 *   URL     : https://wbsapi.withings.net/measure
 *   Method  : POST
 *   Headers : Authorization: Bearer {token}
 *             Content-Type: application/x-www-form-urlencoded
 *   Body    : action=getmeas&meastype=1&meastype=6&...  (手動文字列・URLSearchParams不使用)
 */
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  const host   = req.headers.host ?? 'localhost'
  const url    = new URL(req.url ?? '/', `http://${host}`)
  const action = url.searchParams.get('action')

  const redisUrl   = process.env['KV_REST_API_URL']
  const redisToken = process.env['KV_REST_API_TOKEN']
  if (!redisUrl || !redisToken) {
    console.error('[withings-data] KV_REST_API_URL / KV_REST_API_TOKEN not set')
    return json(res, 500, { error: 'redis_not_configured' })
  }
  const redis = new Redis({ url: redisUrl, token: redisToken })

  if (req.method === 'GET' || action === 'status') return handleStatus(res, redis)
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' })
  if (action === 'disconnect') return handleDisconnect(res, redis)
  if (action === 'migrate')    return handleMigrate(req, res, redis)
  return handleSync(res, redis)
}

// ─────────────────────────────────────────────────────────────────────────────
// GET: 連携ステータス
// ─────────────────────────────────────────────────────────────────────────────

async function handleStatus(res: ServerResponse, redis: Redis) {
  const [tokens, authError, lastSync] = await Promise.all([
    readTokens(redis),
    readAuthError(redis),
    readLastSync(redis),
  ])
  return json(res, 200, {
    connected:  tokens !== null,
    expires_at: tokens?.expires_at ?? null,
    last_sync:  lastSync,
    auth_error: authError?.reason ?? null,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// POST ?action=disconnect: Redis のトークンを削除
// ─────────────────────────────────────────────────────────────────────────────

async function handleDisconnect(res: ServerResponse, redis: Redis) {
  await clearTokens(redis)
  console.log('[withings-data] disconnected: tokens removed from Redis')
  return json(res, 200, { ok: true })
}

// ─────────────────────────────────────────────────────────────────────────────
// POST ?action=migrate: 旧 localStorage トークンを Redis に seed（1回限りの移行用）
// ─────────────────────────────────────────────────────────────────────────────

async function handleMigrate(req: IncomingMessage, res: ServerResponse, redis: Redis) {
  let parsed: { access_token?: string; refresh_token?: string; expires_at?: number }
  try {
    parsed = JSON.parse(await readBody(req)) as typeof parsed
  } catch (e) {
    return json(res, 400, { error: 'invalid_body', detail: String(e) })
  }

  const { access_token, refresh_token } = parsed
  if (!access_token || !refresh_token) {
    return json(res, 400, { error: 'access_token / refresh_token are required' })
  }

  // 既に Redis 側にトークンがあればそちらが正。上書きしない。
  const existing = await readTokens(redis)
  if (existing) {
    console.log('[withings-data] migrate skipped: Redis already has tokens')
    return json(res, 200, { ok: true, seeded: false })
  }

  await saveTokens(redis, {
    access_token,
    refresh_token,
    expires_at: parsed.expires_at ?? Math.floor(Date.now() / 1000) + 10800,
  })
  console.log('[withings-data] migrate: legacy localStorage tokens seeded into Redis')
  return json(res, 200, { ok: true, seeded: true })
}

// ─────────────────────────────────────────────────────────────────────────────
// POST: Withings からデータ取得 → Redis へ保存
// ─────────────────────────────────────────────────────────────────────────────

async function handleSync(res: ServerResponse, redis: Redis) {
  const token = await getValidAccessToken(redis)
  if (!token) return unauthorized(res, redis)

  let result = await fetchAllPages(token)

  // 期限内のはずのトークンが弾かれた場合のみ、強制 refresh して1回だけ再試行する
  if (result.authError) {
    console.warn('[withings-data] auth error with stored token — forcing refresh')
    const forced = await getValidAccessToken(redis, { force: true })
    if (!forced) return unauthorized(res, redis)
    result = await fetchAllPages(forced)
    if (result.authError) {
      console.error('[withings-data] auth error persists after forced refresh')
      return json(res, 401, { error: 'reauth_required' })
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

  const grps = result.grps ?? []
  const { records, debug } = parseGroups(grps)

  console.log(`[withings-data] OK: records=${records.length} grps=${grps.length}`)
  console.log(`[withings-data] meastypeCounts:`, JSON.stringify(debug.meastypeCounts))

  // ── 直近60日分のデータと sync 時刻を Redis に保存（health-data.ts が読む）──────
  try {
    const ops: Promise<unknown>[] = []
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 60)
    const cutoffStr = cutoff.toISOString().slice(0, 10)
    for (const rec of records) {
      if (rec.date < cutoffStr) continue
      const stored = {
        weight:      rec.weight,
        bodyFatPct:  rec.bodyFatPct,
        fatMass:     rec.fatMass,
        fatFreeMass: rec.fatFreeMass,
        muscleMass:  rec.muscleMass,
        boneMass:    rec.boneMass,
      }
      ops.push(redis.set(`withings:body:${rec.date}`, JSON.stringify(stored), { ex: 60 * 60 * 24 * 90 }))
    }
    ops.push(redis.set('withings:sync:last', String(Date.now()), { ex: 60 * 60 * 24 * 30 }))
    await Promise.all(ops)
    console.log(`[withings-data] Redis: ${records.length} body records cached`)
  } catch (e) {
    console.warn('[withings-data] Redis cache failed (non-fatal):', e)
  }

  return json(res, 200, { records, debug })
}

/**
 * トークンが取れなかった理由を切り分けて 401 を返す。
 * refresh 失敗時はトークンを消さないので、「トークンが残っている＝refresh 失敗」で判別できる。
 */
async function unauthorized(res: ServerResponse, redis: Redis) {
  const [tokens, authError] = await Promise.all([readTokens(redis), readAuthError(redis)])
  if (!tokens) {
    console.log('[withings-data] 401 not_connected')
    return json(res, 401, { error: 'not_connected' })
  }
  console.warn(`[withings-data] 401 reauth_required (${authError?.reason ?? 'unknown'})`)
  return json(res, 401, { error: 'reauth_required', reason: authError?.reason ?? null })
}

// ─────────────────────────────────────────────────────────────────────────────
// 型定義
// ─────────────────────────────────────────────────────────────────────────────

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
// meastype → フィールド名マッピング（Withings公式仕様）
//   1  = weight       (体重, kg)
//   5  = fatFreeMass  (除脂肪体重, kg)
//   6  = bodyFatPct   (体脂肪率, %)
//   8  = fatMass      (体脂肪量, kg)
//   76 = muscleMass   (筋肉量, kg)
//   88 = boneMass     (骨量, kg)
//   77 = hydration    (水分量, kg)
//   170= visceralFat  (内臓脂肪指数)
// ─────────────────────────────────────────────────────────────────────────────

const MEAS_FIELD: Record<number, string> = {
  1:   'weight',
  5:   'fatFreeMass',
  6:   'bodyFatPct',
  8:   'fatMass',
  76:  'muscleMass',
  88:  'boneMass',
  77:  'hydration',
  170: 'visceralFat',
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
      console.warn(`[withings-data] page=${page + 1} HTTP=${httpStatus} withingsStatus=${data.status} (auth error)`)
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

    allGrps.push(...data.body.measuregrps)
    console.log(`[withings-data] page=${page + 1}: ${data.body.measuregrps.length} grps (total ${allGrps.length})`)

    if (!data.body.more) break
    offset = data.body.offset
  }

  return { grps: allGrps }
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
  fatMass?:     number     // 体脂肪量 (meastype 8)
  fatFreeMass?: number     // 除脂肪体重 (meastype 5)
  muscleMass?:  number     // 筋肉量・実測値 (meastype 76)
  boneMass?:    number     // 骨量 (meastype 88)
  visceralFat?: number     // 内臓脂肪指数 (meastype 170)
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

  grps.forEach(grp => {
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
  })

  // 同日複数セッション → フィールド数が最多のものを採用
  const byDate = new Map<string, { grpid: number; date: string; time: string; fields: Record<string, number> }>()
  for (const s of sessions.values()) {
    const existing = byDate.get(s.date)
    if (!existing || Object.keys(s.fields).length > Object.keys(existing.fields).length) {
      byDate.set(s.date, s)
    }
  }
  console.log(`[withings-data] unique dates: ${byDate.size}, sessions: ${sessions.size}`)

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
      fatMass:     s.fields['fatMass'],
      fatFreeMass: s.fields['fatFreeMass'],
      muscleMass:  s.fields['muscleMass'],   // 実測値 (meastype 76)
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
