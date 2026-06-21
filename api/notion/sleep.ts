import type { IncomingMessage, ServerResponse } from 'http'

/**
 * /api/notion/sleep — Vercel serverless function
 *
 * Proxies CRUD operations for the sleep_records Notion database.
 * All Notion API calls happen server-side to avoid CORS issues.
 *
 * GET    → query all pages → { records: SleepRecord[] }
 * PUT    → upsert one record (body: SleepRecord) → 200
 * DELETE → ?date=YYYY-MM-DD → archive page → 200
 *
 * Env vars:
 *   NOTION_API_KEY      — Notion integration secret (shared with body.ts)
 *   NOTION_SLEEP_DB_ID  — sleep_records database ID
 */

const NOTION_BASE    = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'

// ── Types (kept local to avoid cross-package import issues) ───────────────────

interface SleepRecord {
  date:               string
  asleepMinutes?:      number
  deepMinutes?:        number
  remMinutes?:         number
  awakeMinutes?:       number
  sleepStartMinutes?:  number
  sleepScore?:         number
  awakenings?:         number
  hrv?:                number
  wakingBPM?:          number
  source?:             'autosleep_shortcut' | 'health_auto_export'
}

// ── Notion response shapes (minimal) ─────────────────────────────────────────

interface NotionRichText { plain_text: string }
interface NotionTitle    { plain_text: string }

interface NotionPage {
  id:         string
  archived:   boolean
  properties: Record<string, NotionProperty>
}

interface NotionProperty {
  type:       string
  title?:     NotionTitle[]
  rich_text?: NotionRichText[]
  number?:    number | null
  date?:      { start: string } | null
  select?:    { name: string } | null
}

interface NotionQueryResponse {
  results:     NotionPage[]
  has_more:    boolean
  next_cursor: string | null
}

// ── Notion fetch with 429 retry ───────────────────────────────────────────────

