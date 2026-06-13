import type { IncomingMessage, ServerResponse } from 'http'
import { Redis } from '@upstash/redis'

/**
 * GET /api/health-data
 *
 * Redis から直近7日分のデータを返す。
 * Withings 体組成データ優先、HAE（Health Auto Export）をフォールバックとして使用。
 *
 * 【取得トリガー方針】(b) on-demand + 3時間キャッシュ を採用。
 *   - Vercel Cron は Pro プラン要件 & vercel.json 変更が必要で複雑。
 *   - on-demand なら毎朝初回リクエスト時（8時台）に自動 sync が走り、
 *     以降 3h はキャッシュ済みデータを返すため朝のブリーフィングに間に合う。
 *   - 通常の sync は 1〜2秒で完了するため UX への影響は許容範囲。
 *
 * Redis キー:
 *   withings:tokens            → { access_token, refresh_token, expires_at }
 *   withings:sync:last         → Unix ms (最終 Withings sync 時刻)
 *   withings:body:YYYY-MM-DD   → WithingsStoredBody
 *   hae:body:YYYY-MM-DD        → StoredBody (Health Auto Export)
 *   hae:sleep:YYYY-MM-DD       → StoredSleep
 *   hae:activity:YYYY-MM-DD    → StoredActivity
 *   autosleep:sleep:YYYY-MM-DD → AutoSleepStored (Shortcuts 経由)
 *
 * レスポンス:
 * {
 *   bodyRecords:        MergedBodyRecord[]
 *   sleepRecords:       MergedSleepRecord[]
 *   activityRecords:    HaeActivityRecord[]
 *   sleepStartHistory:  number[]
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
    const d = new Date(); d.setDate(d.getDate() - i)
    return d.toISOString().slice(0, 10)
  })
  // 睡眠一貫性スコア用: 直近14日
  const dates14 = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(); d.setDate(d.getDate() - i)
    return d.toISOString().slice(0, 10)
  })

  try {
    const redisUrl   = process.env['KV_REST_API_URL']
    const redisToken = process.env['KV_REST_API_TOKEN']
    if (!redisUrl || !redisToken) throw new Error('KV_REST_API_URL / KV_REST_API_TOKEN not set')
    const redis = new Redis({ url: redisUrl, token: redisToken })

    // ── ① Withings on-demand sync（3h キャッシュ）─────────────────────────────
    await syncWithingsIfStale(redis)

    // ── ② 全データを並列取得 ───────────────────────────────────────────────────
    const withingsKeys    = dates.map(d => `withings:body:${d}`)
    const haeBodyKeys     = dates.map(d => `hae:body:${d}`)
    const sleepKeys       = dates.map(d => `hae:sleep:${d}`)
    const actKeys         = dates.map(d => `hae:activity:${d}`)
    const asKeys          = dates.map(d => `autosleep:sleep:${d}`)   // AutoSleep Shortcuts
    const sleep14Keys     = dates14.map(d => `hae:sleep:${d}`)
    const asSleep14Keys   = dates14.map(d => `autosleep:sleep:${d}`) // 就寝一貫性スコア用

    const [rawWithings, rawHaeBodies, rawSleeps, rawActs, rawAs, rawSleeps14, rawAs14] = await Promise.all([
      redis.mget<WithingsStoredBody[]>(...withingsKeys),
      redis.mget<StoredBody[]>(...haeBodyKeys),
      redis.mget<StoredSleep[]>(...sleepKeys),
      redis.mget<StoredActivity[]>(...actKeys),
      redis.mget<AutoSleepStored[]>(...asKeys),
      redis.mget<StoredSleep[]>(...sleep14Keys),
      redis.mget<AutoSleepStored[]>(...asSleep14Keys),
    ])

    // ── ③ マージ ─────────────────────────────────────────────────────────────────
    const bodyRecords = dates
      .map((date, i) => mergeBodyRecord(date, rawWithings[i], rawHaeBodies[i]))
      .filter((r): r is MergedBodyRecord => r !== null)
      .sort((a, b) => a.date.localeCompare(b.date))

    // 睡眠: AutoSleep Shortcuts 優先、HAE フォールバック
    const sleepRecords = dates
      .map((date, i) => mergeSleepRecord(date, rawAs[i], rawSleeps[i]))
      .filter((r): r is MergedSleepRecord => r !== null)
      .sort((a, b) => a.date.localeCompare(b.date))

    const activityRecords = toActivityRecords(dates, rawActs)

    // 就寝時刻一貫性スコア用 14日分: AutoSleep → HAE の順で優先
    const sleepStartHistory: number[] = dates14
      .map((_, i) => rawAs14[i]?.sleepStartMinutes ?? rawSleeps14[i]?.sleepStartMinutes ?? null)
      .filter((n): n is number => n !== null)

    console.log(`[health-data] body=${bodyRecords.length} sleep=${sleepRecords.length} activity=${activityRecords.length}`)
    bodyRecords.forEach(r => {
      console.log(`[health-data] body ${r.date}: weight=${r.weight} bodyFatPct=${r.bodyFatPct} muscleMass=${r.muscleMass} estimatedMuscleMass=${r.estimatedMuscleMass} source=${r.source}`)
    })
    sleepRecords.forEach(r => {
      console.log(`[health-data] sleep ${r.date}: asleepMin=${r.asleepMinutes} score=${r.sleepScore} awakenings=${r.awakenings} source=${r.source}`)
    })

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ bodyRecords, sleepRecords, activityRecords, sleepStartHistory }))

  } catch (e) {
    console.error('[health-data] error:', e)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ bodyRecords: [], sleepRecords: [], activityRecords: [], sleepStartHistory: [], error: String(e) }))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Withings on-demand sync
// ─────────────────────────────────────────────────────────────────────────────

/** 最終 sync から 3h 以上経過していれば Withings API を叩いて Redis を更新する */
async function syncWithingsIfStale(redis: Redis): Promise<void> {
  const clientId     = process.env['WITHINGS_CLIENT_ID']
  const clientSecret = process.env['WITHINGS_CLIENT_SECRET']
  if (!clientId || !clientSecret) return

  // 3h キャッシュチェック
  const lastStr = await redis.get<string>('withings:sync:last')
  const last    = lastStr ? parseInt(lastStr) : 0
  if (Date.now() - last < 3 * 60 * 60 * 1000) {
    console.log('[health-data] Withings sync skipped (cache fresh)')
    return
  }

  // Redis からトークン取得
  const stored = await redis.get<WithingsTokens>('withings:tokens')
  if (!stored?.access_token || !stored?.refresh_token) {
    console.log('[health-data] Withings sync skipped (no tokens in Redis)')
    return
  }

  // access token の有効期限チェック → 必要なら refresh
  let accessToken = stored.access_token
  const nowSec    = Math.floor(Date.now() / 1000)
  if (stored.expires_at - nowSec < 300) {  // 残り5分未満
    const refreshed = await refreshWithingsToken(clientId, clientSecret, stored.refresh_token)
    if (!refreshed) {
      console.warn('[health-data] Withings token refresh failed')
      return
    }
    accessToken = refreshed.access_token
    // 新しいトークンを Redis に保存（Withings は refresh token をローテーション）
    await redis.set('withings:tokens', JSON.stringify({ ...stored, ...refreshed }), { ex: 60 * 60 * 24 * 90 })
    console.log('[health-data] Withings token refreshed and saved')
  }

  // 直近 30 日分を取得
  const startdate = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000)
  const byDate    = await fetchWithingsMeasures(accessToken, startdate)

  // Redis に保存
  const ops: Promise<unknown>[] = [
    redis.set('withings:sync:last', String(Date.now()), { ex: 60 * 60 * 24 * 30 }),
  ]
  for (const [date, data] of byDate) {
    ops.push(redis.set(`withings:body:${date}`, JSON.stringify(data), { ex: 60 * 60 * 24 * 90 }))
  }
  await Promise.all(ops)

  console.log(`[health-data] Withings sync done: ${byDate.size} days saved`)
}

