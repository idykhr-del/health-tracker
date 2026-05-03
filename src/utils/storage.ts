import { idbSet, idbGet, idbDelete } from './idb'
import type { BodyData, AppSettings, WorkoutData } from '../types'

export const BODY_KEY     = 'body_data'
export const SETTINGS_KEY = 'health_settings'
export const WORKOUT_KEY  = 'workout_data'  // shared key with workout-tracker

const MAX_RECORDS = 365

// ── BodyData ──────────────────────────────────────────────────────────────────

const defaultBody = (): BodyData => ({
  bodyRecords: [],
  sleepRecords: [],
  goals: {},
})

export function loadBodySync(): BodyData {
  try {
    const raw = localStorage.getItem(BODY_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as BodyData
      if (parsed && Array.isArray(parsed.bodyRecords)) return parsed
    }
  } catch { /* ignore */ }
  return defaultBody()
}

export function saveBody(data: BodyData): void {
  // Trim to MAX_RECORDS — keep most recent
  const trimmed: BodyData = {
    ...data,
    bodyRecords: [...data.bodyRecords]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, MAX_RECORDS),
    sleepRecords: [...data.sleepRecords]
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, MAX_RECORDS),
  }
  try { localStorage.setItem(BODY_KEY, JSON.stringify(trimmed)) } catch (e) {
    console.warn('[storage] body write failed', e)
  }
  idbSet(BODY_KEY, trimmed).catch(() => {})
}

export function loadBodyAsync(): Promise<BodyData | null> {
  return idbGet<BodyData>(BODY_KEY)
}

export function clearBody(): void {
  try { localStorage.removeItem(BODY_KEY) } catch { /* ignore */ }
  idbDelete(BODY_KEY).catch(() => {})
}

// ── AppSettings ───────────────────────────────────────────────────────────────

const defaultSettings = (): AppSettings => ({
  sleepImportMethod: 'C',
  importHistory: [],
})

export function loadSettingsSync(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (raw) return JSON.parse(raw) as AppSettings
  } catch { /* ignore */ }
  return defaultSettings()
}

export function saveSettings(s: AppSettings): void {
  // Keep last 100 import history entries
  const trimmed = { ...s, importHistory: s.importHistory.slice(-100) }
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(trimmed)) } catch (e) {
    console.warn('[storage] settings write failed', e)
  }
  idbSet(SETTINGS_KEY, trimmed).catch(() => {})
}

// ── WorkoutData (read-only from workout-tracker) ──────────────────────────────

export function loadWorkoutSync(): WorkoutData {
  try {
    const raw = localStorage.getItem(WORKOUT_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as WorkoutData
      if (parsed && Array.isArray(parsed.sessions)) return parsed
    }
  } catch { /* ignore */ }
  return { sessions: [], customExercises: [] }
}

export function loadWorkoutAsync(): Promise<WorkoutData | null> {
  return idbGet<WorkoutData>(WORKOUT_KEY)
}
