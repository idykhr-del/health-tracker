import type { IncomingMessage, ServerResponse } from 'http'

/**
 * /api/notion/body — Vercel serverless function
 *
 * Proxies CRUD operations for the body_records Notion database.
 * All Notion API calls happen server-side to avoid CORS issues.
 *
 * GET    → query all pages → { records: BodyRecord[] }
 * PUT    → upsert one record (body: BodyRecord) → 200
 * DELETE → ?date=YYYY-MM-DD → archive page → 200
 *
 * Env vars:
 *   NOTION_API_KEY        — Notion integration secret
 *   NOTION_BODY_DB_ID     — body_records database ID
 */

const NOTION_BASE    = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'
const SEP            = '__BODY_EXTRA__'

// ── Types (kept local to avoid cross-package import issues) ───────────────────

interface BodyRecord {
  id:           string
  date:         string
  time?:        string
  weight:       number
  fatMass?:     number
  muscleMass?:  number
  boneMass?:    number
  hydration?:   number
  bmi?:         number
  fatFreeMass?: number
  bodyFatPct?:  number
  source:       'withings_csv' | 'manual'
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
  type:      string
  title?:    NotionTitle[]
  rich_text?: NotionRichText[]
  number?:   number | null
  date?:     { start: string } | null
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

function titleProp(p: NotionProperty | undefined): string {
  return p?.title?.[0]?.plain_text ?? ''
}

function textProp(p: NotionProperty | undefined): string {
  return p?.rich_text?.[0]?.plain_text ?? ''
}

function numProp(p: NotionProperty | undefined): number | undefined {
  return p?.number ?? undefined
}

function dateProp(p: NotionProperty | undefined): string | undefined {
  return p?.date?.start ?? undefined
}

// ── Page ↔ BodyRecord conversions ────────────────────────────────────────────

function pageToBodyRecord(page: NotionPage): BodyRecord | null {
  const p = page.properties

  const weight = numProp(p['weight'])
  if (weight == null) return null

  const date = dateProp(p['date']) ?? titleProp(p['Name'])
  if (!date) return null

  const source = (textProp(p['source']) || 'manual') as 'withings_csv' | 'manual'
  const memoRaw = textProp(p['memo'])

  // Decode extras (id, time, fatMass, boneMass, fatFreeMass) from memo JSON
  let extras: Record<string, unknown> = {}
  const sepIdx = memoRaw.indexOf(SEP)
  if (sepIdx >= 0) {
    try { extras = JSON.parse(memoRaw.slice(sepIdx + SEP.length)) as Record<string, unknown> }
    catch { /* ignore */ }
  }

  return {
    id:          (extras['id'] as string) || `${date}_body`,
    date,
    time:        extras['time'] as string | undefined,
    weight,
    bodyFatPct:  numProp(p['bodyFat']),
    muscleMass:  numProp(p['muscleMass']),
    bmi:         numProp(p['bmi']),
    hydration:   numProp(p['waterRate']),
    fatMass:     extras['fatMass']     as number | undefined,
    boneMass:    extras['boneMass']    as number | undefined,
    fatFreeMass: extras['fatFreeMass'] as number | undefined,
    source,
  }
}

function buildBodyProps(record: BodyRecord): Record<string, unknown> {
  // Pack fields not in DB schema into memo JSON
  const extras: Record<string, unknown> = { id: record.id }
  if (record.time)        extras['time']        = record.time
  if (record.fatMass     != null) extras['fatMass']     = record.fatMass
  if (record.boneMass    != null) extras['boneMass']    = record.boneMass
  if (record.fatFreeMass != null) extras['fatFreeMass'] = record.fatFreeMass

  const memoStr = `${SEP}${JSON.stringify(extras)}`

  const props: Record<string, unknown> = {
    Name:   { title:     [{ text: { content: record.date } }] },
    date:   { date:      { start: record.date } },
    weight: { number:    record.weight },
    source: { rich_text: [{ text: { content: record.source } }] },
    memo:   { rich_text: [{ text: { content: memoStr } }] },
  }

  if (record.bodyFatPct  != null) props['bodyFat']    = { number: record.bodyFatPct }
  if (record.muscleMass  != null) props['muscleMass'] = { number: record.muscleMass }
  if (record.bmi         != null) props['bmi']        = { number: record.bmi }
  if (record.hydration   != null) props['waterRate']  = { number: record.hydration }

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
  const dbId   = process.env.NOTION_BODY_DB_ID

  if (!apiKey || !dbId) {
    return json(500, { error: 'Missing NOTION_API_KEY or NOTION_BODY_DB_ID env vars' })
  }

  // ── GET: fetch all body records ────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const pages   = await queryAll(dbId, apiKey)
      const records = pages
        .filter(p => !p.archived)
        .map(p => pageToBodyRecord(p))
        .filter((r): r is BodyRecord => r !== null)

      return json(200, { records })
    } catch (e) {
      return json(502, { error: String(e) })
    }
  }

  // ── PUT: upsert one body record ────────────────────────────────────────────
  if (req.method === 'PUT') {
    let record: BodyRecord
    try {
      const raw = await readBody(req)
      record    = JSON.parse(raw) as BodyRecord
    } catch {
      return json(400, { error: 'Invalid JSON body' })
    }

    if (!record.date || record.weight == null) {
      return json(400, { error: 'record.date and record.weight are required' })
    }

    try {
      const props  = buildBodyProps(record)
      const pageId = await findPageByDate(dbId, apiKey, record.date)

      if (pageId) {
        // Update existing
        await nFetch(`/pages/${pageId}`, 'PATCH', apiKey, { properties: props })
      } else {
        // Create new
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
    const url    = new URL(req.url ?? '/', `http://localhost`)
    const date   = url.searchParams.get('date')

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
