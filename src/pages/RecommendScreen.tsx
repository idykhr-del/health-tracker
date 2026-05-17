/**
 * RecommendScreen — API不要のデータドリブン分析画面
 * 全ロジックはフロントエンドのみで完結する純粋な関数で実装。
 */
import { useMemo } from 'react'
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import type { WorkoutData, WorkoutSession, Category } from '../types'
import { CATEGORY_ICONS, DEFAULT_EXERCISES } from '../data/exercises'
import {
  getSessionCaloriesData,
  calcCardioSetCalories,
  calcStrengthSetCalories,
} from '../utils/calorieCalc'

// 分析対象を筋トレ5部位に限定（有酸素・腹筋・お尻は対象外）
const ANALYSIS_CATEGORIES: Category[] = ['胸', '背中', '脚', '腕', '肩']

interface Props {
  data: WorkoutData
  bodyWeight: number
}

// ─── tiny helpers ──────────────────────────────────────────────────────────────

function daysBetween(a: Date, b: Date) {
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000)
}

function startOfWeek(d: Date): Date {
  const r = new Date(d)
  const dow = r.getDay()
  r.setDate(r.getDate() - (dow === 0 ? 6 : dow - 1))
  r.setHours(0, 0, 0, 0)
  return r
}

/** Volume unit: strength → weight×reps, cardio → minutes×5 (rough equiv.) */
function setVolume(set: { weight?: number; reps?: number; durationMinutes?: number }): number {
  if (set.weight != null && set.reps != null) return set.weight * set.reps
  if (set.durationMinutes != null) return set.durationMinutes * 5
  return 0
}

function sessionVolume(s: WorkoutSession): number {
  return s.exercises.reduce(
    (sum, e) => sum + e.sets.reduce((s2, set) => s2 + setVolume(set), 0), 0,
  )
}

function categoryVolume(sessions: WorkoutSession[], cat: Category): number {
  return sessions.reduce((sum, s) =>
    sum + s.exercises
      .filter(e => e.category === cat)
      .reduce((s2, e) => s2 + e.sets.reduce((s3, set) => s3 + setVolume(set), 0), 0),
  0)
}

// ─── ① 今日のおすすめ種目 ─────────────────────────────────────────────────────

type DayRec = { category: Category; daysSince: number | null; icon: string }

function computeDayRec(sessions: WorkoutSession[], now: Date): DayRec[] {
  return ANALYSIS_CATEGORIES.map(cat => {
    const lastSession = [...sessions]
      .filter(s => s.exercises.some(e => e.category === cat))
      .sort((a, b) => b.date.localeCompare(a.date))[0]
    const daysSince = lastSession
      ? daysBetween(new Date(lastSession.date), now)
      : null
    return { category: cat, daysSince, icon: CATEGORY_ICONS[cat] }
  }).sort((a, b) => {
    if (a.daysSince === null && b.daysSince === null) return 0
    if (a.daysSince === null) return -1
    if (b.daysSince === null) return 1
    return b.daysSince - a.daysSince
  })
}

// ─── ② 部位バランス診断 ───────────────────────────────────────────────────────

type BalanceItem = { category: Category; volume: number; pct: number; isLow: boolean; icon: string }

function computeBalance(sessions: WorkoutSession[]): BalanceItem[] {
  const vols = ANALYSIS_CATEGORIES.map(cat => ({ category: cat, volume: categoryVolume(sessions, cat) }))
  const maxVol = Math.max(...vols.map(v => v.volume), 1)
  return vols.map(v => ({
    category: v.category,
    volume: Math.round(v.volume),
    pct: Math.round((v.volume / maxVol) * 100),
    isLow: v.volume > 0 && v.volume / maxVol < 0.2,
    icon: CATEGORY_ICONS[v.category],
  }))
}

// ─── ③ 週間トレーニング傾向 ───────────────────────────────────────────────────

type WeekItem = { label: string; sessions: number; volume: number }

