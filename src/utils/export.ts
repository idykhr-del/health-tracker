import type { BodyRecord, SleepRecord, WorkoutSession } from '../types'

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

function avg(arr: number[]): number {
  if (!arr.length) return 0
  return arr.reduce((s, v) => s + v, 0) / arr.length
}

// ── Build 90-day export JSON for Claude.ai ────────────────────────────────────

export function buildClaudeExportJSON(
  bodyRecords: BodyRecord[],
  sleepRecords: SleepRecord[],
  sessions: WorkoutSession[],
): string {
  const now = new Date()
  const cutoff = addDays(now.toISOString().slice(0, 10), -90)

  const recentBody  = bodyRecords.filter(r => r.date >= cutoff)
    .sort((a, b) => a.date.localeCompare(b.date))
  const recentSleep = sleepRecords.filter(r => r.date >= cutoff)
    .sort((a, b) => a.date.localeCompare(b.date))
  const recentWork  = sessions.filter(s => s.date >= cutoff)
    .sort((a, b) => a.date.localeCompare(b.date))

  const firstDate = [
    recentBody[0]?.date,
    recentSleep[0]?.date,
    recentWork[0]?.date,
  ].filter(Boolean).sort()[0] ?? cutoff

  const weights = recentBody.map(r => r.weight).filter(Boolean)
  const muscles = recentBody.map(r => r.muscleMass).filter((v): v is number => v != null)
  const sleepScores = recentSleep.map(r => r.sleepScore).filter((v): v is number => v != null)

  const summary = {
    totalWorkoutSessions: recentWork.length,
    avgSleepScore: sleepScores.length ? Math.round(avg(sleepScores)) : null,
    weightChange: weights.length >= 2
      ? parseFloat((weights[weights.length - 1] - weights[0]).toFixed(2)) : null,
    muscleChange: muscles.length >= 2
      ? parseFloat((muscles[muscles.length - 1] - muscles[0]).toFixed(2)) : null,
  }

  const bodyData = recentBody.map(r => ({
    date:        r.date,
    weight:      r.weight,
    bodyFatPct:  r.bodyFatPct,
    muscleMass:  r.muscleMass,
    bmi:         r.bmi,
  }))

  const sleepData = recentSleep.map(r => ({
    date:              r.date,
    sleepScore:        r.sleepScore,
    totalSleepMinutes: r.asleepMinutes,
    deepMinutes:       r.deepMinutes,
    remMinutes:        r.remMinutes,
    hrv:               r.hrv,
    wakingBPM:         r.wakingBPM,
  }))

  const workoutData = recentWork.map(s => {
    const categories = [...new Set(s.exercises.map(e => e.category))]
    const exercises = s.exercises.map(ex => {
      const weights2 = ex.sets.map(st => st.weight ?? 0)
      const maxWeight = weights2.length ? Math.max(...weights2) : 0
      const totalVol  = ex.sets.reduce((sum, st) => sum + (st.weight ?? 0) * (st.reps ?? 0), 0)
      return { name: ex.name, sets: ex.sets.length, maxWeight, totalVolume: totalVol }
    })
    let durationMinutes: number | undefined
    if (s.startTime && s.endTime) {
      const diff = (new Date(s.endTime).getTime() - new Date(s.startTime).getTime()) / 60000
      if (diff > 0) durationMinutes = Math.round(diff)
    }
    return { date: s.date, categories, exercises, rating: s.rating, durationMinutes }
  })

  const exportObj = {
    exportedAt: now.toISOString(),
    period: `${firstDate} 〜 ${now.toISOString().slice(0, 10)}`,
    summary,
    bodyData,
    sleepData,
    workoutData,
  }

  return JSON.stringify(exportObj, null, 2)
}

export function buildClaudePrompt(jsonData: string): string {
  return `以下は私の過去90日間の健康データです。\n体組成（Withings Body Smart）・睡眠（AutoSleep）・筋トレ記録（workout-tracker）が含まれます。\n\n以下の観点で日本語で分析・アドバイスしてください：\n1. 体型の変化トレンドと主な要因\n2. 効果が出ている種目・部位の特定\n3. 今後おすすめのトレーニング種目・頻度の提案\n4. 睡眠とトレーニングパフォーマンスの相関\n5. 睡眠・運動・体型を統合した総合健康アドバイス\n\n【データ】\n${jsonData}`
}

// ── Full CSV export (all data) ─────────────────────────────────────────────────

export function exportBodyCSV(records: BodyRecord[]): string {
  const header = 'Date,Weight,BodyFatPct,MuscleMass,BoneMass,BMI,Source'
  const rows = [...records]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(r => [
      r.date, r.weight, r.bodyFatPct ?? '', r.muscleMass ?? '',
      r.boneMass ?? '', r.bmi ?? '', r.source,
    ].join(','))
  return [header, ...rows].join('\n')
}

export function exportSleepCSV(records: SleepRecord[]): string {
  const header = 'Date,Bedtime,Waketime,AsleepMinutes,SleepScore,DeepMinutes,RemMinutes,HRV,SpO2Avg,Source'
  const rows = [...records]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(r => [
      r.date, r.bedtime ?? '', r.waketime ?? '', r.asleepMinutes ?? '',
      r.sleepScore ?? '', r.deepMinutes ?? '', r.remMinutes ?? '',
      r.hrv ?? '', r.spo2Avg ?? '', r.source,
    ].join(','))
  return [header, ...rows].join('\n')
}

export function downloadFile(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
