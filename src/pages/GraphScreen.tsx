import { useState, useMemo } from 'react'
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts'
import type { WorkoutData, Category } from '../types'
import { CATEGORIES, CATEGORY_ICONS, DEFAULT_EXERCISES } from '../data/exercises'

interface Props {
  data: WorkoutData
}

type RangeKey = '1m' | '3m' | 'all'
type ViewMode = 'exercise' | 'category'

const RANGE_LABELS: Record<RangeKey, string> = {
  '1m': '直近1ヶ月',
  '3m': '直近3ヶ月',
  'all': '全期間',
}

function filterByRange(date: string, range: RangeKey): boolean {
  if (range === 'all') return true
  const d = new Date(date)
  const now = new Date()
  const months = range === '1m' ? 1 : 3
  const cutoff = new Date(now)
  cutoff.setMonth(cutoff.getMonth() - months)
  return d >= cutoff
}

function fmtDate(dateStr: string) {
  const d = new Date(dateStr)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    return (
      <div className="bg-surface border border-border rounded-xl px-3 py-2 text-sm shadow-xl">
        <div className="text-muted text-xs mb-1">{label}</div>
        {payload.map((p: { name: string; value: number; color: string }, i: number) => (
          <div key={i} style={{ color: p.color }} className="font-bold">
            {p.name}: {p.value}
          </div>
        ))}
      </div>
    )
  }
  return null
}

