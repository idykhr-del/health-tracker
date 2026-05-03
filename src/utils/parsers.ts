import type { BodyRecord, SleepRecord, WorkoutData } from '../types'

function uuid(): string {
  return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)
}

// ── Withings Body Smart CSV ───────────────────────────────────────────────────
// Header: Date,Weight (kg),Fat mass (kg),Bone mass (kg),Muscle mass (kg),Hydration (kg),BMI,Fat Free Mass (kg)

export function parseWithingsCSV(text: string): BodyRecord[] {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) return []

  const records: BodyRecord[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim())
    if (cols.length < 2) continue

    const [date, weightRaw, fatMassRaw, boneMassRaw, muscleMassRaw, hydrationRaw, bmiRaw, fatFreeMassRaw] = cols
    if (!date) continue

    const weight = parseFloat(weightRaw)
    if (isNaN(weight)) continue

    const fatMass    = parseFloat(fatMassRaw)
    const boneMass   = parseFloat(boneMassRaw)
    const muscleMass = parseFloat(muscleMassRaw)
    const hydration  = parseFloat(hydrationRaw)
    const bmi        = parseFloat(bmiRaw)
    const fatFreeMass= parseFloat(fatFreeMassRaw)
    const bodyFatPct = !isNaN(fatMass) && weight > 0 ? parseFloat(((fatMass / weight) * 100).toFixed(1)) : undefined

    records.push({
      id: uuid(),
      date,
      weight,
      fatMass:     isNaN(fatMass)     ? undefined : fatMass,
      boneMass:    isNaN(boneMass)    ? undefined : boneMass,
      muscleMass:  isNaN(muscleMass)  ? undefined : muscleMass,
      hydration:   isNaN(hydration)   ? undefined : hydration,
      bmi:         isNaN(bmi)         ? undefined : bmi,
      fatFreeMass: isNaN(fatFreeMass) ? undefined : fatFreeMass,
      bodyFatPct,
      source: 'withings_csv',
    })
  }
  return records
}

// ── AutoSleep History Export CSV ──────────────────────────────────────────────
// ISO8601,Bedtime,Waketime,InBed,Asleep,Quality,SleepScore,Deep,Rem,Light,WakingBPM,HRV,SpO2Avg,SpO2Min,RespAvg

function hhmmssToMinutes(s: string): number {
  if (!s) return NaN
  const parts = s.split(':').map(Number)
  if (parts.length === 3) return parts[0] * 60 + parts[1] + parts[2] / 60
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return NaN
}

export function parseAutoSleepCSV(text: string): SleepRecord[] {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) return []

  const records: SleepRecord[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim())
    if (cols.length < 5) continue

    const [iso8601, bedtime, waketime, inBed, asleep, quality, sleepScore, deep, rem, light, wakingBPM, hrv, spo2Avg, spo2Min, respAvg] = cols
    if (!iso8601) continue

    // Extract date from ISO8601 (e.g. "2026-05-01T00:00:00+09:00" → "2026-05-01")
    const date = iso8601.slice(0, 10)

    records.push({
      id: uuid(),
      date,
      bedtime:       bedtime || undefined,
      waketime:      waketime || undefined,
      inBedMinutes:  isNaN(hhmmssToMinutes(inBed)) ? undefined : Math.round(hhmmssToMinutes(inBed)),
      asleepMinutes: isNaN(hhmmssToMinutes(asleep)) ? undefined : Math.round(hhmmssToMinutes(asleep)),
      quality:       parseFloat(quality) || undefined,
      sleepScore:    parseFloat(sleepScore) || undefined,
      deepMinutes:   isNaN(hhmmssToMinutes(deep)) ? undefined : Math.round(hhmmssToMinutes(deep)),
      remMinutes:    isNaN(hhmmssToMinutes(rem)) ? undefined : Math.round(hhmmssToMinutes(rem)),
      lightMinutes:  isNaN(hhmmssToMinutes(light)) ? undefined : Math.round(hhmmssToMinutes(light)),
      wakingBPM:     parseFloat(wakingBPM) || undefined,
      hrv:           parseFloat(hrv) || undefined,
      spo2Avg:       parseFloat(spo2Avg) || undefined,
      spo2Min:       parseFloat(spo2Min) || undefined,
      respAvg:       parseFloat(respAvg) || undefined,
      source: 'autosleep_csv',
    })
  }
  return records
}

// ── Health Auto Export JSON ───────────────────────────────────────────────────

interface HaeDataPoint {
  date: string
  inBedStart?: string
  inBedEnd?: string
  inBed?: number
  deep?: number
  rem?: number
  core?: number
  awake?: number
  sleepScore?: number
}

interface HaeRoot {
  data?: {
    metrics?: {
      name: string
      data: HaeDataPoint[]
    }[]
  }
}

function parseDatetime(s: string): string {
  // "2026-05-01 07:00:00 +0900" → "2026-05-01"
  return s.slice(0, 10)
}

function extractBedtime(s?: string): string | undefined {
  if (!s) return undefined
  // "2026-04-30 23:15:00 +0900" → "23:15"
  const m = s.match(/\d{2}:\d{2}/)
  return m ? m[0] : undefined
}

export function parseHealthAutoExportJSON(text: string): SleepRecord[] {
  let root: HaeRoot
  try { root = JSON.parse(text) as HaeRoot } catch { return [] }

  const metrics = root?.data?.metrics
  if (!Array.isArray(metrics)) return []

  const sleepMetric = metrics.find(m => m.name === 'sleep_analysis')
  if (!sleepMetric) return []

  return sleepMetric.data.map((d): SleepRecord => {
    const date = parseDatetime(d.date)
    const inBedMinutes   = d.inBed   != null ? Math.round(d.inBed * 60)   : undefined
    const deepMinutes    = d.deep    != null ? Math.round(d.deep * 60)    : undefined
    const remMinutes     = d.rem     != null ? Math.round(d.rem * 60)     : undefined
    const lightMinutes   = d.core    != null ? Math.round(d.core * 60)    : undefined
    const awakeMinutes   = d.awake   != null ? Math.round(d.awake * 60)   : undefined
    const asleepMinutes  = inBedMinutes != null && awakeMinutes != null
      ? inBedMinutes - awakeMinutes : undefined

    return {
      id: uuid(),
      date,
      bedtime:       extractBedtime(d.inBedStart),
      waketime:      extractBedtime(d.inBedEnd),
      inBedMinutes,
      asleepMinutes,
      awakeMinutes,
      deepMinutes,
      remMinutes,
      lightMinutes,
      sleepScore:    d.sleepScore,
      source: 'health_auto_export',
    }
  })
}

// ── workout-tracker JSON export ───────────────────────────────────────────────

export function parseWorkoutJSON(text: string): WorkoutData | null {
  try {
    const parsed = JSON.parse(text) as WorkoutData
    if (parsed && Array.isArray(parsed.sessions)) return parsed
  } catch { /* ignore */ }
  return null
}
