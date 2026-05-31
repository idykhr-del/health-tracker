import type { IncomingMessage, ServerResponse } from 'http'

/**
 * GET /api/notion/workout
 *
 * Notion のトレーニング DB から直近7日のワークアウトを取得する。
 *
 * Env vars:
 *   NOTION_API_KEY        — Notion integration secret
 *   NOTION_WORKOUT_DB_ID  — トレーニング DB の ID
 *                           (デフォルト: b651703d-758f-46fa-8bc3-5ec3272aa838)
 *
 * 想定 DB スキーマ（プロパティ名は環境に合わせて下記 PROP_* を変更）:
 *   Name     (title)  — ワークアウト名
 *   Date     (date)   — 実施日
 *   Type     (select) — 筋トレ / ランニング / ウォーキング / サイクリング
 *   Distance (number) — 距離 km（ランニング等）
 *   Duration (number) — 所要時間 分
 *
 * レスポンス: { workouts: NotionWorkout[] }
 */

const NOTION_BASE    = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'
const WORKOUT_DB_ID  = process.env['NOTION_WORKOUT_DB_ID'] ?? 'b651703d-758f-46fa-8bc3-5ec3272aa838'

// ── DB プロパティ名（Notion DB に合わせて変更） ───────────────────────────────
const PROP_NAME     = 'Name'
const PROP_DATE     = 'Date'
const PROP_TYPE     = 'Type'       // select プロパティ
const PROP_DISTANCE = 'Distance'   // number プロパティ (km)
const PROP_DURATION = 'Duration'   // number プロパティ (分)

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
      return jsonRes(res, 502, { error: 'Notion API error', detail: err.slice(0, 300) })
    }

    const data = await resp.json() as NotionQueryResponse
    const workouts = data.results.map(page => parseWorkoutPage(page)).filter(Boolean)

    return jsonRes(res, 200, { workouts })
  } catch (e) {
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
  type:        string
  title?:      Array<{ plain_text: string }>
  date?:       { start: string } | null
  select?:     { name: string } | null
  number?:     number | null
}

// ── パーサー ──────────────────────────────────────────────────────────────────

interface NotionWorkout {
  id:               string
  date:             string
  name:             string
  type:             'strength' | 'running' | 'walking' | 'cycling' | 'other'
  distanceKm?:      number
  durationMinutes?: number
}

function parseWorkoutPage(page: NotionPage): NotionWorkout | null {
  const props = page.properties

  const date = props[PROP_DATE]?.date?.start?.slice(0, 10)
  if (!date) return null

  const name = props[PROP_NAME]?.title?.map(t => t.plain_text).join('') ?? ''
  const typeRaw = props[PROP_TYPE]?.select?.name ?? ''
  const distanceKm      = props[PROP_DISTANCE]?.number ?? undefined
  const durationMinutes = props[PROP_DURATION]?.number ?? undefined

  return {
    id:   page.id,
    date,
    name,
    type: classifyType(typeRaw),
    distanceKm,
    durationMinutes,
  }
}

function classifyType(raw: string): NotionWorkout['type'] {
  const s = raw.toLowerCase()
  if (s.includes('ランニング') || s.includes('run') || s.includes('走'))   return 'running'
  if (s.includes('ウォーキング') || s.includes('walk') || s.includes('歩')) return 'walking'
  if (s.includes('サイクリング') || s.includes('cycl') || s.includes('自転車')) return 'cycling'
  if (s.includes('筋トレ') || s.includes('strength') || s.includes('gym') || s.includes('ウェイト')) return 'strength'
  return 'other'
}

function jsonRes(res: ServerResponse, status: number, body: object) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
