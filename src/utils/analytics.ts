import type { BodyRecord, SleepRecord, WorkoutSession } from '../types'

// ── helpers ───────────────────────────────────────────────────────────────────

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

function avg(arr: number[]): number {
  if (!arr.length) return 0
  return arr.reduce((s, v) => s + v, 0) / arr.length
}

function movingAvg(values: number[], window: number): number[] {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - window + 1), i + 1)
    return avg(slice)
  })
}

// ── Weekly change summary ─────────────────────────────────────────────────────

export interface WeeklyChange {
  weightChange: number | null
  bodyFatChange: number | null
  muscleChange: number | null
  latestWeight: number | null
  latestBodyFat: number | null
  latestMuscle: number | null
}

export function calcWeeklyChange(bodyRecords: BodyRecord[]): WeeklyChange {
  const sorted = [...bodyRecords].sort((a, b) => b.date.localeCompare(a.date))
  const latest = sorted[0]
  const sevenDaysAgo = latest ? addDays(latest.date, -7) : null
  const prev = sevenDaysAgo ? sorted.find(r => r.date <= sevenDaysAgo) : null

  const diff = (a?: number, b?: number) =>
    a != null && b != null ? parseFloat((a - b).toFixed(2)) : null

  return {
    latestWeight:  latest?.weight ?? null,
    latestBodyFat: latest?.bodyFatPct ?? null,
    latestMuscle:  latest?.muscleMass ?? null,
    weightChange:  diff(latest?.weight,    prev?.weight),
    bodyFatChange: diff(latest?.bodyFatPct, prev?.bodyFatPct),
    muscleChange:  diff(latest?.muscleMass, prev?.muscleMass),
  }
}

// ── Weight change day after training ─────────────────────────────────────────

export function calcPostWorkoutWeightChange(
  bodyRecords: BodyRecord[],
  sessions: WorkoutSession[],
): number | null {
  const bodyMap = new Map(bodyRecords.map(r => [r.date, r.weight]))
  const workoutDates = new Set(sessions.map(s => s.date))

  const diffs: number[] = []
  for (const date of workoutDates) {
    const nextDay = addDays(date, 1)
    const w0 = bodyMap.get(date)
    const w1 = bodyMap.get(nextDay)
    if (w0 != null && w1 != null) diffs.push(w1 - w0)
  }

  return diffs.length ? parseFloat(avg(diffs).toFixed(2)) : null
}

// ── Sleep score vs training performance ──────────────────────────────────────

export interface SleepPerformanceRow {
  sleepBand: string
  avgRating: number
  count: number
}

export function calcSleepVsPerformance(
  sleepRecords: SleepRecord[],
  sessions: WorkoutSession[],
): SleepPerformanceRow[] {
  const sleepMap = new Map(sleepRecords.map(r => [r.date, r.sleepScore]))
  const bands: Record<string, number[]> = {
    '90+': [], '80-89': [], '70-79': [], '60-69': [], '<60': [],
  }

  for (const s of sessions) {
    const score = sleepMap.get(s.date)
    if (score == null || s.rating == null) continue
    if (score >= 90)      bands['90+'].push(s.rating)
    else if (score >= 80) bands['80-89'].push(s.rating)
    else if (score >= 70) bands['70-79'].push(s.rating)
    else if (score >= 60) bands['60-69'].push(s.rating)
    else                  bands['<60'].push(s.rating)
  }

  return Object.entries(bands)
    .filter(([, ratings]) => ratings.length > 0)
    .map(([sleepBand, ratings]) => ({
      sleepBand,
      avgRating: parseFloat(avg(ratings).toFixed(1)),
      count: ratings.length,
    }))
}

// ── Body part frequency vs muscle mass change ─────────────────────────────────

export interface CategoryMuscleRow {
  category: string
  sessions: number
  muscleChange: number | null
}