// meastype → フィールド名（Withings 公式仕様に準拠）
const WITHINGS_MEAS_FIELD: Record<number, keyof WithingsStoredBody> = {
  1:  'weight',
  5:  'fatFreeMass',
  6:  'bodyFatPct',
  8:  'fatMass',
  76: 'muscleMass',
  88: 'boneMass',
}

/** Withings measure API から直近 N 日分を取得し、日付→体組成の Map を返す */
async function fetchWithingsMeasures(
  token:         string,
  startdateUnix: number,
): Promise<Map<string, WithingsStoredBody>> {
  const measTypeParts = Object.keys(WITHINGS_MEAS_FIELD).map(t => `meastype=${t}`).join('&')
  const allGrps: WithingsMeasureGrp[] = []
  let offset = 0

  for (let page = 0; page < 10; page++) {
    const bodyStr = `action=getmeas&${measTypeParts}&startdate=${startdateUnix}&offset=${offset}`
    try {
      const resp = await fetch('https://wbsapi.withings.net/measure', {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    bodyStr,
      })
      const data = await resp.json() as WithingsMeasResponse
      if ([100, 101, 102, 401].includes(data.status)) break
      if (data.status !== 0 || !data.body) break
      allGrps.push(...data.body.measuregrps)
      if (!data.body.more) break
      offset = data.body.offset
    } catch { break }
  }

  // grpid → セッション（同日は最多フィールドを採用）
  const sessions = new Map<number, { date: string; fields: WithingsStoredBody }>()
  for (const grp of allGrps) {
    const jstMs = grp.date * 1000 + 9 * 3600 * 1000
    const date  = new Date(jstMs).toISOString().slice(0, 10)
    const fields: WithingsStoredBody = {}
    for (const m of grp.measures) {
      const field = WITHINGS_MEAS_FIELD[m.type]
      if (field) fields[field] = Math.round(m.value * Math.pow(10, m.unit) * 100) / 100
    }
    sessions.set(grp.grpid, { date, fields })
  }

  const byDate = new Map<string, WithingsStoredBody>()
  for (const { date, fields } of sessions.values()) {
    const existing = byDate.get(date)
    if (!existing || Object.keys(fields).length > Object.keys(existing).length) {
      byDate.set(date, fields)
    }
  }
  return byDate
}

