import type { BodyData, WorkoutSession, WithingsSyncStatus, HaeActivityRecord, NotionWorkout } from '../types'
import { calcWeeklyChange } from '../utils/analytics'
import SummaryCard from '../components/ui/SummaryCard'
import ProgressBar from '../components/ui/ProgressBar'
import EmptyState from '../components/ui/EmptyState'

interface Props {
  data:              BodyData
  sessions:          WorkoutSession[]
  onNavigateToData:  () => void
  withingsSyncStatus: WithingsSyncStatus
  withingsLastSync:  string | null
  onWithingsSyncNow: () => void
  // HAE
  activityRecords:   HaeActivityRecord[]
  // Notion
  notionWorkouts:    NotionWorkout[]
  stravaActivities:  StravaActivity[]
}

interface StravaActivity {
  id: string; date: string; name: string
  type: 'running' | 'walking' | 'cycling' | 'other'
  distanceKm?: number; durationMinutes?: number
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

/** 分 → "X時間Y分" / "Y分" */
function fmt(min: number): string {
  const h = Math.floor(min / 60), m = min % 60
  return h > 0 ? `${h}時間${m > 0 ? m + '分' : ''}` : `${m}分`
}

/** 睡眠スコア（100点満点）
 *  = 深睡眠比率×40 + REM比率×30 + 総睡眠時間スコア×30
 *  総睡眠時間スコア = min(totalMinutes/480, 1)×100
 */
function calcSleepScore(totalMin?: number, deepMin?: number, remMin?: number): number | null {
  if (!totalMin || totalMin === 0) return null
  const deepRatio    = (deepMin ?? 0) / totalMin
  const remRatio     = (remMin  ?? 0) / totalMin
  const durationPart = Math.min(totalMin / 480, 1)
  return Math.round(deepRatio * 40 + remRatio * 30 + durationPart * 30)
}

/** 推定値バッジ */
function EstBadge() {
  return (
    <span className="text-[9px] text-amber-600 border border-amber-400/60 rounded px-1 ml-0.5 leading-none">推定</span>
  )
}

export default function Dashboard({
  data, sessions, onNavigateToData,
  withingsSyncStatus, withingsLastSync, onWithingsSyncNow,
  activityRecords, notionWorkouts, stravaActivities,
}: Props) {
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

  const weekChange  = calcWeeklyChange(bodyRecords)
  const today       = new Date().toISOString().slice(0, 10)
  const yesterday   = addDays(today, -1)
  const sevenDaysAgo = addDays(today, -7)

  // 最新体組成
  const latestBody = bodyRecords.length
    ? [...bodyRecords].sort((a, b) => b.date.localeCompare(a.date))[0]
    : null

  // 昨夜の睡眠
  const lastNightSleep = sleepRecords.find(r => r.date === yesterday) ?? sleepRecords.find(r => r.date === today)

  // 今日の活動
  const todayActivity = activityRecords.find(r => r.date === today)
    ?? activityRecords.find(r => r.date === yesterday)

  // 今週のトレーニング
  const thisWeekStrength = [
    ...sessions.filter(s => s.date >= sevenDaysAgo),
    ...notionWorkouts.filter(w => w.date >= sevenDaysAgo && w.type === 'strength'),
  ].length

  // 今週のランニング距離 (km)
  const thisWeekRunKm = [
    ...stravaActivities.filter(a => a.date >= sevenDaysAgo && (a.type === 'running' || a.type === 'walking')),
    ...notionWorkouts.filter(w => w.date >= sevenDaysAgo && (w.type === 'running' || w.type === 'walking')),
  ].reduce((sum, a) => sum + (a.distanceKm ?? 0), 0)

  // 直近7日 daily summary
  const last7 = Array.from({ length: 7 }, (_, i) => {
    const date   = addDays(today, -(6 - i))
    const body   = bodyRecords.find(r => r.date === date)
    const sleep  = sleepRecords.find(r => r.date === date)
    const act    = activityRecords.find(r => r.date === date)
    const worked = sessions.some(s => s.date === date)
      || notionWorkouts.some(w => w.date === date && w.type === 'strength')
    return { date, body, sleep, act, worked }
  })

  const dayLabel = (date: string) => {
    const d   = new Date(date + 'T00:00:00')
    const dow = ['日','月','火','水','木','金','土'][d.getDay()]
    return `${parseInt(date.slice(5, 7))}/${parseInt(date.slice(8))}(${dow})`
  }

  // 睡眠スコア（asleepMinutes は health-data.ts で totalMinutes からマップ済み）
  const sleepScore = lastNightSleep
    ? calcSleepScore(lastNightSleep.asleepMinutes, lastNightSleep.deepMinutes, lastNightSleep.remMinutes)
    : null

  return (
    <div className="overflow-y-auto h-full pb-6">
      <div className="px-4 pt-4 flex flex-col gap-5">

        {/* Withings sync status bar */}
        {withingsSyncStatus !== 'idle' && (
          <div className={`flex items-center justify-between rounded-xl px-4 py-2 text-xs
            ${withingsSyncStatus === 'syncing'  ? 'bg-accent/10 text-accent' :
              withingsSyncStatus === 'success'  ? 'bg-accentGreen/10 text-accentGreen' :
                                                  'bg-red-100 text-red-600'}`}>
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

        {/* ── 体組成（最新値）──────────────────────────────────────────── */}
        <section>
          <h2 className="text-xs text-muted uppercase tracking-wider mb-2">体組成（最新値）</h2>

          {/* Row 1: 体重 / 体脂肪率 / 除脂肪体重 */}
          <div className="grid grid-cols-3 gap-2 mb-2">
            <SummaryCard label="体重"      value={weekChange.latestWeight}  unit="kg" change={weekChange.weightChange}  changeUnit="kg" />
            <SummaryCard label="体脂肪率"  value={weekChange.latestBodyFat} unit="%"  change={weekChange.bodyFatChange} changeUnit="%" />
            <SummaryCard label="除脂肪体重" value={latestBody ? (latestBody.fatFreeMass ?? latestBody.leanBodyMass ?? '—') : '—'} unit="kg" />
          </div>

          {/* Row 2: 推定筋肉量 / BMI（データがある場合のみ）*/}
          {latestBody && (latestBody.estimatedMuscleMass != null || latestBody.bmi != null) && (
            <div className="grid grid-cols-3 gap-2">
              {latestBody.estimatedMuscleMass != null ? (
                <div className="bg-card rounded-xl p-3 flex flex-col gap-0.5 shadow-card">
                  <span className="text-[10px] text-muted">推定筋肉量 <EstBadge /></span>
                  <span className="text-lg font-bold text-accent">
                    {latestBody.estimatedMuscleMass}<span className="text-xs font-normal text-muted ml-0.5">kg</span>
                  </span>
                </div>
              ) : <div />}
              {latestBody.bmi != null
                ? <SummaryCard label="BMI" value={latestBody.bmi} unit="" />
                : <div />}
              <div />
            </div>
          )}
        </section>

        {/* ── 昨夜の睡眠 ───────────────────────────────────────────────── */}
        {lastNightSleep && (
          <section>
            <h2 className="text-xs text-muted uppercase tracking-wider mb-2">
              昨夜の睡眠 <span className="text-muted normal-case">({lastNightSleep.date})</span>
            </h2>
            <div className="grid grid-cols-3 gap-2 mb-2">
              <SummaryCard
                label="睡眠時間"
                value={lastNightSleep.asleepMinutes ? fmt(lastNightSleep.asleepMinutes) : '—'}
              />
              <SummaryCard
                label="深睡眠"
                value={lastNightSleep.deepMinutes ? fmt(lastNightSleep.deepMinutes) : '—'}
              />
              <SummaryCard
                label="REM"
                value={lastNightSleep.remMinutes ? fmt(lastNightSleep.remMinutes) : '—'}
              />
            </div>
            {sleepScore !== null && (
              <div className="bg-card rounded-xl px-4 py-3 flex items-center justify-between shadow-card">
                <span className="text-sm text-muted">睡眠スコア</span>
                <span className="text-2xl font-bold text-accentPurple">
                  {sleepScore}<span className="text-xs font-normal text-muted ml-0.5">点</span>
                </span>
              </div>
            )}
          </section>
        )}

        {/* ── 今日の活動 ───────────────────────────────────────────────── */}
        {todayActivity && (todayActivity.steps != null || todayActivity.restingHeartRate != null) && (
          <section>
            <h2 className="text-xs text-muted uppercase tracking-wider mb-2">
              今日の活動 <span className="text-muted normal-case">({todayActivity.date})</span>
            </h2>
            <div className="grid grid-cols-3 gap-2">
              <SummaryCard label="歩数"         value={todayActivity.steps?.toLocaleString() ?? '—'} unit="歩" />
              <SummaryCard label="安静時心拍数" value={todayActivity.restingHeartRate ?? '—'} unit="bpm" />
              <div />
            </div>
          </section>
        )}

        {/* ── 今週のトレーニング ────────────────────────────────────────── */}
        <section>
          <h2 className="text-xs text-muted uppercase tracking-wider mb-2">今週のトレーニング</h2>
          <div className="grid grid-cols-3 gap-2">
            <SummaryCard label="筋トレ"     value={thisWeekStrength} unit="回" highlight={thisWeekStrength > 0} />
            <SummaryCard label="ランニング" value={thisWeekRunKm > 0 ? thisWeekRunKm.toFixed(1) : '—'} unit="km" />
            <div />
          </div>
        </section>

        {/* ── 目標進捗 ─────────────────────────────────────────────────── */}
        {(goals.targetWeight || goals.targetBodyFatPct || goals.targetMuscleMass) && (
          <section>
            <h2 className="text-xs text-muted uppercase tracking-wider mb-3">目標進捗</h2>
            <div className="bg-card rounded-xl p-4 flex flex-col gap-3 shadow-card">
              <ProgressBar label="目標体重"    current={weekChange.latestWeight}  target={goals.targetWeight    ?? null} unit="kg" invert />
              <ProgressBar label="目標体脂肪率" current={weekChange.latestBodyFat} target={goals.targetBodyFatPct ?? null} unit="%" invert />
              <ProgressBar label="目標筋肉量"  current={weekChange.latestMuscle}  target={goals.targetMuscleMass ?? null} unit="kg" />
            </div>
          </section>
        )}

        {/* ── 直近7日間テーブル ─────────────────────────────────────────── */}
        <section>
          <h2 className="text-xs text-muted uppercase tracking-wider mb-2">直近7日間</h2>
          <div className="bg-card rounded-xl overflow-x-auto shadow-card">
            <table className="w-full text-xs min-w-[360px]">
              <thead>
                <tr className="border-b border-border text-muted">
                  <th className="text-left   py-2 px-3 font-medium">日付</th>
                  <th className="text-right  py-2 px-2 font-medium">体重</th>
                  <th className="text-right  py-2 px-2 font-medium">除脂肪</th>
                  <th className="text-right  py-2 px-2 font-medium">睡眠</th>
                  <th className="text-right  py-2 px-2 font-medium">REM</th>
                  <th className="text-right  py-2 px-2 font-medium">歩数</th>
                  <th className="text-center py-2 px-2 font-medium">筋トレ</th>
                </tr>
              </thead>
              <tbody>
                {last7.map(({ date, body, sleep, act, worked }) => (
                  <tr key={date} className="border-b border-border last:border-0">
                    <td className="py-2 px-3 text-muted whitespace-nowrap">{dayLabel(date)}</td>
                    <td className="py-2 px-2 text-right text-foreground">
                      {body?.weight != null ? `${body.weight}` : '—'}
                    </td>
                    <td className="py-2 px-2 text-right text-muted">
                      {body?.leanBodyMass ?? body?.fatFreeMass
                        ? <span className="text-accent">{(body?.leanBodyMass ?? body?.fatFreeMass)}</span>
                        : '—'}
                    </td>
                    <td className="py-2 px-2 text-right">
                      {sleep?.asleepMinutes
                        ? <span className="text-accentPurple">{fmt(sleep.asleepMinutes)}</span>
                        : <span className="text-muted">—</span>}
                    </td>
                    <td className="py-2 px-2 text-right text-muted">
                      {sleep?.remMinutes ? fmt(sleep.remMinutes) : '—'}
                    </td>
                    <td className="py-2 px-2 text-right text-muted">
                      {act?.steps != null ? act.steps.toLocaleString() : '—'}
                    </td>
                    <td className="py-2 px-2 text-center">
                      {worked
                        ? <span className="text-accentGreen">▲</span>
                        : <span className="text-muted">—</span>}
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
