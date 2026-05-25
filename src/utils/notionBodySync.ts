/**
 * notionBodySync.ts
 *
 * Client-side helpers for syncing BodyRecord data with the Notion API
 * via /api/notion/body (Vercel serverless proxy).
 *
 * All functions are fire-and-forget safe (won't throw).
 */

import type { BodyRecord } from '../types'

const API = '/api/notion/body'
const MIGRATED_KEY = 'notion_body_migrated'

// ── Load ──────────────────────────────────────────────────────────────────────

/**
 * Fetch all body records from Notion.
 * Returns null on network error or missing env config.
 */
export async function loadBodyFromNotion(): Promise<BodyRecord[] | null> {
  try {
    const controller = new AbortController()
    const timeout    = setTimeout(() => controller.abort(), 15_000)

    const res = await fetch(API, { signal: controller.signal })
    clearTimeout(timeout)

    if (!res.ok) return null
    const data = await res.json() as { records?: BodyRecord[] }
    return data.records ?? null
  } catch {
    return null
  }
}

// ── Upsert (fire-and-forget) ──────────────────────────────────────────────────

/**
 * Push one body record to Notion (PUT).
 * Fire-and-forget — call without await in mutation handlers.
 */
export function syncBodyRecord(
  record: BodyRecord,
  onError?: (e: unknown) => void,
): void {
  fetch(API, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(record),
  })
    .then(res => { if (!res.ok) return res.json().then(e => { throw e }) })
    .catch(e => onError?.(e))
}

// ── Delete (fire-and-forget) ──────────────────────────────────────────────────

/**
 * Archive a body record in Notion by date (DELETE).
 * Fire-and-forget.
 */
export function deleteBodyRecord(
  date: string,
  onError?: (e: unknown) => void,
): void {
  fetch(`${API}?date=${encodeURIComponent(date)}`, { method: 'DELETE' })
    .then(res => { if (!res.ok) return res.json().then(e => { throw e }) })
    .catch(e => onError?.(e))
}

// ── Migration ─────────────────────────────────────────────────────────────────

interface MigrateProgress {
  done:  number
  total: number
}

/**
 * Upload all local body records to Notion one-by-one.
 * Reports progress via onProgress callback.
 * Returns { success, errors } counts.
 */
export async function migrateBodyRecords(
  records:    BodyRecord[],
  onProgress: (p: MigrateProgress) => void,
): Promise<{ success: number; errors: number }> {
  let success = 0
  let errors  = 0

  for (let i = 0; i < records.length; i++) {
    try {
      const res = await fetch(API, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(records[i]),
      })
      if (res.ok) {
        success++
      } else {
        errors++
      }
    } catch {
      errors++
    }

    onProgress({ done: i + 1, total: records.length })

    // 350ms delay between requests to respect Notion rate limits
    if (i < records.length - 1) {
      await new Promise(r => setTimeout(r, 350))
    }
  }

  return { success, errors }
}

// ── Migration state ───────────────────────────────────────────────────────────

export function hasMigratedBody(): boolean {
  try { return localStorage.getItem(MIGRATED_KEY) === '1' } catch { return false }
}

export function markMigratedBody(): void {
  try { localStorage.setItem(MIGRATED_KEY, '1') } catch { /* ignore */ }
}

// ── Merge helper ──────────────────────────────────────────────────────────────

/**
 * Merge local body records with records from Notion.
 * Notion records take precedence for the same date.
 * Dates only present locally are preserved.
 */
export function mergeBodyWithNotion(
  local:  BodyRecord[],
  notion: BodyRecord[],
): BodyRecord[] {
  const byDate = new Map<string, BodyRecord>()

  // Local first (lower priority)
  for (const r of local)  byDate.set(r.date, r)
  // Notion overrides
  for (const r of notion) byDate.set(r.date, r)

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}