async function refreshWithingsToken(
  clientId:     string,
  clientSecret: string,
  refreshToken: string,
): Promise<Omit<WithingsTokens, 'access_token'> & { access_token: string } | null> {
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
// マージ: Withings 優先、HAE フォールバック
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Withings と HAE のボディデータを日付単位でマージする。
 * - 体組成フィールドは Withings 優先
 * - muscleMass: Withings の実測値を使用。Withings データがない日のみ HAE 推定値を estimatedMuscleMass として残す
 * - 除脂肪体重×0.45の推定ロジックはWithingsデータがある日には適用しない
 */
function mergeBodyRecord(
  date:     string,
  withings: WithingsStoredBody | null,
  hae:      StoredBody | null,
): MergedBodyRecord | null {
  if (!withings && !hae) return null

  const weight     = withings?.weight     ?? hae?.weight
  if (weight == null) return null  // 体重なしは除外

  return {
    id:     withings ? `withings-body-${date}` : `hae-body-${date}`,
    date,
    source: withings ? 'withings' : 'health_auto_export',
    weight,
    bodyFatPct:          withings?.bodyFatPct    ?? hae?.bodyFatPct,
    fatMass:             withings?.fatMass,
    fatFreeMass:         withings?.fatFreeMass   ?? hae?.leanBodyMass,
    muscleMass:          withings?.muscleMass,    // 実測値のみ（推定値は入れない）
    boneMass:            withings?.boneMass,
    leanBodyMass:        hae?.leanBodyMass,
    // estimatedMuscleMass: Withings 実測値がなければ HAE 推定値を使う
    estimatedMuscleMass: withings?.muscleMass != null
      ? undefined
      : hae?.estimatedMuscleMass,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 型定義
// ─────────────────────────────────────────────────────────────────────────────

interface WithingsTokens {
  access_token:  string
  refresh_token: string
  expires_at:    number
}

interface WithingsStoredBody {
  weight?:      number
  bodyFatPct?:  number
  fatMass?:     number
  fatFreeMass?: number
  muscleMass?:  number  // 実測値 (meastype 76)
  boneMass?:    number
}

interface StoredBody {
  weight?:              number
  bodyFatPct?:          number
  leanBodyMass?:        number
  estimatedMuscleMass?: number
}
interface StoredSleep {
  totalMinutes?:      number
  deepMinutes?:       number
  remMinutes?:        number
  sleepStartMinutes?: number
  awakeMinutes?:      number
}

interface AutoSleepStored {
  sleepScore?:        number   // AutoSleep 独自スコア (0–100)
  totalMinutes?:      number
  deepMinutes?:       number
  qualityMinutes?:    number   // qualitySleep = 質の良い睡眠時間（分）
  awakenings?:        number   // 覚醒回数
  hrv?:               number
  wakingBPM?:         number   // heartRate フィールドから変換
  sleepStartMinutes?: number
  sleepEndMinutes?:   number
}
interface StoredActivity {
  steps?:            number
  restingHeartRate?: number
}

interface WithingsMeasure    { value: number; type: number; unit: number }
interface WithingsMeasureGrp { grpid: number; date: number; measures: WithingsMeasure[] }
interface WithingsMeasBody   { measuregrps: WithingsMeasureGrp[]; more: number; offset: number }
interface WithingsMeasResponse { status: number; body?: WithingsMeasBody }

// ── フロント向け型 ─────────────────────────────────────────────────────────────

interface MergedBodyRecord {
  id:                   string
  date:                 string
  source:               'withings' | 'health_auto_export'
  weight?:              number
  bodyFatPct?:          number
  fatMass?:             number
  fatFreeMass?:         number
  muscleMass?:          number   // Withings 実測値
  boneMass?:            number
  leanBodyMass?:        number
  estimatedMuscleMass?: number   // HAE 推定値 (Withings 実測なし日のみ)
}

interface MergedSleepRecord {
  id:                 string
  date:               string
  asleepMinutes?:     number   // 総睡眠時間（分）
  deepMinutes?:       number
  remMinutes?:        number
  sleepStartMinutes?: number   // 就寝時刻 (0:00 からの分)
  awakeMinutes?:      number   // 覚醒時間（分）
  sleepScore?:        number   // AutoSleep 独自スコア
  awakenings?:        number   // 覚醒回数
  hrv?:               number
  wakingBPM?:         number
  source:             'autosleep_shortcut' | 'health_auto_export'
}
interface HaeActivityRecord {
  date:              string
  steps?:            number
  restingHeartRate?: number
}

// ── パーサー ──────────────────────────────────────────────────────────────────

/**
 * AutoSleep Shortcuts データ優先、HAE フォールバックで睡眠レコードをマージ。
 * - スコア・覚醒回数・HRV・wakingBPM は AutoSleep 独自指標のため AutoSleep 優先
 * - 睡眠時間・深睡眠・REM は AutoSleep にあればそれを使い、なければ HAE
 * - 就寝時刻は AutoSleep → HAE の順で優先
 */
function mergeSleepRecord(
  date: string,
  as:   AutoSleepStored | null,
  hae:  StoredSleep | null,
): MergedSleepRecord | null {
  if (!as && !hae) return null

  const totalMin = as?.totalMinutes ?? hae?.totalMinutes
  return {
    id:                 as ? `as-sleep-${date}` : `hae-sleep-${date}`,
    date,
    source:             as ? 'autosleep_shortcut' : 'health_auto_export',
    asleepMinutes:      totalMin,
    deepMinutes:        as?.deepMinutes   ?? hae?.deepMinutes,
    remMinutes:         as?.remMinutes    ?? hae?.remMinutes,
    sleepStartMinutes:  as?.sleepStartMinutes ?? hae?.sleepStartMinutes,
    awakeMinutes:       hae?.awakeMinutes,          // HAE から（AutoSleepは覚醒時間でなく回数）
    sleepScore:         as?.sleepScore,             // AutoSleep 独自スコア
    awakenings:         as?.awakenings,             // AutoSleep 独自
    hrv:                as?.hrv,                    // AutoSleep 独自
    wakingBPM:          as?.wakingBPM,              // AutoSleep 独自
  }
}
function toActivityRecords(dates: string[], raw: (StoredActivity | null)[]): HaeActivityRecord[] {
  return raw
    .map((v, i) => v == null ? null : { date: dates[i], ...v })
    .filter((r): r is HaeActivityRecord => r !== null)
    .sort((a, b) => a.date.localeCompare(b.date))
}
