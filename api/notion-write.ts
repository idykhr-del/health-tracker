import type { IncomingMessage, ServerResponse } from 'http'

/**
 * POST (または PATCH) /api/notion-write
 *
 * Notion 公式 REST API を直接叩いてページのプロパティを更新する専用の書き込み経路。
 *
 * 目的:
 *   Notion MCP コネクタ経由で rich_text（items_json 等）を書き込むと、
 *   "[" や "{" の直前に余計な "\" が挿入されて壊れた JSON が保存される不具合がある。
 *   その MCP を経由せず、公式 API を直接呼ぶことでこの混入を回避する。
 *
 * リクエスト body (JSON):
 *   {
 *     pageId: string,
 *     properties: { [プロパティ名]: string | number }
 *   }
 *
 *   プロパティ名・型はハードコードせずペイロードから動的に組み立てる
 *   （将来 Notion 側でカラム名/型が変わってもコード修正なしで追従できる）:
 *     string → rich_text  { rich_text: [{ text: { content: value } }] }
 *     number → number     { number: value }
 *
 * 検証:
 *   rich_text（文字列）値が "[" または "{" で始まる場合、書き込み前に JSON.parse を試み、
 *   失敗したら 400 を返して書き込み全体を拒否する。
 *   （壊れた JSON 文字列が items_json 等に保存され、アプリ側 parseComponents が沈黙して
 *    空配列を返す、という過去に実際起きた不具合の再発を防ぐため。）
 *
 * 認証:
 *   Notion へは Authorization: Bearer ${NOTION_API_KEY}, Notion-Version: 2022-06-28。
 *   第三者アクセスへの追加対策は必須ではない（sleep-ingest と同程度）。
 *   任意で NOTION_WRITE_TOKEN を設定した場合のみ、?token= または X-Ingest-Token で照合する。
 *
 * Env vars:
 *   NOTION_API_KEY       （必須）
 *   NOTION_WRITE_TOKEN   （任意: 設定時のみエンドポイント側トークンを要求）
 */

const NOTION_BASE = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'

// Notion の rich_text 1 オブジェクトあたりの content 上限は 2000 文字。
// 通常の items_json（≤1900）なら 1 run のまま。超過時のみ分割してエラーを避ける。
const RICH_TEXT_CHUNK = 1900

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, PATCH, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Ingest-Token')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
  if (req.method !== 'POST' && req.method !== 'PATCH') {
    return json(res, 405, { error: 'Method not allowed. Use POST or PATCH.' })
  }

  // ── Notion 認証情報 ────────────────────────────────────────────────────────────
  const apiKey = process.env['NOTION_API_KEY']
  if (!apiKey) return json(res, 500, { error: 'NOTION_API_KEY is not configured' })

  // ── 任意のエンドポイント側トークン（設定時のみ要求）────────────────────────────
  const writeToken = process.env['NOTION_WRITE_TOKEN']
  if (writeToken) {
    const url = req.url ?? ''
    const qsStart = url.indexOf('?')
    const qs = qsStart >= 0 ? new URLSearchParams(url.slice(qsStart)) : null
    const provided = (qs?.get('token') ?? '') || ((req.headers['x-ingest-token'] as string | undefined) ?? '')
    if (provided !== writeToken) {
      console.warn('[notion-write] Auth failed. provided token length:', provided.length)
      return json(res, 401, { error: 'Unauthorized' })
    }
  }

  // ── ボディ読み取り ────────────────────────────────────────────────────────────
  let rawBody = ''
  try { rawBody = await readBody(req) }
  catch (e) { return json(res, 400, { error: 'readBody failed', detail: String(e) }) }

  let payload: { pageId?: unknown; properties?: unknown }
  try { payload = JSON.parse(rawBody) }
  catch { return json(res, 400, { error: 'Invalid JSON body' }) }

  const pageId = payload.pageId
  if (typeof pageId !== 'string' || !pageId.trim()) {
    return json(res, 400, { error: 'pageId (non-empty string) is required' })
  }

  const properties = payload.properties
  if (properties == null || typeof properties !== 'object' || Array.isArray(properties)) {
    return json(res, 400, { error: 'properties (object) is required' })
  }

  // ── プロパティを動的に組み立てる（型はペイロードから自動判定）────────────────────
  const built = buildProperties(properties as Record<string, unknown>)
  if (built.error) return json(res, 400, { error: built.error })
  if (Object.keys(built.props!).length === 0) {
    return json(res, 400, { error: 'properties is empty; nothing to write' })
  }

  console.log('[notion-write] pageId:', pageId, 'props:', Object.keys(built.props!).join(', '))

  // ── Notion 公式 API へ PATCH ────────────────────────────────────────────────────
  const result = await notionFetch(`/pages/${pageId}`, 'PATCH', apiKey, { properties: built.props })
  if (!result.ok) {
    const err = result.json as { code?: string; message?: string } | null
    console.error('[notion-write] Notion PATCH failed:', result.status, err?.code, err?.message)
    return json(res, result.status || 502, {
      error: 'Notion write failed',
      status: result.status,
      code: err?.code,
      message: err?.message,
    })
  }

  const id = (result.json as { id?: string } | null)?.id
  console.log('[notion-write] updated page', id ?? pageId)
  return json(res, 200, { ok: true, pageId: id ?? pageId, updated: Object.keys(built.props!) })
}

/**
 * ペイロードの properties を Notion のプロパティ値形式に変換する。
 * string → rich_text / number → number を自動判定。
 * rich_text 文字列が "[" or "{" で始まる場合は JSON.parse で妥当性検証し、
 * 失敗時は書き込み全体を拒否する（error を返す）。
 */
function buildProperties(input: Record<string, unknown>): { props?: Record<string, unknown>; error?: string } {
  const props: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return { error: `Property "${name}": number is not finite` }
      props[name] = { number: value }
    } else if (typeof value === 'string') {
      const head = value.trimStart()
      if (head.startsWith('[') || head.startsWith('{')) {
        try {
          JSON.parse(value)
        } catch {
          return {
            error: `Property "${name}": value starts with "[" or "{" but is not valid JSON. ` +
              `Write rejected to avoid saving broken JSON.`,
          }
        }
      }
      props[name] = { rich_text: richTextChunks(value) }
    } else {
      return { error: `Property "${name}": unsupported value type "${value === null ? 'null' : typeof value}" (only string or number)` }
    }
  }
  return { props }
}

/** 文字列を Notion rich_text の text オブジェクト配列へ（2000 文字上限対策で ≤1900 に分割）。 */
function richTextChunks(s: string): { text: { content: string } }[] {
  const chunks: { text: { content: string } }[] = []
  for (let i = 0; i < s.length; i += RICH_TEXT_CHUNK) {
    chunks.push({ text: { content: s.slice(i, i + RICH_TEXT_CHUNK) } })
  }
  return chunks.length ? chunks : [{ text: { content: '' } }]
}

async function notionFetch(
  path: string, method: string, apiKey: string, body?: unknown,
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const res = await fetch(`${NOTION_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  let parsed: unknown
  try { parsed = await res.json() } catch { parsed = null }
  return { ok: res.ok, status: res.status, json: parsed }
}

function json(res: ServerResponse, status: number, body: object) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let d = ''
    req.on('data', (c: Buffer) => { d += c.toString() })
    req.on('end', () => resolve(d))
    req.on('error', reject)
  })
}