function computeWeeklyTrend(sessions: WorkoutSession[], now: Date): {
  weeks: WeekItem[]
  comment: string | null
  warningConsecutive: boolean
} {
  const weeks: WeekItem[] = []
  for (let w = 3; w >= 0; w--) {
    const ws = new Date(startOfWeek(now))
    ws.setDate(ws.getDate() - w * 7)
    const we = new Date(ws); we.setDate(we.getDate() + 6); we.setHours(23, 59, 59)
    const inWeek = sessions.filter(s => {
      const d = new Date(s.date)
      return d >= ws && d <= we
    })
    const label = w === 0 ? '今週' : w === 1 ? '先週' : `${w}週前`
    weeks.push({
      label,
      sessions: inWeek.length,
      volume: Math.round(inWeek.reduce((s, sess) => s + sessionVolume(sess), 0)),
    })
  }

  const thisVol = weeks[3].volume
  const lastVol = weeks[2].volume
  let comment: string | null = null
  if (lastVol > 0 && thisVol > 0) {
    const delta = ((thisVol - lastVol) / lastVol) * 100
    if (Math.abs(delta) >= 10) {
      comment = delta > 0
        ? `先週より負荷が${Math.round(delta)}%増加しています`
        : `先週より負荷が${Math.round(-delta)}%減少しています`
    }
  }

  const sortedDates = [...new Set(sessions.map(s => s.date))].sort()
  let maxConsec = 0, consec = 1
  for (let i = 1; i < sortedDates.length; i++) {
    const prev = new Date(sortedDates[i - 1])
    const curr = new Date(sortedDates[i])
    if (daysBetween(prev, curr) === 1) { consec++; maxConsec = Math.max(maxConsec, consec) }
    else consec = 1
  }
  let currentStreak = 1
  for (let i = sortedDates.length - 1; i > 0; i--) {
    const prev = new Date(sortedDates[i - 1])
    const curr = new Date(sortedDates[i])
    if (daysBetween(prev, curr) === 1) currentStreak++
    else break
  }

  return { weeks, comment, warningConsecutive: currentStreak >= 5 || maxConsec >= 5 }
}

// ─── ④ 種目別の伸び率ランキング ───────────────────────────────────────────────

type ProgressItem = {
  name: string
  category: Category
  firstMax: number
  lastMax: number
  gain: number
  firstDate: string
  lastDate: string
}

function computeProgressRanking(sessions: WorkoutSession[], thirtyDaysAgo: Date): ProgressItem[] {
  const recentSessions = sessions.filter(s => new Date(s.date) >= thirtyDaysAgo)
  const exerciseData: Record<string, { category: Category; dates: { date: string; max: number }[] }> = {}

  for (const s of [...recentSessions].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const e of s.exercises) {
      if (!ANALYSIS_CATEGORIES.includes(e.category)) continue
      const weights = e.sets.map(set => set.weight ?? 0).filter(w => w > 0)
      if (weights.length === 0) continue
      const key = `${e.category}/${e.name}`
      if (!exerciseData[key]) exerciseData[key] = { category: e.category, dates: [] }
      exerciseData[key].dates.push({ date: s.date, max: Math.max(...weights) })
    }
  }

  const items: ProgressItem[] = []
  for (const [key, { category, dates }] of Object.entries(exerciseData)) {
    if (dates.length < 2) continue
    const first = dates[0]
    const last = dates[dates.length - 1]
    const gain = last.max - first.max
    if (gain <= 0) continue
    items.push({
      name: key.split('/')[1],
      category,
      firstMax: first.max,
      lastMax: last.max,
      gain,
      firstDate: first.date,
      lastDate: last.date,
    })
  }
  return items.sort((a, b) => b.gain - a.gain).slice(0, 3)
}

// ─── ⑤ 総合アドバイス ─────────────────────────────────────────────────────────

type AdviceItem = { text: string; icon: string; type: 'warning' | 'info' | 'success' }

