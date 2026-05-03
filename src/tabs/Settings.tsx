import { useState } from 'react'
import type { Goals, AppSettings } from '../types'
import { exportBodyCSV, exportSleepCSV, downloadFile } from '../utils/export'
import type { BodyRecord, SleepRecord } from '../types'

interface Props {
  goals: Goals
  settings: AppSettings
  bodyRecords: BodyRecord[]
  sleepRecords: SleepRecord[]
  onUpdateGoals: (goals: Goals) => void
  onResetBody: () => void
  onResetSleep: () => void
  onResetAll: () => void
  onClearHistory: () => void
  showToast: (msg: string, type?: 'success' | 'error' | 'info') => void
}

export default function Settings({
  goals, settings, bodyRecords, sleepRecords,
  onUpdateGoals, onResetBody, onResetSleep, onResetAll, onClearHistory, showToast,
}: Props) {
  const [editGoals, setEditGoals] = useState<Goals>({ ...goals })
  const [confirmReset, setConfirmReset] = useState<'body' | 'sleep' | 'all' | null>(null)

  const handleGoalSave = () => {
    onUpdateGoals(editGoals)
    showToast('目標を保存しました')
  }

  const handleExportBodyCSV = () => {
    if (!bodyRecords.length) { showToast('体組成データがありません', 'error'); return }
    downloadFile(exportBodyCSV(bodyRecords), `body_data_${new Date().toISOString().slice(0,10)}.csv`, 'text/csv')
    showToast('体組成CSVをダウンロードしました')
  }

  const handleExportSleepCSV = () => {
    if (!sleepRecords.length) { showToast('睡眠データがありません', 'error'); return }
    downloadFile(exportSleepCSV(sleepRecords), `sleep_data_${new Date().toISOString().slice(0,10)}.csv`, 'text/csv')
    showToast('睡眠CSVをダウンロードしました')
  }

  const handleExportAllJSON = () => {
    const all = { bodyRecords, sleepRecords, goals, settings }
    downloadFile(JSON.stringify(all, null, 2), `health_data_${new Date().toISOString().slice(0,10)}.json`, 'application/json')
    showToast('全データJSONをダウンロードしました')
  }

  const executeReset = () => {
    if (confirmReset === 'body')  onResetBody()
    if (confirmReset === 'sleep') onResetSleep()
    if (confirmReset === 'all')   onResetAll()
    showToast('データをリセットしました')
    setConfirmReset(null)
  }

  const lastBodyDate = bodyRecords.length
    ? [...bodyRecords].sort((a, b) => b.date.localeCompare(a.date))[0].date : null
  const lastSleepDate = sleepRecords.length
    ? [...sleepRecords].sort((a, b) => b.date.localeCompare(a.date))[0].date : null

  return (
    <div className="overflow-y-auto h-full pb-6">
      <div className="px-4 pt-4 flex flex-col gap-5">

        {/* Goal settings */}
        <section>
          <h2 className="text-sm font-semibold text-white mb-3">目標値設定</h2>
          <div className="bg-card rounded-xl p-4 flex flex-col gap-4">
            {[
              { key: 'targetWeight' as const,     label: '目標体重',    unit: 'kg', min: 30, max: 200, step: 0.1 },
              { key: 'targetBodyFatPct' as const,  label: '目標体脂肪率', unit: '%',  min: 3,  max: 50,  step: 0.1 },
              { key: 'targetMuscleMass' as const,  label: '目標筋肉量',  unit: 'kg', min: 20, max: 100, step: 0.1 },
            ].map(({ key, label, unit, min, max, step }) => (
              <div key={key} className="flex flex-col gap-1">
                <label className="text-xs text-muted">{label}</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={min}
                    max={max}
                    step={step}
                    value={editGoals[key] ?? ''}
                    onChange={e => setEditGoals(prev => ({
                      ...prev,
                      [key]: e.target.value ? parseFloat(e.target.value) : undefined,
                    }))}
                    placeholder={`例: ${key === 'targetWeight' ? '67.0' : key === 'targetBodyFatPct' ? '12.0' : '57.0'}`}
                    className="flex-1 bg-surface border border-border rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-accent"
                  />
                  <span className="text-sm text-muted w-6">{unit}</span>
                </div>
              </div>
            ))}
            <button
              onClick={handleGoalSave}
              className="py-2.5 bg-accent text-bg rounded-xl font-semibold text-sm"
            >
              目標を保存
            </button>
          </div>
        </section>

        {/* Data sync status */}
        <section>
          <h2 className="text-xs text-muted uppercase tracking-wider mb-2">連携状態サマリー</h2>
          <div className="bg-card rounded-xl p-4 flex flex-col gap-3">
            {[
              { label: 'Withings CSVインポート', date: lastBodyDate, count: bodyRecords.length, color: 'accent' },
              { label: 'AutoSleepインポート',    date: lastSleepDate, count: sleepRecords.length, color: 'accentPurple' },
            ].map(({ label, date, count, color }) => (
              <div key={label} className="flex justify-between items-center">
                <div>
                  <p className="text-xs text-white">{label}</p>
                  <p className="text-xs text-muted">{date ? `最終: ${date}` : 'インポートなし'}</p>
                </div>
                <span className={`text-xs font-semibold text-${color}`}>{count}件</span>
              </div>
            ))}
          </div>
        </section>

        {/* Export */}
        <section>
          <h2 className="text-xs text-muted uppercase tracking-wider mb-2">データエクスポート</h2>
          <div className="bg-card rounded-xl p-4 flex flex-col gap-2">
            <button onClick={handleExportBodyCSV}  className="py-2.5 bg-surface border border-border rounded-xl text-sm text-white hover:border-accent transition-colors">体組成 CSV エクスポート</button>
            <button onClick={handleExportSleepCSV} className="py-2.5 bg-surface border border-border rounded-xl text-sm text-white hover:border-accentPurple transition-colors">睡眠 CSV エクスポート</button>
            <button onClick={handleExportAllJSON}  className="py-2.5 bg-surface border border-border rounded-xl text-sm text-white hover:border-accentGreen transition-colors">全データ JSON エクスポート</button>
          </div>
        </section>

        {/* Import history reset */}
        <section>
          <h2 className="text-xs text-muted uppercase tracking-wider mb-2">インポート履歴</h2>
          <div className="bg-card rounded-xl p-4">
            <p className="text-xs text-muted mb-3">{settings.importHistory.length}件の履歴があります</p>
            <button
              onClick={() => { onClearHistory(); showToast('インポート履歴を削除しました') }}
              className="text-xs text-red-400 underline"
            >
              履歴を削除
            </button>
          </div>
        </section>

        {/* Data reset */}
        <section>
          <h2 className="text-xs text-muted uppercase tracking-wider mb-2">データリセット</h2>
          <div className="bg-card rounded-xl p-4 flex flex-col gap-2">
            <button
              onClick={() => setConfirmReset('body')}
              className="py-2.5 border border-red-400/30 rounded-xl text-sm text-red-400"
            >
              体組成データをリセット
            </button>
            <button
              onClick={() => setConfirmReset('sleep')}
              className="py-2.5 border border-red-400/30 rounded-xl text-sm text-red-400"
            >
              睡眠データをリセット
            </button>
            <button
              onClick={() => setConfirmReset('all')}
              className="py-2.5 bg-red-500/10 border border-red-500 rounded-xl text-sm text-red-400 font-semibold"
            >
              すべてのデータをリセット
            </button>
          </div>
        </section>

        {/* App version */}
        <p className="text-center text-xs text-muted">統合ヘルストラッカー v0.0.1</p>

      </div>

      {/* Reset confirm dialog */}
      {confirmReset && (
        <div className="fixed inset-0 bg-black/70 z-40 flex items-end">
          <div className="bg-surface rounded-t-2xl w-full p-6 flex flex-col gap-4">
            <h3 className="text-white font-semibold">確認</h3>
            <p className="text-sm text-muted">
              {confirmReset === 'all'
                ? '全データ（体組成・睡眠・設定）を削除します。この操作は取り消せません。'
                : confirmReset === 'body'
                ? '体組成データをすべて削除します。この操作は取り消せません。'
                : '睡眠データをすべて削除します。この操作は取り消せません。'}
            </p>
            <button onClick={executeReset} className="py-3 bg-red-500 text-white rounded-xl font-semibold">
              削除する
            </button>
            <button onClick={() => setConfirmReset(null)} className="py-3 text-muted text-sm">
              キャンセル
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