export function calcCategoryVsMuscle(
  bodyRecords: BodyRecord[],
  workoutSessions: WorkoutSession[],
): CategoryMuscleRow[] {
  const sorted = [...bodyRecords].sort((a, b) => a.date.localeCompare(b.date))
  if (sorted.length < 2) return []

  const first = sorted[0]
  const last  = sorted[sorted.length - 1]
  const totalMuscleChange = (last.muscleMass != null && first.muscleMass != null)
    ? last.muscleMass - first.muscleMass : null

  const categoryCount: Record<string, number> = {}
  for (const s of workoutSessions) {
    const cats = new Set(s.exercises.map(e => e.category))
    for (const cat of cats) {
      categoryCount[cat] = (categoryCount[cat] ?? 0) + 1
    }
  }

  const total = Object.values(categoryCount).reduce((a, b) => a + b, 0) || 1

  return Object.entries(categoryCount).map(([category, count]) => ({
    category,
    sessions: count,
    muscleChange: totalMuscleChange != null
      ? parseFloat(((totalMuscleChange * count) / total).toFixed(2)) : null,
  })).sort((a, b) => b.sessions - a.sessions)
}

// ── 7-day moving average for sleep time and HRV ───────────────────────────────

export interface SleepTrendPoint {
  date: string
  asleepMinutes: number | null
  hrv: number | null
  asleepMA: number
  hrvMA: number
}

export function calcSleepTrend(sleepRecords: SleepRecord[]): SleepTrendPoint[] {
  const sorted = [...sleepRecords].sort((a, b) => a.date.localeCompare(b.date))
  const asleepVals = sorted.map(r => r.asleepMinutes ?? 0)
  const hrvVals    = sorted.map(r => r.hrv ?? 0)
  const asleepMA   = movingAvg(asleepVals, 7)
  const hrvMA      = movingAvg(hrvVals, 7)

  return sorted.map((r, i) => ({
    date:          r.date,
    asleepMinutes: r.asleepMinutes ?? null,
    hrv:           r.hrv ?? null,
    asleepMA:      parseFloat(asleepMA[i].toFixed(1)),
    hrvMA:         parseFloat(hrvMA[i].toFixed(1)),
  }))
}

// ── Exercise effectiveness ranking (last 14 days) ─────────────────────────────

export interface ExerciseEffectivenessRow {
  name: string
  category: string
  muscleChange: number
  sessionCount: number
}

export function calcExerciseEffectiveness(
  bodyRecords: BodyRecord[],
  sessions: WorkoutSession[],
): ExerciseEffectivenessRow[] {
  const bodyMap = new Map(bodyRecords.map(r => [r.date, r.muscleMass]))
  const now = new Date().toISOString().slice(0, 10)
  const cutoff = addDays(now, -14)

  const recentSessions = sessions.filter(s => s.date >= cutoff)

  const exerciseMap: Record<string, { category: string; changes: number[]; count: number }> = {}

  for (const s of recentSessions) {
    // Measure muscle change in the 2 days after the session
    const m0 = bodyMap.get(s.date)
    const m1 = bodyMap.get(addDays(s.date, 1)) ?? bodyMap.get(addDays(s.date, 2))
    const change = m0 != null && m1 != null ? m1 - m0 : null

    for (const ex of s.exercises) {
      const key = `${ex.category}/${ex.name}`
      if (!exerciseMap[key]) exerciseMap[key] = { category: ex.category, changes: [], count: 0 }
      exerciseMap[key].count++
      if (change != null) exerciseMap[key].changes.push(change)
    }
  }

  return Object.entries(exerciseMap)
    .map(([key, v]) => ({
      name: key.split('/')[1],
      category: v.category,
      muscleChange: v.changes.length ? parseFloat(avg(v.changes).toFixed(3)) : 0,
      sessionCount: v.count,
    }))
    .sort((a, b) => b.muscleChange - a.muscleChange)
    .slice(0, 10)
}