function computeAdvice(
  sessions: WorkoutSession[],
  balance: BalanceItem[],
  progress: ProgressItem[],
  thirtyDaysAgo: Date,
  _now: Date,
): AdviceItem[] {
  const advice: AdviceItem[] = []

  if (sessions.length < 3) {
    return [{ text: '記録を続けると詳細な分析ができます。まずは3回のワークアウトを記録してみましょう！', icon: '📋', type: 'info' }]
  }

  const recentSessions = sessions.filter(s => new Date(s.date) >= thirtyDaysAgo)

  const missingCategories = ANALYSIS_CATEGORIES.filter(cat =>
    !recentSessions.some(s => s.exercises.some(e => e.category === cat))
  )
  for (const cat of missingCategories.slice(0, 2)) {
    advice.push({ text: `${cat}が直近1ヶ月で未記録です。意識的に取り入れてみましょう`, icon: '📌', type: 'warning' })
    if (advice.length >= 3) return advice
  }

  const lowBalance = balance.filter(b => b.isLow)
  for (const b of lowBalance.slice(0, 2)) {
    advice.push({
      text: `${b.category}の負荷が少なめです。種目を追加するか、重量・セット数を増やしてみましょう`,
      icon: '⚠️',
      type: 'warning',
    })
    if (advice.length >= 3) return advice
  }

  if (advice.length < 3) {
    for (const cat of ANALYSIS_CATEGORIES) {
      const catSessions = recentSessions.flatMap(s => s.exercises.filter(e => e.category === cat))
      if (catSessions.length < 3) continue
      const countMap: Record<string, number> = {}
      for (const e of catSessions) countMap[e.name] = (countMap[e.name] ?? 0) + 1
      const total = Object.values(countMap).reduce((a, b) => a + b, 0)
      const [topName, topCount] = Object.entries(countMap).sort((a, b) => b[1] - a[1])[0] ?? []
      if (topName && topCount / total >= 0.7) {
        const alts = DEFAULT_EXERCISES[cat].filter(n => n !== topName).slice(0, 2)
        advice.push({
          text: `${cat}は${topName}に偏っています。${alts.join('・')}などのバリエーションも取り入れると筋肉への刺激が増します`,
          icon: '🔄',
          type: 'info',
        })
        if (advice.length >= 3) return advice
        break
      }
    }
  }

  if (advice.length < 3 && recentSessions.length > 0) {
    const olderSessions = sessions.filter(s => new Date(s.date) < thirtyDaysAgo)
    const oldNames = new Set(olderSessions.flatMap(s => s.exercises.map(e => e.name)))
    const recentNames = new Set(recentSessions.flatMap(s => s.exercises.map(e => e.name)))
    const newNames = [...recentNames].filter(n => !oldNames.has(n))
    if (newNames.length === 0 && olderSessions.length > 0) {
      const underCat = balance.sort((a, b) => a.pct - b.pct)[0]?.category ?? '背中'
      const usedInUnder = new Set(recentSessions.flatMap(s =>
        s.exercises.filter(e => e.category === underCat).map(e => e.name)
      ))
      const suggested = (DEFAULT_EXERCISES[underCat] ?? []).find(n => !usedInUnder.has(n))
      advice.push({
        text: `新しい種目を試すと停滞を防げます。${underCat}部位では${suggested ?? 'バリエーション種目'}がおすすめです`,
        icon: '🆕',
        type: 'info',
      })
      if (advice.length >= 3) return advice
    }
  }

  if (advice.length < 3) {
    const stagnant = (() => {
      const exMap: Record<string, number[]> = {}
      for (const s of [...recentSessions].sort((a, b) => a.date.localeCompare(b.date))) {
        for (const e of s.exercises) {
          if (!ANALYSIS_CATEGORIES.includes(e.category)) continue
          const weights = e.sets.map(set => set.weight ?? 0).filter(w => w > 0)
          if (!weights.length) continue
          const key = e.name
          if (!exMap[key]) exMap[key] = []
          exMap[key].push(Math.max(...weights))
        }
      }
      return Object.entries(exMap)
        .filter(([, w]) => w.length >= 3 && Math.max(...w) === Math.min(...w))
        .map(([name]) => name)
    })()
    if (stagnant.length > 0) {
      advice.push({
        text: `${stagnant[0]}の重量が1ヶ月変化していません。重量・回数・セット数のいずれかを少し上げてみましょう`,
        icon: '📈',
        type: 'info',
      })
      if (advice.length >= 3) return advice
    }
  }

  if (advice.length < 3 && progress.length > 0) {
    advice.push({
      text: `${progress[0].name}が順調に伸びています（${progress[0].firstMax}kg→${progress[0].lastMax}kg）。このまま継続しましょう！`,
      icon: '🌟',
      type: 'success',
    })
  }

  if (advice.length === 0) {
    advice.push({ text: `バランスよくトレーニングできています。引き続き継続しましょう！`, icon: '✅', type: 'success' })
  }

  return advice.slice(0, 3)
}

