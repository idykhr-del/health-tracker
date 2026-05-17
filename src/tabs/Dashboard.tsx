import type { BodyData, WorkoutSession, WithingsSyncStatus } from '../types'
import { calcWeeklyChange } from '../utils/analytics'
import SummaryCard from '../components/ui/SummaryCard'
import ProgressBar from '../components/ui/ProgressBar'
import EmptyState from '../components/ui/EmptyState'

interface Props {
  data: BodyData
  sessions: WorkoutSession[]
  onNavigateToData: () => void
  withingsSyncStatus: WithingsSyncStatus
  withingsLastSync: string | null
  onWithingsSyncNow: () => void
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

function formatMinutes(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  return h > 0 ? `${h}h${m > 0 ? m + 'm' : ''}` : `${m}m`
}

export default function Dashboard({ data, sessions, onNavigateToData, withingsSyncStatus, withingsLastSync, onWithingsSyncNow }: Props) {
  const { bodyRecords, sleepRecords, goals } = data
  const hasAnyData = bodyRecords.length > 0 || sleepRecords.length > 0 || sessions.length > 0

  if (!hasAnyData) {
    return (
      <EmptyState
        icon="📊"
        title="データがまだありません"
        description="Withings・AutoSleep・workout-trackerのデータをインポートするとダッシュボードが表示されます。"
        action={{ label: 'データ管理へ', onClick: onNavigateToData }}
      />
    )
  }

  const weekChange = calcWeeklyChange(bodyRecords)
  const today = new Date().toISOString().slice(0, 10)
  const sevenDaysAgo = addDays(today, -7)

  // Last 7 days daily summary
  const last7 = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(today, -(6 - i))
    const body  = bodyRecords.find(r => r.date === date)
    const sleep = sleepRecords.find(r => r.date === date)
    const worked = sessions.some(s => s.date === date)
    return { date, body, sleep, worked }
  })

  // This week workout count
  const thisWeekWorkouts = sessions.filter(s => s.date >= sevenDaysAgo).length

  // Avg sleep score and duration (last 7 days)
  const recentSleep = sleepRecords.filter(r => r.date >= sevenDaysAgo)
  const avgSleepScore = recentSleep.length
    ? Math.round(recentSleep.reduce((s, r) => s + (r.sleepScore ?? 0), 0) / recentSleep.filter(r => r.sleepScore).length || 0)
    : null
  const avgSleepMin = recentSleep.length
    ? Math.round(recentSleep.reduce((s, r) => s + (r.asleepMinutes ?? 0), 0) / recentSleep.filter(r => r.asleepMinutes).length || 0)
    : null

  const dayLabel = (date: string) => {
    const d = new Date(date + 'T00:00:00')
    const dow = ['日','月','火','水','木','金','土'][d.getDay()]
    return `${parseInt(date.slice(5, 7))}/${parseInt(date.slice(8))}(${dow})`
  }

  return (
    <div className="overflow-y-auto h-full pb-6">
      <div className="px-4 pt-4 flex flex-col gap-5">

        {/* Withings sync status bar */}
        {withingsSyncStatus !== 'idle' && (
          <div className={`flex items-center justify-between rounded-xl px-4 py-2 text-xs
            ${withingsSyncStatus === 'syncing'  ? 'bg-accent/10 text-accent' :
              withingsSyncStatus === 'success'  ? 'bg-accentGreen/10 text-accentGreen' :
                                                  'bg-red-400/10 text-red-400'}`}>
            <span>
              {withingsSyncStatus === 'syncing' ? '⟳ Withings 同期中...' :
               withingsSyncStatus === 'success' ? `✓ Withings 最終同期: ${withingsLastSync ?? ''}` :
                                                  '✗ Withings 同期エラー'}
            </span>
            {withingsSyncStatus === 'error' && (
              <button onClick={onWithingsSyncNow} className="underline ml-2">再試行</button>
            )}
          </div>
        )}

        {/* Body composition cards */}
        <section>
          <h2 className="text-xs text-muted uppercase tracking-wider mb-2">体組成（最新値）</h2>
          <div className="grid grid-cols-3 gap-2">
            <SummaryCard
              label="体重"
              value={weekChange.latestWeight}
              unit="kg"
              change={weekChange.weightChange}
              changeUnit="kg"
            />
            <SummaryCard
              label="体脂肪率"
              value={weekChange.latestBodyFat}
              unit="%"
              change={weekChange.bodyFatChange}
              changeUnit="%"
            />
            <SummaryCard
              label="筋肉量"
              value={weekChange.latestMuscle}
              unit="kg"
              change={weekChange.muscleChange}
              changeUnit="kg"
            />
          </div>
        </section>

        {/* Sleep & workout summary */}
        <section>
          <h2 className="text-xs text-muted uppercase tracking-wider mb-2">今週のサマリー</h2>
          <div className="grid grid-cols-3 gap-2">
            <SummaryCard label="睡眠スコア" value={avgSleepScore ?? '—'} unit="" />
            <SummaryCard
              label="平均睡眠"
              value={avgSleepMin ? formatMinutes(avgSleepMin) : '—'}
            />
            <SummaryCard label="トレーニング" value={thisWeekWorkouts} unit="回" highlight={thisWeekWorkouts > 0} />
          </div>
        </section>

        {/* Goal progress */}
        {(goals.targetWeight || goals.targetBodyFatPct || goals.targetMuscleMass) && (
          <section>
            <h2 className="text-xs text-muted uppercase tracking-wider mb-3">目標進捗</h2>
            <div className="bg-card rounded-xl p-4 flex flex-col gap-3">
              <ProgressBar
                label="目標体重"
                current={weekChange.latestWeight}
                target={goals.targetWeight ?? null}
                unit="kg"
                invert
              />
              <ProgressBar
                label="目標体脂肪率"
                current={weekChange.latestBodyFat}
                target={goals.targetBodyFatPct ?? null}
                unit="%"
                invert
              />
              <ProgressBar
                label="目標筋肉量"
                current={weekChange.latestMuscle}
                target={goals.targetMuscleMass ?? null}
                unit="kg"
              />
            </div>
          </section>
        )}

        {/* 7-day daily summary table */}
        <section>
          <h2 className="text-xs text-muted uppercase tracking-wider mb-2">直近7日間</h2>
          <div className="bg-card rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-muted">
                  <th className="text-left py-2 px-3 font-medium">日付</th>
                  <th className="text-right py-2 px-2 font-medium">体重</th>
                  <th className="text-right py-2 px-2 font-medium">睡眠</th>
                  <th className="text-center py-2 px-2 font-medium">筋トレ</th>
                </tr>
              </thead>
              <tbody>
                {last7.map(({ date, body, sleep, worked }) => (
                  <tr key={date} className="border-b border-border last:border-0">
                    <td className="py-2 px-3 text-muted">{dayLabel(date)}</td>
                    <td className="py-2 px-2 text-right text-white">
                      {body ? `${body.weight}kg` : '—'}
                    </td>
                    <td className="py-2 px-2 text-right">
                      {sleep?.sleepScore
                        ? <span className={`font-medium ${sleep.sleepScore >= 80 ? 'text-accentGreen' : sleep.sleepScore >= 60 ? 'text-accent' : 'text-red-400'}`}>
                            {sleep.sleepScore}
                          </span>
                        : <span className="text-muted">—</span>}
                    </td>
                    <td className="py-2 px-2 text-center">
                      {worked
                        ? <span className="text-accentGreen text-base">▲</span>
                        : <span className="text-muted text-xs">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

      </div>
    </div>
  )
}
