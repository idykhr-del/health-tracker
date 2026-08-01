import type { IncomingMessage, ServerResponse } from 'http'

/**
 * GET /api/notion/workout
 *
 * Notion の workout_sessions DB から直近7日の筋トレセッションを取得する。
 *
 * Env vars:
 *   NOTION_API_KEY        — Notion integration secret
 *   NOTION_WORKOUT_DB_ID  — workout_sessions の "database" ID
 *                           (デフォルト: 1a8d52f6-8126-4710-afc8-c8de54fc96b3)
 *                           ※ b651703d-758f-46fa-8bc3-5ec3272aa838 は同じ DB の
 *                             data source (collection) ID。REST の
 *                             /v1/databases/{id}/query は database ID しか
 *                             受け付けず、collection ID を渡すと 404 になる。
 *
 * 実 DB スキーマ（2026-08 時点）:
 *   Name        (title)  — セッション名（"2026-06-24 07:01" 形式）
 *   date        (date)   — 実施日（日付のみ、時刻なし）
 *   startTime   (text)   — 開始時刻 "HH:MM"
 *   endTime     (text)   — 終了時刻 "HH:MM"
 *   rating      (number) — 主観評価
 *   memo        (text)   — メモ
 *   original_id (text)   — localStorage 移行用 UUID
 *
 * この DB は筋トレセッション専用（ランニング等は Strava 側の担当）なので、
 * 返すレコードの type はすべて 'strength' 固定。
 * 距離プロパティは存在しないため distanceKm は常に undefined。
 *
 * レスポンス: { workouts: NotionWorkout[] }
 */

const NOTION_BASE    = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'
const WORKOUT_DB_ID  = process.env['NOTION_WORKOUT_DB_ID'] ?? '1a8d52f6-8126-4710-afc8-c8de54fc96b3'

// ── DB プロパティ名（大文字小文字は Notion 側と厳密に一致させること） ──────────
const PROP_NAME       = 'Name'
const PROP_DATE       = 'date'
const PROP_START_TIME = 'startTime'
const PROP_END_TIME   = 'endTime'
const PROP_RATING     = 'rating'
const PROP_MEMO       = 'memo'

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  if (req.method !== 'GET') {
    return jsonRes(res, 405, { error: 'Method not allowed' })
  }

  const apiKey = process.env['NOTION_API_KEY']
  if (!apiKey) return jsonRes(res, 500, { error: 'NOTION_API_KEY not set' })

  // 直近7日のフィルター
  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
  const startDate = sevenDaysAgo.toISOString().slice(0, 10)

  try {
    const resp = await fetch(`${NOTION_BASE}/databases/${WORKOUT_DB_ID}/query`, {
      method:  'POST',
      headers: {
        'Authorization':  `Bearer ${apiKey}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type':   'application/json',
      },
      body: JSON.stringify({
        filter: {
          property:  PROP_DATE,
          date:      { on_or_after: startDate },
        },
        sorts: [{ property: PROP_DATE, direction: 'descending' }],
        page_size: 50,
      }),
    })

    if (!resp.ok) {
      const err = await resp.text()
      // プロパティ名の不一致などは Notion が具体的なメッセージを返すので
      // Vercel Logs から追えるよう全文を残す
      console.error('[notion/workout] Notion API error', resp.status, err)
      return jsonRes(res, 502, { error: 'Notion API error', detail: err.slice(0, 300) })
    }

    const data = await resp.json() as NotionQueryResponse
    const workouts = data.results
      .map(page => parseWorkoutPage(page))
      .filter((w): w is NotionWorkout => w !== null)

    return jsonRes(res, 200, { workouts })
  } catch (e) {
    console.error('[notion/workout] unexpected error', e)
    return jsonRes(res, 500, { error: String(e) })
  }
}

// ── Notion レスポンス型（最小限） ─────────────────────────────────────────────

interface NotionQueryResponse { results: NotionPage[] }

interface NotionPage {
  id:         string
  properties: Record<string, NotionProperty>
}

interface NotionProperty {
  type:      string
  title?:    Array<{ plain_text: string }>
  rich_text?: Array<{ plain_text: string }>
  date?:     { start: string } | null
  number?:   number | null
}

// ── パーサー ──────────────────────────────────────────────────────────────────

interface NotionWorkout {
  id:               string
  date:             string
  name:             string
  /** この DB は筋トレ専用だが、フロント側の絞り込みとの互換のためフィールドは残す */
  type:             'strength' | 'running' | 'walking' | 'cycling' | 'other'
  distanceKm?:      number
  durationMinutes?: number
  rating?:          number
  memo?:            string
}

function parseWorkoutPage(page: NotionPage): NotionWorkout | null {
  const props = page.properties

  const date = props[PROP_DATE]?.date?.start?.slice(0, 10)
  if (!date) return null

  const name = props[PROP_NAME]?.title?.map(t => t.plain_text).join('') ?? ''

  return {
    id:   page.id,
    date,
    name,
    type: 'strength',
    // distanceKm はこの DB には存在しないため常に undefined
    durationMinutes: calcDurationMinutes(
      plainText(props[PROP_START_TIME]),
      plainText(props[PROP_END_TIME]),
    ),
    rating: props[PROP_RATING]?.number ?? undefined,
    memo:   plainText(props[PROP_MEMO]) || undefined,
  }
}

function plainText(prop: NotionProperty | undefined): string {
  return prop?.rich_text?.map(t => t.plain_text).join('') ?? ''
}

/**
 * "HH:MM" 形式の startTime / endTime から所要時間（分）を算出する。
 * 両方が妥当にパースできる場合のみ数値を返し、それ以外は undefined。
 * endTime が startTime より小さい場合は日をまたいだものとして +24h する。
 */
function calcDurationMinutes(startTime: string, endTime: string): number | undefined {
  const start = parseClockMinutes(startTime)
  const end   = parseClockMinutes(endTime)
  if (start === null || end === null) return undefined

  const diff = end >= start ? end - start : end + 24 * 60 - start
  return diff > 0 ? diff : undefined
}

/** "HH:MM" / "HH:MM:SS" を 0:00 からの経過分に変換する。不正な値は null。 */
function parseClockMinutes(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim())
  if (!m) return null

  const hours   = Number(m[1])
  const minutes = Number(m[2])
  if (hours > 23 || minutes > 59) return null

  return hours * 60 + minutes
}

function jsonRes(res: ServerResponse, status: number, body: object) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