// ─── ⑥ カロリーサマリー ───────────────────────────────────────────────────────

type CalSummary = {
  thisMonthTotal: number
  lastMonthTotal: number
  diff: number
  avgPerSession: number
  thisMonthCount: number
  hasData: boolean
}

function computeCalSummary(sessions: WorkoutSession[], now: Date, bodyWeight: number): CalSummary {
  const thisMonth    = new Date(now.getFullYear(), now.getMonth(), 1)
  const lastMonth    = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59)

  const thisMonthSessions = sessions.filter(s => new Date(s.date) >= thisMonth)
  const lastMonthSessions = sessions.filter(s => {
    const d = new Date(s.date); return d >= lastMonth && d <= lastMonthEnd
  })

  const thisTotal = thisMonthSessions.reduce(
    (sum, s) => sum + getSessionCaloriesData(s, bodyWeight).total, 0
  )
  const lastTotal = lastMonthSessions.reduce(
    (sum, s) => sum + getSessionCaloriesData(s, bodyWeight).total, 0
  )
  const allTotal = sessions.reduce(
    (sum, s) => sum + getSessionCaloriesData(s, bodyWeight).total, 0
  )
  const avgPerSession = sessions.length > 0 ? Math.round(allTotal / sessions.length) : 0

  return {
    thisMonthTotal: Math.round(thisTotal),
    lastMonthTotal: Math.round(lastTotal),
    diff:           Math.round(thisTotal - lastTotal),
    avgPerSession,
    thisMonthCount: thisMonthSessions.length,
    hasData: sessions.length > 0,
  }
}

// ─── ⑦ 週別カロリーグラフ ──────────────────────────────────────────────────────

type WeekCalItem = { label: string; strength: number; cardio: number }

function computeWeeklyCalories(sessions: WorkoutSession[], now: Date, bodyWeight: number): WeekCalItem[] {
  const weeks: WeekCalItem[] = []
  for (let w = 3; w >= 0; w--) {
    const ws = new Date(startOfWeek(now))
    ws.setDate(ws.getDate() - w * 7)
    const we = new Date(ws); we.setDate(we.getDate() + 6); we.setHours(23, 59, 59)
    const inWeek = sessions.filter(s => { const d = new Date(s.date); return d >= ws && d <= we })
    let strength = 0, cardio = 0
    for (const s of inWeek) {
      const cal = getSessionCaloriesData(s, bodyWeight)
      strength += cal.strength
      cardio   += cal.cardio
    }
    const label = w === 0 ? '今週' : w === 1 ? '先週' : `${w}週前`
    weeks.push({ label, strength: Math.round(strength), cardio: Math.round(cardio) })
  }
  return weeks
}

// ─── ⑧ セッション別カロリートレンド ─────────────────────────────────────────

type SessionCalTrend = { date: string; total: number }

