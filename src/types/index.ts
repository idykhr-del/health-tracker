export interface BodyRecord {
  id: string
  date: string
  time?: string
  weight: number
  fatMass?: number
  muscleMass?: number
  boneMass?: number
  hydration?: number
  bmi?: number
  fatFreeMass?: number
  bodyFatPct?: number
  visceralFat?: number   // 内臓脂肪指数 (meastype 170)
  bmr?: number           // 基礎代謝率 kcal (meastype 226)
  metabolicAge?: number  // 代謝年齢 (meastype 227)
  source: 'withings_csv' | 'manual'
}

export interface SleepRecord {
  id: string
  date: string
  bedtime?: string
  waketime?: string
  inBedMinutes?: number
  asleepMinutes?: number
  awakeMinutes?: number
  sleepScore?: number
  quality?: number
  deepMinutes?: number
  remMinutes?: number
  lightMinutes?: number
  wakingBPM?: number
  hrv?: number
  spo2Avg?: number
  spo2Min?: number
  respAvg?: number
  source: 'autosleep_csv' | 'health_auto_export' | 'shortcut' | 'manual'
}

export interface Goals {
  targetWeight?: number
  targetBodyFatPct?: number
  targetMuscleMass?: number
}

export interface BodyData {
  bodyRecords: BodyRecord[]
  sleepRecords: SleepRecord[]
  goals: Goals
}

// Workout types — mirrors workout-tracker's WorkoutSession shape
export interface WorkoutSet {
  id: string
  weight?: number
  reps?: number
  durationMinutes?: number
  distanceKm?: number
}

export interface ExerciseEntry {
  category: string
  name: string
  sets: WorkoutSet[]
}

export interface WorkoutSession {
  id: string
  date: string
  startTime: string
  endTime?: string
  rating?: number
  memo?: string
  exercises: ExerciseEntry[]
}

export interface WorkoutData {
  sessions: WorkoutSession[]
  customExercises: { category: string; name: string }[]
}

export interface ImportHistoryEntry {
  id: string
  timestamp: string
  source: string
  count: number
  type: 'body' | 'sleep' | 'workout'
}

export type SleepImportMethod = 'A' | 'B' | 'C'

export interface AppSettings {
  sleepImportMethod: SleepImportMethod
  importHistory: ImportHistoryEntry[]
}

// ── Withings OAuth2 ───────────────────────────────────────────────────────────

export interface WithingsTokens {
  access_token:  string
  refresh_token: string
  userid:        string
  expires_at:    number  // Unix timestamp (seconds)
}

export type WithingsSyncStatus = 'idle' | 'syncing' | 'success' | 'error'

// ── AutoSleep 取り込み履歴 ────────────────────────────────────────────────────

export interface AutoSleepMethodStat {
  date:  string   // 最終取り込み日 (YYYY-MM-DD)
  count: number   // 取り込み件数
}

export interface AutoSleepLastImport {
  A?: AutoSleepMethodStat
  B?: AutoSleepMethodStat
}
