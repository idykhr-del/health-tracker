import { useState } from 'react'
import type { WorkoutData } from '../types'

interface Props {
  data: WorkoutData
  onDeleteCustomExercise: (category: string, name: string) => void
  onResetData: () => void
  bodyWeight: number
  onBodyWeightChange: (kg: number) => void
  age: number
  onAgeChange: (age: number) => void
  restSeconds: number
  onRestSecondsChange: (sec: number) => void
}

function downloadCSV(data: WorkoutData) {
  const rows: string[] = [
    '日付,時間,大項目,種目,セット番号,重量(kg),回数,時間(分),距離(km),評価,メモ',
  ]
  for (const session of data.sessions) {
    for (const ex of session.exercises) {
      ex.sets.forEach((set, idx) => {
        const cols = [
          session.date,
          session.startTime,
          ex.category,
          ex.name,
          String(idx + 1),
          set.weight != null ? String(set.weight) : '',
          set.reps != null ? String(set.reps) : '',
          set.durationMinutes != null ? String(set.durationMinutes) : '',
          set.distanceKm != null ? String(set.distanceKm) : '',
          session.rating != null ? String(session.rating) : '',
          session.memo ? `"${session.memo.replace(/"/g, '""')}"` : '',
        ]
        rows.push(cols.join(','))
      })
    }
  }
  const blob = new Blob(['\uFEFF' + rows.join('\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `workout_${new Date().toISOString().split('T')[0]}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

async function shareJSON(data: WorkoutData) {
  const json = JSON.stringify(data, null, 2)
  if (navigator.share) {
    try {
      await navigator.share({
        title: '筋トレデータ',
        text: json,
      })
      return true
    } catch {
      // fall through to clipboard
    }
  }
  await navigator.clipboard.writeText(json)
  return false
}

export default function SettingsScreen({
  data, onDeleteCustomExercise, onResetData,
  bodyWeight, onBodyWeightChange,
  age, onAgeChange,
  restSeconds, onRestSecondsChange,
}: Props) {
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const [shareToast, setShareToast] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState<{ category: string; name: string } | null>(null)
  const [weightInput, setWeightInput] = useState(String(bodyWeight))
  const [ageInput, setAgeInput] = useState(String(age))

  const totalSessions = data.sessions.length
  const totalSets = data.sessions.reduce(
    (sum, s) => sum + s.exercises.reduce((s2, e) => s2 + e.sets.length, 0), 0
  )

  const handleShare = async () => {
    const shared = await shareJSON(data)
    setShareToast(shared ? '共有しました！' : 'クリップボードにコピーしました！')
    setTimeout(() => setShareToast(''), 2500)
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-4 pt-4 pb-8 space-y-4">

        {/* Profile & calorie calculation settings */}
        <div className="bg-card border border-border rounded-2xl p-4">
          <div className="text-xs text-muted mb-3 font-medium uppercase tracking-wider">プロフィール・カロリー設定</div>
          <div className="space-y-4">
            {/* Body weight + Age */}
            <div className="flex gap-3">
              <div>
                <label className="text-xs text-muted block mb-1">体重 (kg)</label>
                <input
                  type="number"
                  inputMode="decimal"
                  value={weightInput}
                  onChange={e => setWeightInput(e.target.value)}
                  onBlur={() => {
                    const v = parseFloat(weightInput)
                    if (!isNaN(v) && v >= 20 && v <= 300) {
                      onBodyWeightChange(v)
                    } else {
                      setWeightInput(String(bodyWeight))
                    }
                  }}
                  min="20" max="300" step="0.5"
                  className="w-24 bg-surface border border-border rounded-xl px-3 py-2.5 text-white text-center text-lg font-bold"
                />
              </div>
              <div>
                <label className="text-xs text-muted block mb-1">年齢 (歳)</label>
                <input
                  type="number"
                  inputMode="numeric"
                  value={ageInput}
                  onChange={e => setAgeInput(e.target.value)}
                  onBlur={() => {
                    const v = parseInt(ageInput)
                    if (!isNaN(v) && v >= 10 && v <= 120) {
                      onAgeChange(v)
                    } else {
                      setAgeInput(String(age))
                    }
                  }}
                  min="10" max="120"
                  className="w-24 bg-surface border border-border rounded-xl px-3 py-2.5 text-white text-center text-lg font-bold"
                />
              </div>
            </div>
            {/* Rest time between sets */}
            <div>
              <label className="text-xs text-muted block mb-2">セット間の休憩時間（筋トレのカロリー計算に使用）</label>
              <div className="flex gap-2 flex-wrap">
                {[30, 60, 90, 120, 150, 180].map(sec => (
                  <button
                    key={sec}
                    onClick={() => onRestSecondsChange(sec)}
                    className={`px-3 py-2 rounded-xl text-sm font-medium transition-all ${
                      restSeconds === sec
                        ? 'bg-accent text-bg font-bold shadow-md shadow-accent/30'
                        : 'bg-surface border border-border text-muted'
                    }`}
                  >
                    {sec}秒
                  </button>
                ))}
              </div>
            </div>
            <div className="text-xs text-muted">
              全種目（筋トレ・有酸素）の消費カロリー計算に使用します
            </div>
          </div>
        </div>

        {/* Stats */}
        <div className="bg-card border border-border rounded-2xl p-4">
          <div className="text-xs text-muted mb-3 font-medium uppercase tracking-wider">統計</div>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-surface rounded-xl p-3 text-center">
              <div className="text-2xl font-bold text-accent">{totalSessions}</div>
              <div className="text-xs text-muted mt-1">ワークアウト数</div>
            </div>
            <div className="bg-surface rounded-xl p-3 text-center">
              <div className="text-2xl font-bold text-accent">{totalSets}</div>
              <div className="text-xs text-muted mt-1">総セット数</div>
            </div>
          </div>
        </div>

        {/* Export */}
        <div className="bg-card border border-border rounded-2xl p-4">
          <div className="text-xs text-muted mb-3 font-medium uppercase tracking-wider">データのエクスポート</div>
          <div className="space-y-2">
            <button
              onClick={() => downloadCSV(data)}
              disabled={totalSessions === 0}
              className="w-full flex items-center gap-3 bg-surface border border-border rounded-xl px-4 py-3 text-sm font-medium disabled:opacity-40 active:scale-95 transition-all"
            >
              <span className="text-xl">📥</span>
              <div className="text-left">
                <div className="text-white">CSVダウンロード</div>
                <div className="text-xs text-muted">全ワークアウトをCSVで保存</div>
              </div>
            </button>
            <button
              onClick={handleShare}
              disabled={totalSessions === 0}
              className="w-full flex items-center gap-3 bg-surface border border-border rounded-xl px-4 py-3 text-sm font-medium disabled:opacity-40 active:scale-95 transition-all"
            >
              <span className="text-xl">🔗</span>
              <div className="text-left">
                <div className="text-white">データを共有</div>
                <div className="text-xs text-muted">JSON形式で共有 / コピー</div>
              </div>
            </button>
          </div>
        </div>

        {/* Custom exercises */}
        <div className="bg-card border border-border rounded-2xl p-4">
          <div className="text-xs text-muted mb-3 font-medium uppercase tracking-wider">
            カスタム種目 ({data.customExercises.length})
          </div>
          {data.customExercises.length === 0 ? (
            <div className="text-muted text-sm text-center py-4">カスタム種目はありません</div>
          ) : (
            <div className="space-y-2">
              {data.customExercises.map((ex, i) => (
                <div key={i}>
                  <div className="flex items-center justify-between bg-surface rounded-xl px-3 py-3">
                    <div>
                      <div className="text-sm text-white font-medium">{ex.name}</div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-muted">{ex.category}</span>
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${
                          ex.exerciseType === 'cardio'
                            ? 'bg-accentGreen/15 text-accentGreen border border-accentGreen/30'
                            : 'bg-accent/15 text-accent border border-accent/20'
                        }`}>
                          {ex.exerciseType === 'cardio' ? '🏃 有酸素' : '💪 筋トレ'}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={() => setDeleteConfirm({ category: ex.category, name: ex.name })}
                      className="text-red-400 text-sm px-3 py-1 rounded-lg border border-red-500/30 bg-red-500/10"
                    >
                      削除
                    </button>
                  </div>
                  {deleteConfirm?.category === ex.category && deleteConfirm?.name === ex.name && (
                    <div className="flex gap-2 mt-1 slide-in">
                      <button
                        onClick={() => {
                          onDeleteCustomExercise(ex.category, ex.name)
                          setDeleteConfirm(null)
                        }}
                        className="flex-1 bg-red-500/20 text-red-400 border border-red-500/30 rounded-xl py-2 text-sm font-medium"
                      >
                        削除する
                      </button>
                      <button
                        onClick={() => setDeleteConfirm(null)}
                        className="flex-1 bg-card text-muted border border-border rounded-xl py-2 text-sm"
                      >
                        キャンセル
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Danger zone */}
        <div className="bg-card border border-red-500/20 rounded-2xl p-4">
          <div className="text-xs text-red-400 mb-3 font-medium uppercase tracking-wider">危険ゾーン</div>
          {!showResetConfirm ? (
            <button
              onClick={() => setShowResetConfirm(true)}
              className="w-full flex items-center gap-3 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-sm font-medium active:scale-95 transition-all"
            >
              <span className="text-xl">🗑️</span>
              <div className="text-left">
                <div className="text-red-400">データをリセット</div>
                <div className="text-xs text-muted">全データを削除します（取り消し不可）</div>
              </div>
            </button>
          ) : (
            <div className="slide-in">
              <div className="text-sm text-white mb-3 text-center">本当に全データを削除しますか？</div>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    onResetData()
                    setShowResetConfirm(false)
                  }}
                  className="flex-1 bg-red-500 text-white font-bold rounded-xl py-3 text-sm"
                >
                  削除する
                </button>
                <button
                  onClick={() => setShowResetConfirm(false)}
                  className="flex-1 bg-card text-muted border border-border rounded-xl py-3 text-sm"
                >
                  キャンセル
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="text-center text-xs text-muted pt-2">
          筋トレトラッカー v1.0 — データはすべてローカルに保存されます
        </div>
      </div>

      {/* Toast */}
      {shareToast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 bg-accent text-bg px-4 py-2 rounded-full text-sm font-bold shadow-lg slide-in">
          {shareToast}
        </div>
      )}
    </div>
  )
}