function computeSessionCalTrend(
  sessions: WorkoutSession[],
  thirtyDaysAgo: Date,
  bodyWeight: number,
): SessionCalTrend[] {
  const recent = sessions.filter(s => new Date(s.date) >= thirtyDaysAgo)
  const byDate: Record<string, number> = {}
  for (const s of recent) {
    const cal = getSessionCaloriesData(s, bodyWeight)
    byDate[s.date] = (byDate[s.date] ?? 0) + cal.total
  }
  return Object.entries(byDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, total]) => ({ date: date.slice(5).replace('-', '/'), total: Math.round(total) }))
}

// ─── ⑨ 種目別カロリーランキング ──────────────────────────────────────────────

type ExCalItem = { name: string; category: Category; calories: number }

function computeExCalRanking(
  sessions: WorkoutSession[],
  thirtyDaysAgo: Date,
  bodyWeight: number,
): ExCalItem[] {
  const recent = sessions.filter(s => new Date(s.date) >= thirtyDaysAgo)
  const byEx: Record<string, { category: Category; calories: number }> = {}

  for (const s of recent) {
    for (const ex of s.exercises) {
      let cal = 0
      for (const set of ex.sets) {
        if (set.calories) {
          cal += set.calories
        } else if (ex.category === '有酸素' && set.durationMinutes) {
          cal += calcCardioSetCalories(ex.name, set.durationMinutes, set.distanceKm, set.incline, bodyWeight)
        } else if (ex.category !== '有酸素' && set.reps) {
          cal += calcStrengthSetCalories(ex.name, ex.category, set.reps, 90, bodyWeight)
        }
      }
      if (cal === 0) continue
      if (!byEx[ex.name]) byEx[ex.name] = { category: ex.category, calories: 0 }
      byEx[ex.name].calories += cal
    }
  }

  return Object.entries(byEx)
    .map(([name, data]) => ({ name, category: data.category, calories: Math.round(data.calories) }))
    .sort((a, b) => b.calories - a.calories)
    .slice(0, 5)
}

