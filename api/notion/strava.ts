import type { IncomingMessage, ServerResponse } from 'http'

/**
 * GET /api/notion/strava
 *
 * Strava データが記録された Notion ページからランニング・ウォーキング記録を取得する。
 *
 * Env vars:
 *   NOTION_API_KEY       — Notion integration secret
 *   NOTION_STRAVA_DB_ID  — TODO: Strava Notion ページ/DB の ID をここに設定
 *
 * TODO: 以下を実装する
 *   1. NOTION_STRAVA_DB_ID に Strava データのある Notion ページ/DB ID を設定
 *   2. DB スキーマに合わせてプロパティ名を調整（下記 PROP_* 定数）
 *   3. parseStravaPage() でフィールドを抽出
 *
 * 想定レスポンス: { activities: StravaActivity[] }
 *   StravaActivity: { date, type, distanceKm, durationMinutes, name }
 */

// TODO: Strava Notion ページ/DB の ID を設定する
const STRAVA_DB_ID = process.env['NOTION_STRAVA_DB_ID'] ?? '' // ← ここに設定

const NOTION_BASE    = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'

// ── DB プロパティ名（TODO: Notion DB のスキーマに合わせて変更） ───────────────
const PROP_NAME     = 'Name'
const PROP_DATE     = 'Date'
const PROP_TYPE     = 'Type'       // select: Run / Walk / Ride
const PROP_DISTANCE = 'Distance'   // number (km)
const PROP_DURATION = 'Duration'   // number (分)

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  if (req.method !== 'GET') {
    return jsonRes(res, 405, { error: 'Method not allowed' })
  }

  // TODO: DB ID 未設定の場合は空を返す（実装前でもアプリを壊さない）
  if (!STRAVA_DB_ID) {
    return jsonRes(res, 200, { activities: [], todo: 'Set NOTION_STRAVA_DB_ID env var' })
  }

  const apiKey = process.env['NOTION_API_KEY']
  if (!apiKey) return jsonRes(res, 500, { error: 'NOTION_API_KEY not set' })

  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
  const startDate = sevenDaysAgo.toISOString().slice(0, 10)

  try {
    const resp = await fetch(`${NOTION_BASE}/databases/${STRAVA_DB_ID}/query`, {
      method:  'POST',
      headers: {
        'Authorization':  `Bearer ${apiKey}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type':   'application/json',
      },
      body: JSON.stringify({
        filter: { property: PROP_DATE, date: { on_or_after: startDate } },
        sorts:  [{ property: PROP_DATE, direction: 'descending' }],
        page_size: 50,
      }),
    })

    if (!resp.ok) {
      const err = await resp.text()
      return jsonRes(res, 502, { error: 'Notion API error', detail: err.slice(0, 300) })
    }

    const data = await resp.json() as { results: NotionPage[] }
    const activities = data.results
      .map(parseStravaPage)
      .filter((a): a is StravaActivity => a !== null)

    return jsonRes(res, 200, { activities })
  } catch (e) {
    return jsonRes(res, 500, { error: String(e) })
  }
}

// ── 型 ───────────────────────────────────────────────────────────────────────

interface StravaActivity {
  id:               string
  date:             string
  name:             string
  type:             'running' | 'walking' | 'cycling' | 'other'
  distanceKm?:      number
  durationMinutes?: number
}

interface NotionPage {
  id:         string
  properties: Record<string, {
    type:   string
    title?: Array<{ plain_text: string }>
    date?:  { start: string } | null
    select?: { name: string } | null
    number?: number | null
  }>
}

// ── パーサー（TODO: スキーマに合わせて調整） ──────────────────────────────────

function parseStravaPage(page: NotionPage): StravaActivity | null {
  const p    = page.properties
  const date = p[PROP_DATE]?.date?.start?.slice(0, 10)
  if (!date) return null

  const name    = p[PROP_NAME]?.title?.map(t => t.plain_text).join('') ?? ''
  const typeRaw = p[PROP_TYPE]?.select?.name ?? ''
  const dist    = p[PROP_DISTANCE]?.number ?? undefined
  const dur     = p[PROP_DURATION]?.number ?? undefined

  const type: StravaActivity['type'] =
    /run|ラン/i.test(typeRaw)     ? 'running'  :
    /walk|ウォーク/i.test(typeRaw) ? 'walking'  :
    /ride|cycl|自転車/i.test(typeRaw) ? 'cycling' : 'other'

  return { id: page.id, date, name, type, distanceKm: dist, durationMinutes: dur }
}

function jsonRes(res: ServerResponse, status: number, body: object) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