async function nFetch(
  path:    string,
  method:  string,
  apiKey:  string,
  body?:   unknown,
  retries = 3,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(`${NOTION_BASE}${path}`, {
      method,
      headers: {
        Authorization:    `Bearer ${apiKey}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type':   'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (res.status === 429 && attempt < retries - 1) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '1', 10)
      await new Promise(r => setTimeout(r, (retryAfter || 1) * 1000))
      continue
    }
    let json: unknown
    try { json = await res.json() } catch { json = null }
    return { ok: res.ok, status: res.status, json }
  }
  return { ok: false, status: 0, json: null }
}

// ── Paginate through all results ──────────────────────────────────────────────

async function queryAll(dbId: string, apiKey: string): Promise<NotionPage[]> {
  const pages: NotionPage[] = []
  let cursor: string | undefined

  do {
    const reqBody: Record<string, unknown> = {
      page_size: 100,
      sorts: [{ property: 'date', direction: 'ascending' }],
    }
    if (cursor) reqBody.start_cursor = cursor

    const result = await nFetch(`/databases/${dbId}/query`, 'POST', apiKey, reqBody)
    const data   = result.json as NotionQueryResponse
    pages.push(...(data.results ?? []))
    cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined
  } while (cursor)

  return pages
}

// ── Property helpers ──────────────────────────────────────────────────────────

function numProp(p: NotionProperty | undefined): number | undefined {
  return p?.number ?? undefined
}

function dateProp(p: NotionProperty | undefined): string | undefined {
  return p?.date?.start ?? undefined
}

function selectProp(p: NotionProperty | undefined): string | undefined {
  return p?.select?.name ?? undefined
}

// ── Page ↔ SleepRecord conversions ───────────────────────────────────────────

function pageToSleepRecord(page: NotionPage): SleepRecord | null {
  const p = page.properties

  const date = dateProp(p['date'])
  if (!date) return null

  return {
    date,
    asleepMinutes:     numProp(p['asleepMinutes']),
    deepMinutes:       numProp(p['deepMinutes']),
    remMinutes:        numProp(p['remMinutes']),
    awakeMinutes:      numProp(p['awakeMinutes']),
    sleepStartMinutes: numProp(p['sleepStartMinutes']),
    sleepScore:        numProp(p['sleepScore']),
    awakenings:        numProp(p['awakenings']),
    hrv:               numProp(p['hrv']),
    wakingBPM:         numProp(p['wakingBPM']),
    source:            selectProp(p['source']) as SleepRecord['source'],
  }
}

function buildSleepProps(record: SleepRecord): Record<string, unknown> {
  const props: Record<string, unknown> = {
    Name: { title: [{ text: { content: record.date } }] },
    date: { date:  { start: record.date } },
  }

  if (record.asleepMinutes     != null) props['asleepMinutes']     = { number: record.asleepMinutes }
  if (record.deepMinutes       != null) props['deepMinutes']       = { number: record.deepMinutes }
  if (record.remMinutes        != null) props['remMinutes']        = { number: record.remMinutes }
  if (record.awakeMinutes      != null) props['awakeMinutes']      = { number: record.awakeMinutes }
  if (record.sleepStartMinutes != null) props['sleepStartMinutes'] = { number: record.sleepStartMinutes }
  if (record.sleepScore        != null) props['sleepScore']        = { number: record.sleepScore }
  if (record.awakenings        != null) props['awakenings']        = { number: record.awakenings }
  if (record.hrv               != null) props['hrv']               = { number: record.hrv }
  if (record.wakingBPM         != null) props['wakingBPM']         = { number: record.wakingBPM }
  if (record.source)                    props['source']            = { select: { name: record.source } }

  return props
}

// ── Find page by date ─────────────────────────────────────────────────────────

async function findPageByDate(
  dbId:   string,
  apiKey: string,
  date:   string,
): Promise<string | null> {
  const result = await nFetch(`/databases/${dbId}/query`, 'POST', apiKey, {
    page_size: 10,
    filter: {
      property: 'date',
      date: { equals: date },
    },
  })
  const data = result.json as NotionQueryResponse
  const page = (data.results ?? []).find(p => !p.archived)
  return page?.id ?? null
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

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  const apiKey = process.env.NOTION_API_KEY
  const dbId   = process.env.NOTION_SLEEP_DB_ID

  if (!apiKey || !dbId) {
    return json(500, { error: 'Missing NOTION_API_KEY or NOTION_SLEEP_DB_ID env vars' })
  }

  // ── GET: fetch all sleep records ───────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const pages   = await queryAll(dbId, apiKey)
      const records = pages
        .filter(p => !p.archived)
        .map(p => pageToSleepRecord(p))
        .filter((r): r is SleepRecord => r !== null)

      return json(200, { records })
    } catch (e) {
      return json(502, { error: String(e) })
    }
  }

  // ── PUT: upsert one sleep record ───────────────────────────────────────────
  if (req.method === 'PUT') {
    let record: SleepRecord
    try {
      const raw = await readBody(req)
      record    = JSON.parse(raw) as SleepRecord
    } catch {
      return json(400, { error: 'Invalid JSON body' })
    }

    if (!record.date) {
      return json(400, { error: 'record.date is required' })
    }

    try {
      const props  = buildSleepProps(record)
      const pageId = await findPageByDate(dbId, apiKey, record.date)

      if (pageId) {
        // Update existing — only the properties present in `record` are touched,
        // so a later partial write (e.g. HAE-only fields) won't blank out
        // fields written earlier by a richer source (e.g. AutoSleep).
        await nFetch(`/pages/${pageId}`, 'PATCH', apiKey, { properties: props })
      } else {
        await nFetch('/pages', 'POST', apiKey, {
          parent:     { database_id: dbId },
          properties: props,
        })
      }
      return json(200, { ok: true })
    } catch (e) {
      return json(502, { error: String(e) })
    }
  }

  // ── DELETE: archive by date ────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const url  = new URL(req.url ?? '/', `http://localhost`)
    const date = url.searchParams.get('date')

    if (!date) return json(400, { error: 'Missing ?date= query param' })

    try {
      const pageId = await findPageByDate(dbId, apiKey, date)
      if (!pageId) return json(200, { ok: true, skipped: true })

      await nFetch(`/pages/${pageId}`, 'PATCH', apiKey, { archived: true })
      return json(200, { ok: true })
    } catch (e) {
      return json(502, { error: String(e) })
    }
  }

  return json(405, { error: 'Method not allowed' })
}