// ─── Custom tooltip ────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-surface border border-border rounded-xl px-3 py-2 text-xs shadow-xl">
      <div className="text-muted mb-1">{label}</div>
      {payload.map((p: { name: string; value: number; color: string }, i: number) => (
        <div key={i} style={{ color: p.color }} className="font-bold">{p.name}: {p.value}</div>
      ))}
    </div>
  )
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function RecommendScreen({ data, bodyWeight }: Props) {
  const now = useMemo(() => new Date(), [])
  const thirtyDaysAgo = useMemo(() => { const d = new Date(now); d.setDate(d.getDate() - 30); return d }, [now])

  const dayRec     = useMemo(() => computeDayRec(data.sessions, now), [data.sessions, now])
  const balance    = useMemo(() => computeBalance(data.sessions), [data.sessions])
  const weekly     = useMemo(() => computeWeeklyTrend(data.sessions, now), [data.sessions, now])
  const progress   = useMemo(() => computeProgressRanking(data.sessions, thirtyDaysAgo), [data.sessions, thirtyDaysAgo])
  const advice     = useMemo(() => computeAdvice(data.sessions, balance, progress, thirtyDaysAgo, now), [data.sessions, balance, progress, thirtyDaysAgo, now])
  const calSummary = useMemo(() => computeCalSummary(data.sessions, now, bodyWeight), [data.sessions, now, bodyWeight])
  const weekCal    = useMemo(() => computeWeeklyCalories(data.sessions, now, bodyWeight), [data.sessions, now, bodyWeight])
  const sessionCal = useMemo(() => computeSessionCalTrend(data.sessions, thirtyDaysAgo, bodyWeight), [data.sessions, thirtyDaysAgo, bodyWeight])
  const exCalRank  = useMemo(() => computeExCalRanking(data.sessions, thirtyDaysAgo, bodyWeight), [data.sessions, thirtyDaysAgo, bodyWeight])

  const totalSessions = data.sessions.length
  const hasWeekCalData = weekCal.some(w => w.strength + w.cardio > 0)

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-4 pt-4 pb-8 space-y-4">

        {/* ── ⓪ カロリーサマリーカード ── */}
        <div className="bg-card border border-border rounded-2xl p-4">
          <div className="text-xs text-muted mb-3 font-medium uppercase tracking-wider">🔥 カロリートラッキング</div>
          {!calSummary.hasData ? (
            <div className="text-muted text-sm text-center py-2">記録がありません</div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <div className="bg-surface rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted mb-1">今月の消費</div>
                  <div className="text-xl font-bold text-accentGreen">{calSummary.thisMonthTotal.toLocaleString()}</div>
                  <div className="text-[10px] text-muted">kcal</div>
                </div>
                <div className="bg-surface rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted mb-1">先月比</div>
                  <div className={`text-xl font-bold ${calSummary.diff >= 0 ? 'text-accentGreen' : 'text-red-400'}`}>
                    {calSummary.diff >= 0 ? '+' : ''}{calSummary.diff.toLocaleString()}
                  </div>
                  <div className="text-[10px] text-muted">kcal</div>
                </div>
                <div className="bg-surface rounded-xl p-3 text-center">
                  <div className="text-[10px] text-muted mb-1">平均/回</div>
                  <div className="text-xl font-bold text-accent">{calSummary.avgPerSession.toLocaleString()}</div>
                  <div className="text-[10px] text-muted">kcal</div>
                </div>
              </div>
              <div className="text-xs text-muted text-center">
                今月 {calSummary.thisMonthCount}回のワークアウト
              </div>
            </div>
          )}
        </div>

        {/* ── ① 今日のおすすめ種目 ── */}
        <div className="bg-card border border-border rounded-2xl p-4">
          <div className="text-xs text-muted mb-3 font-medium uppercase tracking-wider">
            💡 今日のおすすめ種目
          </div>
          {totalSessions === 0 ? (
            <div className="text-muted text-sm text-center py-2">記録がありません</div>
          ) : (
            <div className="space-y-2">
              {dayRec.slice(0, 4).map((rec, i) => (
                <div
                  key={rec.category}
                  className={`flex items-center justify-between px-3 py-2.5 rounded-xl border ${
                    i === 0 ? 'bg-accent/10 border-accent/40' : 'bg-surface border-border'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {i === 0 && <span className="text-accent text-xs font-bold">🏆</span>}
                    <span className="text-base">{rec.icon}</span>
                    <span className={`text-sm font-medium ${i === 0 ? 'text-accent' : 'text-white'}`}>
                      {rec.category}
                    </span>
                  </div>
                  <span className="text-xs text-muted">
                    {rec.daysSince === null ? '未記録' : rec.daysSince === 0 ? '今日実施済' : `${rec.daysSince}日前`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── ② 部位バランス診断 ── */}
        <div className="bg-card border border-border rounded-2xl p-4">
          <div className="text-xs text-muted mb-3 font-medium uppercase tracking-wider">
            ⚖️ 部位バランス診断（全期間）
          </div>
          {totalSessions === 0 ? (
            <div className="text-muted text-sm text-center py-2">記録がありません</div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={160}>
                <BarChart
                  layout="vertical"
                  data={balance.map(b => ({ name: `${b.icon}${b.category}`, pct: b.pct, isLow: b.isLow }))}
                  margin={{ top: 0, right: 16, left: 0, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2a4a" horizontal={false} />
                  <XAxis type="number" domain={[0, 100]} tick={{ fill: '#8892a4', fontSize: 10 }} tickFormatter={v => `${v}%`} />
                  <YAxis dataKey="name" type="category" width={68} tick={{ fill: '#e2e8f0', fontSize: 11 }} />
                  <Tooltip content={<ChartTooltip />} formatter={(v: number) => [`${v}%`, '負荷割合']} />
                  <Bar dataKey="pct" name="負荷割合" radius={[0, 4, 4, 0]} fill="#00d4ff" />
                </BarChart>
              </ResponsiveContainer>
              {balance.some(b => b.isLow) && (
                <div className="mt-2 space-y-1">
                  {balance.filter(b => b.isLow).map(b => (
                    <div key={b.category} className="flex items-center gap-2 bg-yellow-500/10 border border-yellow-500/20 px-3 py-1.5 rounded-lg">
                      <span className="text-yellow-400 text-xs">⚠️ {b.category} 不足気味 ({b.pct}%)</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* ── ③ 週間傾向 ── */}
        <div className="bg-card border border-border rounded-2xl p-4">
          <div className="text-xs text-muted mb-3 font-medium uppercase tracking-wider">
            📅 直近1ヶ月のトレーニング傾向
          </div>
          {totalSessions === 0 ? (
            <div className="text-muted text-sm text-center py-2">記録がありません</div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={160}>
                <LineChart data={weekly.weeks} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2a4a" />
                  <XAxis dataKey="label" tick={{ fill: '#8892a4', fontSize: 10 }} />
                  <YAxis yAxisId="left"  tick={{ fill: '#8892a4', fontSize: 10 }} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fill: '#8892a4', fontSize: 10 }} />
                  <Tooltip content={<ChartTooltip />} />
                  <Line yAxisId="left"  type="monotone" dataKey="sessions" name="回数" stroke="#39ff14" strokeWidth={2} dot={{ r: 4, fill: '#39ff14' }} />
                  <Line yAxisId="right" type="monotone" dataKey="volume"   name="負荷" stroke="#00d4ff" strokeWidth={2} dot={{ r: 4, fill: '#00d4ff' }} />
                </LineChart>
              </ResponsiveContainer>
              <div className="mt-2 space-y-1">
                {weekly.comment && (
                  <div className="text-xs text-accent bg-accent/10 border border-accent/20 px-3 py-1.5 rounded-lg">
                    💬 {weekly.comment}
                  </div>
                )}
                {weekly.warningConsecutive && (
                  <div className="text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 px-3 py-1.5 rounded-lg">
                    💤 連続トレーニングが続いています。休養を検討してください
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* ── ④ 種目別伸び率ランキング ── */}
        <div className="bg-card border border-border rounded-2xl p-4">
          <div className="text-xs text-muted mb-3 font-medium uppercase tracking-wider">
            🏆 直近1ヶ月の伸び率ランキング
          </div>
          {progress.length === 0 ? (
            <div className="text-muted text-sm text-center py-2">
              {totalSessions < 2 ? '記録が少ないためまだ計算できません' : '直近1ヶ月で重量が増加した種目はありません'}
            </div>
          ) : (
            <div className="space-y-2">
              {progress.map((p, i) => {
                const medals = ['🥇', '🥈', '🥉']
                return (
                  <div key={p.name} className="flex items-center justify-between px-3 py-2.5 bg-surface rounded-xl border border-border">
                    <div className="flex items-center gap-2">
                      <span className="text-base">{medals[i]}</span>
                      <div>
                        <div className="text-sm font-medium text-white">{p.name}</div>
                        <div className="text-xs text-muted">{p.category}</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-accent font-bold text-sm">+{p.gain}kg</div>
                      <div className="text-xs text-muted">{p.firstMax}→{p.lastMax}kg</div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* ── ⑤ 週別カロリー消費グラフ ── */}
        <div className="bg-card border border-border rounded-2xl p-4">
          <div className="text-xs text-muted mb-3 font-medium uppercase tracking-wider">
            📊 週別カロリー消費（直近4週間）
          </div>
          {!hasWeekCalData ? (
            <div className="text-muted text-sm text-center py-2">カロリーデータがありません</div>
          ) : (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={weekCal} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2a4a" />
                <XAxis dataKey="label" tick={{ fill: '#8892a4', fontSize: 10 }} />
                <YAxis tick={{ fill: '#8892a4', fontSize: 10 }} tickFormatter={v => `${v}`} />
                <Tooltip
                  content={<ChartTooltip />}
                  formatter={(v: number) => [`${v}kcal`]}
                />
                <Legend
                  wrapperStyle={{ fontSize: 10, color: '#8892a4', paddingTop: 4 }}
                  formatter={v => v}
                />
                <Bar dataKey="strength" name="💪筋トレ" stackId="a" fill="#00d4ff" radius={[0, 0, 0, 0]} />
                <Bar dataKey="cardio"   name="🏃有酸素" stackId="a" fill="#39ff14" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* ── ⑥ 1回あたりカロリートレンド ── */}
        <div className="bg-card border border-border rounded-2xl p-4">
          <div className="text-xs text-muted mb-3 font-medium uppercase tracking-wider">
            📈 消費カロリー推移（直近1ヶ月）
          </div>
          {sessionCal.length < 2 ? (
            <div className="text-muted text-sm text-center py-2">
              {totalSessions < 2 ? '記録が少ないためグラフを表示できません' : 'カロリーデータが不足しています'}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={sessionCal} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2a4a" />
                <XAxis dataKey="date" tick={{ fill: '#8892a4', fontSize: 9 }} />
                <YAxis tick={{ fill: '#8892a4', fontSize: 10 }} />
                <Tooltip content={<ChartTooltip />} formatter={(v: number) => [`${v}kcal`, '消費カロリー']} />
                <Line type="monotone" dataKey="total" name="消費カロリー" stroke="#39ff14" strokeWidth={2} dot={{ r: 3, fill: '#39ff14' }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* ── ⑦ 種目別カロリー消費ランキング ── */}
        <div className="bg-card border border-border rounded-2xl p-4">
          <div className="text-xs text-muted mb-3 font-medium uppercase tracking-wider">
            🔥 種目別カロリー消費ランキング（直近1ヶ月）
          </div>
          {exCalRank.length === 0 ? (
            <div className="text-muted text-sm text-center py-2">カロリーデータがありません</div>
          ) : (
            <div className="space-y-2">
              {exCalRank.map((item, i) => {
                const maxCal = exCalRank[0].calories
                const pct = Math.round((item.calories / maxCal) * 100)
                const rankEmoji = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'][i] ?? `${i + 1}.`
                return (
                  <div key={item.name} className="flex items-center gap-2">
                    <span className="text-base w-6 shrink-0">{rankEmoji}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="text-sm font-medium text-white truncate">{item.name}</span>
                        <span className="text-xs text-accentGreen font-bold ml-2 shrink-0">
                          {item.calories.toLocaleString()}kcal
                        </span>
                      </div>
                      <div className="h-1.5 bg-surface rounded-full overflow-hidden">
                        <div
                          className="h-full bg-accentGreen rounded-full"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* ── ⑧ 総合アドバイス ── */}
        <div className="bg-card border border-border rounded-2xl p-4">
          <div className="text-xs text-muted mb-3 font-medium uppercase tracking-wider">
            💬 総合アドバイス
          </div>
          <div className="space-y-2">
            {advice.map((a, i) => (
              <div
                key={i}
                className={`flex gap-2 px-3 py-3 rounded-xl border text-sm leading-relaxed ${
                  a.type === 'warning'
                    ? 'bg-yellow-500/10 border-yellow-500/20 text-yellow-100'
                    : a.type === 'success'
                    ? 'bg-accentGreen/10 border-accentGreen/20 text-green-100'
                    : 'bg-accent/10 border-accent/20 text-white'
                }`}
              >
                <span className="shrink-0 text-base">{a.icon}</span>
                <span>{a.text}</span>
              </div>
            ))}
          </div>
        </div>

        {/* footer */}
        <div className="text-center text-xs text-muted pt-1">
          {totalSessions}回分のデータを分析 · APIは使用していません
        </div>
      </div>
    </div>
  )
}