export default function GraphScreen({ data }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('exercise')
  const [selectedCategory, setSelectedCategory] = useState<Category>('胸')
  const [selectedExercise, setSelectedExercise] = useState<string>('ベンチプレス')
  const [range, setRange] = useState<RangeKey>('3m')

  const allExercisesForCategory = useMemo(() => {
    const defaults = DEFAULT_EXERCISES[selectedCategory]
    const custom = data.customExercises
      .filter(c => c.category === selectedCategory)
      .map(c => c.name)
    return [...defaults, ...custom]
  }, [selectedCategory, data.customExercises])

  // Exercise-level chart: max weight per session
  const exerciseChartData = useMemo(() => {
    const points: { date: string; value: number; label: string }[] = []
    for (const session of data.sessions) {
      if (!filterByRange(session.date, range)) continue
      const ex = session.exercises.find(
        e => e.category === selectedCategory && e.name === selectedExercise
      )
      if (!ex || ex.sets.length === 0) continue
      const isCardio = selectedCategory === '有酸素'
      const value = isCardio
        ? Math.max(...ex.sets.map(s => s.durationMinutes ?? 0))
        : Math.max(...ex.sets.map(s => s.weight ?? 0))
      points.push({ date: session.date, value, label: fmtDate(session.date) })
    }
    return points.sort((a, b) => a.date.localeCompare(b.date))
  }, [data.sessions, selectedCategory, selectedExercise, range])

  // Category-level chart: total volume per session
  const categoryChartData = useMemo(() => {
    const points: { date: string; volume: number; label: string }[] = []
    for (const session of data.sessions) {
      if (!filterByRange(session.date, range)) continue
      const exs = session.exercises.filter(e => e.category === selectedCategory)
      if (exs.length === 0) continue
      const isCardio = selectedCategory === '有酸素'
      const volume = exs.reduce((sum, e) =>
        sum + e.sets.reduce((s2, set) => {
          if (isCardio) return s2 + (set.durationMinutes ?? 0)
          return s2 + (set.weight ?? 0) * (set.reps ?? 0)
        }, 0), 0)
      points.push({ date: session.date, volume: Math.round(volume), label: fmtDate(session.date) })
    }
    return points.sort((a, b) => a.date.localeCompare(b.date))
  }, [data.sessions, selectedCategory, range])

  // Table data
  const tableData = useMemo(() => {
    const rows: {
      date: string; name: string; sets: number; maxWeight: string; volume: string
    }[] = []
    const isCardio = selectedCategory === '有酸素'
    for (const session of [...data.sessions].sort((a, b) => b.date.localeCompare(a.date))) {
      if (!filterByRange(session.date, range)) continue
      const exs = viewMode === 'exercise'
        ? session.exercises.filter(e => e.category === selectedCategory && e.name === selectedExercise)
        : session.exercises.filter(e => e.category === selectedCategory)
      for (const ex of exs) {
        if (ex.sets.length === 0) continue
        const maxWeight = isCardio
          ? `${Math.max(...ex.sets.map(s => s.durationMinutes ?? 0))}分`
          : `${Math.max(...ex.sets.map(s => s.weight ?? 0))}kg`
        const volume = isCardio
          ? `${ex.sets.reduce((s, set) => s + (set.durationMinutes ?? 0), 0)}分`
          : `${ex.sets.reduce((s, set) => s + (set.weight ?? 0) * (set.reps ?? 0), 0)}kg`
        rows.push({ date: session.date, name: ex.name, sets: ex.sets.length, maxWeight, volume })
      }
    }
    return rows
  }, [data.sessions, selectedCategory, selectedExercise, range, viewMode])

  const hasData = viewMode === 'exercise' ? exerciseChartData.length > 0 : categoryChartData.length > 0
  const isCardio = selectedCategory === '有酸素'

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-4 pt-4 pb-6">
        {/* View mode toggle */}
        <div className="flex bg-card rounded-xl p-1 mb-4 border border-border">
          <button
            onClick={() => setViewMode('exercise')}
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${
              viewMode === 'exercise' ? 'bg-accent text-bg' : 'text-muted'
            }`}
          >
            種目別
          </button>
          <button
            onClick={() => setViewMode('category')}
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition-all ${
              viewMode === 'category' ? 'bg-accent text-bg' : 'text-muted'
            }`}
          >
            大項目別
          </button>
        </div>

        {/* Category selector */}
        <div className="grid grid-cols-4 gap-2 mb-4">
          {CATEGORIES.map(cat => (
            <button
              key={cat}
              onClick={() => {
                setSelectedCategory(cat)
                setSelectedExercise(DEFAULT_EXERCISES[cat][0])
              }}
              className={`flex flex-col items-center justify-center py-2 rounded-xl text-xs font-medium transition-all ${
                selectedCategory === cat
                  ? 'bg-accent text-bg font-bold'
                  : 'bg-card text-muted border border-border'
              }`}
            >
              <span className="text-base">{CATEGORY_ICONS[cat]}</span>
              <span>{cat}</span>
            </button>
          ))}
        </div>

        {/* Exercise selector (only in exercise mode) */}
        {viewMode === 'exercise' && (
          <select
            value={selectedExercise}
            onChange={e => setSelectedExercise(e.target.value)}
            className="w-full bg-card border border-border rounded-xl px-3 py-3 text-sm text-white mb-4 appearance-none"
          >
            {allExercisesForCategory.map(ex => (
              <option key={ex} value={ex}>{ex}</option>
            ))}
          </select>
        )}

        {/* Range filter */}
        <div className="flex gap-2 mb-4">
          {(Object.keys(RANGE_LABELS) as RangeKey[]).map(r => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`flex-1 py-2 rounded-xl text-xs font-medium border transition-all ${
                range === r
                  ? 'bg-accent/20 text-accent border-accent/40'
                  : 'bg-card text-muted border-border'
              }`}
            >
              {RANGE_LABELS[r]}
            </button>
          ))}
        </div>

        {/* Chart */}
        <div className="bg-card border border-border rounded-2xl p-4 mb-4">
          {!hasData ? (
            <div className="flex flex-col items-center justify-center h-40 text-muted">
              <div className="text-3xl mb-2">📊</div>
              <div className="text-sm">データがありません</div>
            </div>
          ) : viewMode === 'exercise' ? (
            <>
              <div className="text-sm font-medium text-white mb-1">{selectedExercise}</div>
              <div className="text-xs text-muted mb-3">
                {isCardio ? '最大時間 (分)' : '最大重量 (kg)'}
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={exerciseChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2a4a" />
                  <XAxis dataKey="label" tick={{ fill: '#8892a4', fontSize: 10 }} />
                  <YAxis tick={{ fill: '#8892a4', fontSize: 10 }} />
                  <Tooltip content={<CustomTooltip />} />
                  <Line
                    type="monotone"
                    dataKey="value"
                    name={isCardio ? '分' : 'kg'}
                    stroke="#00d4ff"
                    strokeWidth={2}
                    dot={{ fill: '#00d4ff', r: 4 }}
                    activeDot={{ r: 6 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </>
          ) : (
            <>
              <div className="text-sm font-medium text-white mb-1">{selectedCategory}</div>
              <div className="text-xs text-muted mb-3">
                {isCardio ? '合計時間 (分)' : '総ボリューム (kg)'}
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={categoryChartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2a4a" />
                  <XAxis dataKey="label" tick={{ fill: '#8892a4', fontSize: 10 }} />
                  <YAxis tick={{ fill: '#8892a4', fontSize: 10 }} />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar dataKey="volume" name={isCardio ? '分' : 'kg'} fill="#00d4ff" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </>
          )}
        </div>

        {/* Table */}
        {tableData.length > 0 && (
          <div className="bg-card border border-border rounded-2xl overflow-hidden">
            <div className="grid grid-cols-4 px-4 py-2 text-xs text-muted border-b border-border font-medium">
              <span>日付</span>
              <span>{viewMode === 'exercise' ? '種目' : '種目'}</span>
              <span className="text-center">セット</span>
              <span className="text-right">ボリューム</span>
            </div>
            {tableData.slice(0, 20).map((row, i) => (
              <div
                key={i}
                className="grid grid-cols-4 px-4 py-3 text-sm border-b border-border/50 last:border-0"
              >
                <span className="text-muted">{fmtDate(row.date)}</span>
                <span className="text-white truncate pr-2">{row.name}</span>
                <span className="text-center text-accent font-bold">{row.sets}</span>
                <span className="text-right text-white font-medium">{row.volume}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
