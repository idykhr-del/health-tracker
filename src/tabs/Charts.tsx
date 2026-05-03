import { useState, useMemo } from 'react'
import {
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, ReferenceLine,
} from 'recharts'
import type { BodyData, WorkoutSession } from '../types'
import EmptyState from '../components/ui/EmptyState'

type Period = '2w' | '1m' | '3m' | 'all'
type ChartType = 'body' | 'sleep' | 'composite'

interface Props {
  data: BodyData
  sessions: WorkoutSession[]
  onNavigateToData: () => void
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

function shortDate(date: string): string {
  return `${parseInt(date.slice(5, 7))}/${parseInt(date.slice(8))}`
}

const PERIOD_DAYS: Record<Period, number> = { '2w': 14, '1m': 30, '3m': 90, 'all': 9999 }

export default function Charts({ data, sessions, onNavigateToData }: Props) {
  const [period, setPeriod] = useState<Period>('1m')
  const [chartType, setChartType] = useState<ChartType>('body')

  const { bodyRecords, sleepRecords } = data
  const hasData = bodyRecords.length > 0 || sleepRecords.length > 0

  if (!hasData) {
    return (
      <EmptyState
        icon="📈"
        title="グラフデータがありません"
        description="体組成または睡眠データをインポートするとグラフが表示されます。"
        action={{ label: 'データ管理へ', onClick: onNavigateToData }}
      />
    )
  }

  const cutoff = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10)
    return period === 'all' ? '2000-01-01' : addDays(today, -PERIOD_DAYS[period])
  }, [period])

  const workoutDates = useMemo(() => new Set(sessions.map(s => s.date)), [sessions])

  // Build unified date-keyed dataset
  const chartData = useMemo(() => {
    const dateSet = new Set<string>()
    bodyRecords.forEach(r => { if (r.date >= cutoff) dateSet.add(r.date) })
    sleepRecords.forEach(r => { if (r.date >= cutoff) dateSet.add(r.date) })

    const sorted = [...dateSet].sort()
    const bodyMap  = new Map(bodyRecords.map(r => [r.date, r]))
    const sleepMap = new Map(sleepRecords.map(r => [r.date, r]))

    return sorted.map(date => {
      const b = bodyMap.get(date)
      const s = sleepMap.get(date)
      return {
        date,
        label: shortDate(date),
        weight:        b?.weight        ?? null,
        bodyFatPct:    b?.bodyFatPct    ?? null,
        muscleMass:    b?.muscleMass    ?? null,
        sleepScore:    s?.sleepScore    ?? null,
        asleepMinutes: s?.asleepMinutes ?? null,
        deepMinutes:   s?.deepMinutes   ?? null,
        remMinutes:    s?.remMinutes    ?? null,
        hrv:           s?.hrv           ?? null,
        hasWorkout:    workoutDates.has(date) ? 1 : 0,
      }
    })
  }, [bodyRecords, sleepRecords, sessions, cutoff, workoutDates])

  const periods: { key: Period; label: string }[] = [
    { key: '2w', label: '2週' },
    { key: '1m', label: '1ヶ月' },
    { key: '3m', label: '3ヶ月' },
    { key: 'all', label: '全期間' },
  ]

  const chartTypes: { key: ChartType; label: string }[] = [
    { key: 'body',      label: '体組成' },
    { key: 'sleep',     label: '睡眠' },
    { key: 'composite', label: '複合' },
  ]

  const tooltipStyle = {
    backgroundColor: '#1a1a2e',
    border: '1px solid #2a2a4a',
    borderRadius: '8px',
    color: '#fff',
    fontSize: '11px',
  }

  const renderBodyChart = () => (
    <ComposedChart data={chartData}>
      <CartesianGrid strokeDasharray="3 3" stroke="#2a2a4a" />
      <XAxis dataKey="label" tick={{ fill: '#8892a4', fontSize: 10 }} interval="preserveStartEnd" />
      <YAxis yAxisId="weight" domain={['auto', 'auto']} tick={{ fill: '#8892a4', fontSize: 10 }} width={35} />
      <YAxis yAxisId="pct" orientation="right" domain={['auto', 'auto']} tick={{ fill: '#8892a4', fontSize: 10 }} width={30} />
      <Tooltip contentStyle={tooltipStyle} />
      <Legend wrapperStyle={{ fontSize: '11px', color: '#8892a4' }} />
      {/* Workout markers */}
      {chartData.filter(d => d.hasWorkout).map(d => (
        <ReferenceLine key={d.date} x={d.label} yAxisId="weight" stroke="#a855f7" strokeDasharray="3 3" strokeOpacity={0.5} />
      ))}
      <Line yAxisId="weight" type="monotone" dataKey="weight"     name="体重(kg)"    stroke="#00d4ff" dot={false} strokeWidth={2} connectNulls />
      <Line yAxisId="pct"    type="monotone" dataKey="bodyFatPct" name="体脂肪率(%)" stroke="#f97316" dot={false} strokeWidth={2} connectNulls />
      <Line yAxisId="pct"    type="monotone" dataKey="muscleMass" name="筋肉量(kg)"  stroke="#39ff14" dot={false} strokeWidth={2} connectNulls />
    </ComposedChart>
  )

  const renderSleepChart = () => (
    <ComposedChart data={chartData}>
      <CartesianGrid strokeDasharray="3 3" stroke="#2a2a4a" />
      <XAxis dataKey="label" tick={{ fill: '#8892a4', fontSize: 10 }} interval="preserveStartEnd" />
      <YAxis yAxisId="score" domain={[0, 100]} tick={{ fill: '#8892a4', fontSize: 10 }} width={30} />
      <YAxis yAxisId="min" orientation="right" domain={['auto', 'auto']} tick={{ fill: '#8892a4', fontSize: 10 }} width={35} />
      <Tooltip contentStyle={tooltipStyle} />
      <Legend wrapperStyle={{ fontSize: '11px', color: '#8892a4' }} />
      <Bar  yAxisId="score" dataKey="sleepScore"    name="睡眠スコア"  fill="#a855f7" opacity={0.7} />
      <Line yAxisId="min"   type="monotone" dataKey="asleepMinutes" name="睡眠時間(分)" stroke="#00d4ff" dot={false} strokeWidth={2} connectNulls />
      <Line yAxisId="score" type="monotone" dataKey="hrv"          name="HRV"        stroke="#39ff14" dot={false} strokeWidth={1.5} connectNulls />
    </ComposedChart>
  )

  const renderCompositeChart = () => (
    <ComposedChart data={chartData}>
      <CartesianGrid strokeDasharray="3 3" stroke="#2a2a4a" />
      <XAxis dataKey="label" tick={{ fill: '#8892a4', fontSize: 10 }} interval="preserveStartEnd" />
      <YAxis yAxisId="weight" domain={['auto', 'auto']} tick={{ fill: '#8892a4', fontSize: 10 }} width={35} />
      <YAxis yAxisId="score"  orientation="right" domain={[0, 100]} tick={{ fill: '#8892a4', fontSize: 10 }} width={30} />
      <Tooltip contentStyle={tooltipStyle} />
      <Legend wrapperStyle={{ fontSize: '11px', color: '#8892a4' }} />
      {chartData.filter(d => d.hasWorkout).map(d => (
        <ReferenceLine key={d.date} x={d.label} yAxisId="weight" stroke="#a855f7" strokeDasharray="3 3" strokeOpacity={0.5} />
      ))}
      <Bar  yAxisId="score"  dataKey="sleepScore" name="睡眠スコア" fill="#a855f7" opacity={0.4} />
      <Line yAxisId="weight" type="monotone" dataKey="weight"     name="体重(kg)"   stroke="#00d4ff" dot={false} strokeWidth={2} connectNulls />
      <Line yAxisId="weight" type="monotone" dataKey="muscleMass" name="筋肉量(kg)" stroke="#39ff14" dot={false} strokeWidth={2} connectNulls />
    </ComposedChart>
  )

  return (
    <div className="overflow-y-auto h-full pb-6">
      <div className="px-4 pt-4 flex flex-col gap-4">

        {/* Period filter */}
        <div className="flex gap-1 bg-surface rounded-xl p-1">
          {periods.map(p => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors
                ${period === p.key ? 'bg-accent text-bg' : 'text-muted'}`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Chart type toggle */}
        <div className="flex gap-1 bg-surface rounded-xl p-1">
          {chartTypes.map(ct => (
            <button
              key={ct.key}
              onClick={() => setChartType(ct.key)}
              className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors
                ${chartType === ct.key ? 'bg-accentPurple text-white' : 'text-muted'}`}
            >
              {ct.label}
            </button>
          ))}
        </div>

        {/* Chart */}
        <div className="bg-card rounded-xl p-3">
          {chartType !== 'composite' && (
            <p className="text-xs text-muted mb-3">
              {chartType === 'body'
                ? '紫の縦線 = トレーニング日'
                : '棒グラフ = 睡眠スコア'}
            </p>
          )}
          {chartType === 'composite' && (
            <p className="text-xs text-muted mb-3">紫棒 = 睡眠スコア　紫線 = トレーニング日</p>
          )}
          <ResponsiveContainer width="100%" height={280}>
            {chartType === 'body'      ? renderBodyChart()
            : chartType === 'sleep'    ? renderSleepChart()
            :                           renderCompositeChart()}
          </ResponsiveContainer>
        </div>

        {/* Data count */}
        <p className="text-xs text-muted text-center">
          体組成 {bodyRecords.filter(r => r.date >= cutoff).length}件 /
          睡眠 {sleepRecords.filter(r => r.date >= cutoff).length}件 /
          筋トレ {sessions.filter(s => s.date >= cutoff).length}件
        </p>

      </div>
    </div>
  )
}
