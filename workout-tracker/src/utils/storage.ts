/**
 * Unified dual-write storage layer
 *
 * Every write goes to BOTH localStorage (sync, instant) and IndexedDB
 * (async, fire-and-forget).  Reads prefer IndexedDB on cold-start so
 * that Safari PWA standalone-mode (which can wipe localStorage) still
 * has data, falling back to localStorage if IDB is empty or slower.
 *
 * Exported helpers keep the same key/value API as raw localStorage so
 * call-sites need minimal changes.
 */

import { idbSet, idbGet, idbDelete } from './idb'
import type { WorkoutData, WorkoutSession } from '../types'

// ─── keys ─────────────────────────────────────────────────────────────────────
export const STORAGE_KEY = 'workout_data'
export const DRAFT_KEY   = 'workout_draft'

// ─── Workout data ──────────────────────────────────────────────────────────────

/** Synchronous read from localStorage (used for instant initialisation). */
export function loadDataSync(): WorkoutData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as WorkoutData
      if (parsed && Array.isArray(parsed.sessions)) return parsed
    }
  } catch { /* ignore */ }
  return { sessions: [], customExercises: [] }
}

/**
 * Async read from IndexedDB.
 * Returns null if IDB has no entry yet.
 */
export function loadDataAsync(): Promise<WorkoutData | null> {
  return idbGet<WorkoutData>(STORAGE_KEY)
}

/**
 * Write to localStorage immediately, then to IndexedDB in the background.
 * Never throws — IDB failures are logged but silently swallowed.
 */
export function saveData(data: WorkoutData): void {
  // 1. Sync write — the app can read this back instantly
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch (e) {
    console.warn('[storage] localStorage write failed', e)
  }
  // 2. Async write — fire-and-forget
  idbSet(STORAGE_KEY, data).catch(() => {/* already warned inside idbSet */})
}

/**
 * Erase all workout data from both stores.
 */
export function clearData(): void {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
  idbDelete(STORAGE_KEY).catch(() => {})
}

// ─── Draft (in-progress workout) ──────────────────────────────────────────────

/** Synchronous read of the current draft. */
export function loadDraftSync(): WorkoutSession | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as WorkoutSession
      if (parsed && parsed.id && Array.isArray(parsed.exercises)) return parsed
    }
  } catch { /* ignore */ }
  return null
}

/** Async read of the draft from IndexedDB. */
export function loadDraftAsync(): Promise<WorkoutSession | null> {
  return idbGet<WorkoutSession>(DRAFT_KEY)
}

/**
 * Persist the in-progress draft to both stores.
 * Called on every set addition so no work is ever lost.
 */
export function saveDraft(session: WorkoutSession): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(session))
  } catch (e) {
    console.warn('[storage] draft localStorage write failed', e)
  }
  idbSet(DRAFT_KEY, session).catch(() => {})
}

/** Remove the draft from both stores after a workout is finalised. */
export function clearDraft(): void {
  try { localStorage.removeItem(DRAFT_KEY) } catch { /* ignore */ }
  idbDelete(DRAFT_KEY).catch(() => {})
}

// ─── Hydration helper ─────────────────────────────────────────────────────────

/**
 * Pick the "best" WorkoutData from two candidates.
 *
 * "Best" = most sessions.  If equal, prefer `a` (the already-loaded one).
 * This lets callers upgrade the in-memory state when IDB returns later
 * without losing local edits that happened in the meantime.
 */
export function mergeWorkoutData(a: WorkoutData, b: WorkoutData | null): WorkoutData {
  if (!b) return a
  // Choose whichever has more sessions; on a tie keep `a` (already displayed)
  if (b.sessions.length > a.sessions.length) {
    // Back-fill localStorage so both stores are now in sync
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(b)) } catch { /* ignore */ }
    return b
  }
  return a
}

/**
 * Pick the "best" draft from two candidates.
 * Prefer whichever has more exercises logged; fall back to `a`.
 */
export function mergeDraft(
  a: WorkoutSession | null,
  b: WorkoutSession | null,
): WorkoutSession | null {
  if (!a && !b) return null
  if (!a) return b
  if (!b) return a
  const countA = a.exercises.reduce((s, e) => s + e.sets.length, 0)
  const countB = b.exercises.reduce((s, e) => s + e.sets.length, 0)
  if (countB > countA) {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(b)) } catch { /* ignore */ }
    return b
  }
  return a
}

// ─── Exercise usage frequency ──────────────────────────────────────────────────
// Stored as Record<"category/name", count> under USAGE_KEY in both stores.

export const USAGE_KEY = 'exercise_usage'

export type UsageMap = Record<string, number>

/** Load usage map synchronously from localStorage. */
export function loadUsageSync(): UsageMap {
  try {
    const raw = localStorage.getItem(USAGE_KEY)
    if (raw) return JSON.parse(raw) as UsageMap
  } catch { /* ignore */ }
  return {}
}

/** Increment the count for one exercise and persist to both stores. */
export function incrementUsage(category: string, name: string): UsageMap {
  const key = `${category}/${name}`
  const map = loadUsageSync()
  map[key] = (map[key] ?? 0) + 1
  try { localStorage.setItem(USAGE_KEY, JSON.stringify(map)) } catch { /* ignore */ }
  idbSet(USAGE_KEY, map).catch(() => {})
  return map
}

/** Clear usage data from both stores (called from resetData). */
export function clearUsage(): void {
  try { localStorage.removeItem(USAGE_KEY) } catch { /* ignore */ }
  idbDelete(USAGE_KEY).catch(() => {})
}

// ─── Body weight (for calorie calculation) ────────────────────────────────────

export const BODY_WEIGHT_KEY = 'body_weight'
export const DEFAULT_BODY_WEIGHT = 63

export function loadBodyWeight(): number {
  try {
    const raw = localStorage.getItem(BODY_WEIGHT_KEY)
    if (raw) {
      const v = parseFloat(raw)
      if (!isNaN(v) && v > 0) return v
    }
  } catch { /* ignore */ }
  return DEFAULT_BODY_WEIGHT
}

export function saveBodyWeight(kg: number): void {
  try { localStorage.setItem(BODY_WEIGHT_KEY, String(kg)) } catch { /* ignore */ }
}

// ─── Age (profile) ────────────────────────────────────────────────────────────

export const AGE_KEY = 'user_age'
export const DEFAULT_AGE = 24

export function loadAge(): number {
  try {
    const raw = localStorage.getItem(AGE_KEY)
    if (raw) {
      const v = parseInt(raw)
      if (!isNaN(v) && v > 0) return v
    }
  } catch { /* ignore */ }
  return DEFAULT_AGE
}

export function saveAge(age: number): void {
  try { localStorage.setItem(AGE_KEY, String(age)) } catch { /* ignore */ }
}

// ─── Rest seconds between sets (for calorie calculation) ─────────────────────

export const REST_SECONDS_KEY = 'rest_seconds'
export const DEFAULT_REST_SECONDS = 90

export function loadRestSeconds(): number {
  try {
    const raw = localStorage.getItem(REST_SECONDS_KEY)
    if (raw) {
      const v = parseInt(raw)
      if (!isNaN(v) && v >= 0) return v
    }
  } catch { /* ignore */ }
  return DEFAULT_REST_SECONDS
}

export function saveRestSeconds(sec: number): void {
  try { localStorage.setItem(REST_SECONDS_KEY, String(sec)) } catch { /* ignore */ }
}
