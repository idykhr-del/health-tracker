import { useMemo, useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, LineChart, Line, Legend,
} from 'recharts'
import type { BodyData, WorkoutSession } from '../types'
import {
  calcWeeklyChange,
  calcPostWorkoutWeightChange,
  calcSleepVsPerformance,
  calcCategoryVsMuscle,
  calcSleepTrend,
  calcExerciseEffectiveness,
} from '../utils/analytics'
import { buildClaudeExportJSON, buildClaudePrompt } from '../utils/export'
import EmptyState from '../components/ui/EmptyState'

interface Props {
  data: BodyData
  sessions: WorkoutSession[]
  onNavigateToData: () => void
}

const tooltipStyle = {
  backgroundColor: '#1a1a2e',
  border: '1px solid #2a2a4a',
  borderRadius: '8px',
  color: '#fff',
  fontSize: '11px',
}

export default function Analysis({ data, sessions, onNavigateToData }: Props) {
  const [copied, setCopied] = useState(false)

  const { bodyRecords, sleepRecords } = data
  const hasData = bodyRecords.length > 0 || sleepRecords.length > 0 || sessions.length > 0

  if (!hasData) {
    return (
      <EmptyState
        icon="💡"
        title="分析データがありません"
        description="データをインポートすると統計分析が表示されます。"
        action={{ label: 'データ管理へ', onClick: onNavigateToData }}
      />
    )
  }

  const weekChange          = useMemo(() => calcWeeklyChange(bodyRecords), [bodyRecords])
  const postWorkoutChange   = useMemo(() => calcPostWorkoutWeightChange(bodyRecords, sessions), [bodyRecords, sessions])
  const sleepPerf           = useMemo(() => calcSleepVsPerformance(sleepRecords, sessions), [sleepRecords, sessions])
  const categoryMuscle      = useMemo(() => calcCategoryVsMuscle(bodyRecords, sessions), [bodyRecords, sessions])
  const sleepTrend          = useMemo(() => calcSleepTrend(sleepRecords), [sleepRecords])
  const exerciseRank        = useMemo(() => calcExerciseEffectiveness(bodyRecords, sessions), [bodyRecords, sessions])

  const sleepTrendData = sleepTrend.slice(-30).map(d => ({
    label: `${parseInt(d.date.slice(5,7))}/${parseInt(d.date.slice(8))}`,
    asleepMA: d.asleepMA,
    hrvMA:    d.hrvMA,
  }))

  const handleCopyToClaudeAI = async () => {
    const json   = buildClaudeExportJSON(bodyRecords, sleepRecords, sessions)
    const prompt = buildClaudePrompt(json)
    try {
      await navigator.clipboard.writeText(prompt)
      setCopied(true)
      setTimeout(() => setCopied(false), 3000)
    } catch {
      alert('クリップボードへのコピーに失敗しました。手動でコピーしてください。')
    }
  }

  return (
    <div className="overflow-y-auto h-full pb-6">
      <div className="px-4 pt-4 flex flex-col gap-5">

        {/* Claude.ai export section */}
        <section className="bg-gradient-to-br from-accent/10 to-accentPurple/10 border border-accent/20 rounded-xl p-4">
          <h2 className="text-sm font-semibold text-foreground mb-1">Claude.ai で詳細分析</h2>
          <p className="text-xs text-muted mb-3">
            90日分の全データ＋分析プロンプトをクリップボードにコピーして、
            Claude.aiに貼り付けるだけで高度な分析が受けられます。
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleCopyToClaudeAI}
              className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-colors
                ${copied ? 'bg-accentGreen text-bg' : 'bg-accent text-bg'}`}
            >
              {copied ? '✓ コピー完了！' : 'データ＋プロンプトをコピー'}
            </button>
            <a
              href="https://claude.ai"
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2.5 rounded-xl bg-surface border border-border text-foreground text-sm font-semibold flex items-center"
            >
              Claude.ai →
            </a>
          </div>
        </section>

        {/* Weekly change summary */}
        <section>
          <h2 className="text-xs text-muted uppercase tracking-wider mb-2">週次変化サマリー</h2>
          <div className="bg-card rounded-xl p-4 grid grid-cols-3 gap-3 text-center">
            {[
              { label: '体重変化', val: weekChange.weightChange, unit: 'kg' },
              { label: '体脂肪変化', val: weekChange.bodyFatChange, unit: '%' },
              { label: '筋肉量変化', val: weekChange.muscleChange, unit: 'kg' },
            ].map(({ label, val, unit }) => (
              <div key={label}>
                <p className="text-xs text-muted">{label}</p>
                <p className={`text-lg font-bold mt-1 ${
                  val == null ? 'text-muted' :
                  val > 0 && label !== '筋肉量変化' ? 'text-red-400' :
                  val < 0 && label !== '筋肉量変化' ? 'text-accentGreen' :
                  val > 0 ? 'text-accentGreen' : val < 0 ? 'text-red-400' : 'text-muted'
                }`}>
                  {val != null ? `${val > 0 ? '+' : ''}${val}${unit}` : '—'}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Post-workout weight change */}
        {postWorkoutChange != null && (
          <section>
            <h2 className="text-xs text-muted uppercase tracking-wider mb-2">トレーニング翌日の体重変化平均</h2>
            <div className="bg-card rounded-xl p-4 flex items-center gap-3">
              <span className="text-3xl font-bold text-accent">
                {postWorkoutChange > 0 ? '+' : ''}{postWorkoutChange}kg
              </span>
              <p className="text-xs text-muted">
                {Math.abs(postWorkoutChange) < 0.2
                  ? 'トレーニング翌日の体重変化はほぼゼロです。'
                  : postWorkoutChange > 0
                  ? 'トレーニング翌日は体重が増加する傾向があります（筋肉への水分・グリコーゲン充填）。'
                  : 'トレーニング翌日は体重が減少する傾向があります。'}
              </p>
            </div>
          </section>
        )}

        {/* Sleep score vs training performance */}
        {sleepPerf.length > 0 && (
          <section>
            <h2 className="text-xs text-muted uppercase tracking-wider mb-2">睡眠スコア別トレーニング評価</h2>
            <div className="bg-card rounded-xl p-3">
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={sleepPerf} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2a4a" />
                  <XAxis type="number" domain={[0, 10]} tick={{ fill: '#8892a4', fontSize: 10 }} />
                  <YAxis type="category" dataKey="sleepBand" tick={{ fill: '#8892a4', fontSize: 10 }} width={45} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [`${v}点`, '平均評価']} />
                  <Bar dataKey="avgRating" name="平均評価" fill="#00d4ff" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
              <p className="text-xs text-muted mt-1 text-center">睡眠スコア帯別のトレーニング評価（10点満点）</p>
            </div>
          </section>
        )}

        {/* Category vs muscle change */}
        {categoryMuscle.length > 0 && (
          <section>
            <h2 className="text-xs text-muted uppercase tracking-wider mb-2">部位別トレーニング頻度</h2>
            <div className="bg-card rounded-xl p-3">
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={categoryMuscle.slice(0, 8)} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2a4a" />
                  <XAxis type="number" tick={{ fill: '#8892a4', fontSize: 10 }} />
                  <YAxis type="category" dataKey="category" tick={{ fill: '#8892a4', fontSize: 10 }} width={35} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="sessions" name="セッション数" fill="#a855f7" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>
        )}

        {/* Sleep trend moving average */}
        {sleepTrendData.length >= 7 && (
          <section>
            <h2 className="text-xs text-muted uppercase tracking-wider mb-2">睡眠時間・HRV（7日移動平均）</h2>
            <div className="bg-card rounded-xl p-3">
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={sleepTrendData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2a4a" />
                  <XAxis dataKey="label" tick={{ fill: '#8892a4', fontSize: 10 }} interval="preserveStartEnd" />
                  <YAxis yAxisId="min" tick={{ fill: '#8892a4', fontSize: 10 }} width={35} />
                  <YAxis yAxisId="hrv" orientation="right" tick={{ fill: '#8892a4', fontSize: 10 }} width={30} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: '11px', color: '#8892a4' }} />
                  <Line yAxisId="min" type="monotone" dataKey="asleepMA" name="睡眠時間7日MA(分)" stroke="#00d4ff" dot={false} strokeWidth={2} />
                  <Line yAxisId="hrv" type="monotone" dataKey="hrvMA"    name="HRV 7日MA"       stroke="#39ff14" dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>
        )}

        {/* Exercise effectiveness ranking */}
        {exerciseRank.length > 0 && (
          <section>
            <h2 className="text-xs text-muted uppercase tracking-wider mb-2">
              直近14日間 種目別効果ランキング
            </h2>
            <div className="bg-card rounded-xl overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-muted">
                    <th className="text-left py-2 px-3 font-medium">順位</th>
                    <th className="text-left py-2 px-2 font-medium">種目</th>
                    <th className="text-left py-2 px-2 font-medium">部位</th>
                    <th className="text-right py-2 px-3 font-medium">筋肉量変化</th>
                  </tr>
                </thead>
                <tbody>
                  {exerciseRank.map((ex, i) => (
                    <tr key={ex.name} className="border-b border-border last:border-0">
                      <td className="py-2 px-3 text-muted">{i + 1}</td>
                      <td className="py-2 px-2 text-foreground font-medium">{ex.name}</td>
                      <td className="py-2 px-2 text-muted">{ex.category}</td>
                      <td className={`py-2 px-3 text-right font-medium ${
                        ex.muscleChange > 0 ? 'text-accentGreen' :
                        ex.muscleChange < 0 ? 'text-red-400' : 'text-muted'
                      }`}>
                        {ex.muscleChange > 0 ? '+' : ''}{ex.muscleChange}kg
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-muted p-3 border-t border-border">
                ※実施後2日間の筋肉量変化で評価（データが揃っている種目のみ）
              </p>
            </div>
          </section>
        )}

      </div>
    </div>
  )
}
