import { useState, useCallback } from 'react'
import type { Goals, AppSettings, WithingsSyncStatus, AutoSleepLastImport } from '../types'
import { exportBodyCSV, exportSleepCSV, downloadFile } from '../utils/export'
import type { BodyRecord, SleepRecord } from '../types'

interface Props {
  goals: Goals
  settings: AppSettings
  bodyRecords: BodyRecord[]
  sleepRecords: SleepRecord[]
  autoSleepLastImport: AutoSleepLastImport
  onUpdateGoals: (goals: Goals) => void
  onResetBody: () => void
  onResetSleep: () => void
  onResetAll: () => void
  onClearHistory: () => void
  showToast: (msg: string, type?: 'success' | 'error' | 'info') => void
  // Withings
  withingsConnected: boolean
  withingsSyncStatus: WithingsSyncStatus
  withingsSyncError: string | null
  withingsLastSync: string | null
  onWithingsConnect: () => void
  onWithingsDisconnect: () => void
  onWithingsSyncNow: () => void
  // workout-tracker
  workoutSameOrigin: boolean
  workoutSessionCount: number
  workoutLastSync: string | null
}

// ── デバッグパネル ────────────────────────────────────────────────────────────

function DebugPanel() {
  const [info, setInfo] = useState<string[]>([])

  const collect = useCallback(() => {
    const lines: string[] = []
    const add = (label: string, val: unknown) =>
      lines.push(`${label}: ${String(val)}`)

    add('standalone', (navigator as Navigator & { standalone?: boolean }).standalone ?? 'n/a')
    add('href',       window.location.href)
    add('hash',       window.location.hash || '(empty)')
    add('search',     window.location.search || '(empty)')

    const tokens = localStorage.getItem('withings_tokens')
    add('withings_tokens',    tokens ? `EXISTS (${tokens.slice(0, 40)}...)` : 'NOT FOUND')
    add('withings_last_sync', localStorage.getItem('withings_last_sync') ?? 'NOT FOUND')

    const hash = window.location.hash
    const qIdx = hash.indexOf('?')
    if (qIdx !== -1) {
      const p = new URLSearchParams(hash.slice(qIdx + 1))
      add('hash.withings_token',   p.get('withings_token')   ? 'EXISTS' : 'none')
      add('hash.withings_refresh', p.get('withings_refresh') ? 'EXISTS' : 'none')
      add('hash.withings_userid',  p.get('withings_userid')  ?? 'none')
    } else {
      add('hash params', 'none')
    }

    try {
      localStorage.setItem('_dbg', '1')
      const ok = localStorage.getItem('_dbg') === '1'
      localStorage.removeItem('_dbg')
      add('ls write test', ok ? 'OK' : 'FAIL')
    } catch (e) {
      add('ls write test', `ERROR: ${e}`)
    }

    add('userAgent', navigator.userAgent.slice(0, 100))
    setInfo(lines)
  }, [])

  // マウント時に自動収集
  useState(() => { collect() })

  const copyAll = useCallback(() => {
    navigator.clipboard.writeText(info.join('\n')).catch(() => {/* ignore */})
  }, [info])

  return (
    <div className="border border-yellow-500/40 rounded-xl overflow-hidden">
      <div className="px-4 py-3 bg-yellow-500/10 flex items-center justify-between">
        <span className="text-xs font-semibold text-yellow-400">🔧 デバッグパネル</span>
        <button
          onClick={collect}
          className="text-[10px] px-2 py-1 bg-yellow-500/20 rounded text-yellow-300"
        >
          再取得
        </button>
      </div>
      <div className="px-4 py-3 bg-black/40 font-mono text-[11px] text-green-300 leading-6 break-all whitespace-pre-wrap">
        {info.length > 0 ? info.join('\n') : '取得中...'}
      </div>
      <div className="px-4 py-3 flex flex-col gap-2">
        <button
          onClick={copyAll}
          className="py-2.5 bg-surface border border-border rounded-xl text-xs text-muted"
        >
          全文コピー（開発者に送る）
        </button>
        <p className="text-[10px] text-muted leading-5">
          standalone: true → PWAモード正常 ／ false → Safariで動作中（これが原因）
        </p>
      </div>
    </div>
  )
}

export default function Settings({
  goals, settings, bodyRecords, sleepRecords, autoSleepLastImport,
  onUpdateGoals, onResetBody, onResetSleep, onResetAll, onClearHistory, showToast,
  withingsConnected, withingsSyncStatus, withingsSyncError, withingsLastSync,
  onWithingsConnect, onWithingsDisconnect, onWithingsSyncNow,
  workoutSameOrigin, workoutSessionCount, workoutLastSync,
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

  const syncBtnLabel =
    withingsSyncStatus === 'syncing' ? '同期中...' :
    withingsSyncStatus === 'success' ? '✓ 同期完了' : '今すぐ同期'

  return (
    <div className="overflow-y-auto h-full pb-6">
      <div className="px-4 pt-4 flex flex-col gap-5">

        {/* ── Withings連携 ────────────────────────────────────────────────── */}
        <section>
          <h2 className="text-sm font-semibold text-white mb-1">Withings 連携</h2>

          {withingsConnected ? (
            <div className="bg-card rounded-xl p-4 flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <span className="text-accentGreen text-lg">✅</span>
                <div>
                  <p className="text-sm text-white font-medium">連携済み</p>
                  {withingsLastSync && (
                    <p className="text-xs text-muted">最終同期: {withingsLastSync}</p>
                  )}
                </div>
              </div>

              {withingsSyncError && (
                <p className="text-xs text-red-400 bg-red-400/10 rounded-lg px-3 py-2">
                  {withingsSyncError}
                </p>
              )}

              <div className="flex gap-2">
                <button
                  onClick={onWithingsSyncNow}
                  disabled={withingsSyncStatus === 'syncing'}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-semibold transition-colors
                    ${withingsSyncStatus === 'syncing'
                      ? 'bg-border text-muted cursor-not-allowed'
                      : withingsSyncStatus === 'success'
                      ? 'bg-accentGreen/20 text-accentGreen border border-accentGreen/30'
                      : 'bg-accent text-bg'}`}
                >
                  {syncBtnLabel}
                </button>
                <button
                  onClick={() => {
                    onWithingsDisconnect()
                    showToast('Withings連携を解除しました')
                  }}
                  className="px-4 py-2.5 border border-red-400/40 rounded-xl text-sm text-red-400"
                >
                  解除
                </button>
              </div>
            </div>
          ) : (
            <div className="bg-card rounded-xl p-4 flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <span className="text-accentOrange text-lg">⚠️</span>
                <div>
                  <p className="text-sm text-white font-medium">未連携</p>
                  <p className="text-xs text-muted">
                    Withings Body SmartのデータをAPI経由で自動取得します。
                  </p>
                </div>
              </div>
              <button
                onClick={onWithingsConnect}
                className="w-full py-2.5 bg-accent text-bg rounded-xl font-semibold text-sm"
              >
                Withingsアカウントと連携する
              </button>
              <p className="text-xs text-muted">
                ※ developer.withings.com で Client ID / Secret を取得し、
                Vercel 環境変数に設定してください。
              </p>
            </div>
          )}
        </section>

        {/* ── workout-tracker 連携 ─────────────────────────────────────────── */}
        <section>
          <h2 className="text-sm font-semibold text-white mb-1">workout-tracker 連携</h2>
          <div className="bg-card rounded-xl p-4 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              {workoutSessionCount > 0 ? (
                <span className="text-accentGreen">✅</span>
              ) : (
                <span className="text-muted">○</span>
              )}
              <div>
                <p className="text-sm text-white font-medium">
                  {workoutSameOrigin ? '自動連携中（同一ドメイン）' : 'ファイルインポート'}
                </p>
                <p className="text-xs text-muted">
                  {workoutSessionCount > 0
                    ? `最終読み込み: アプリ起動時（${workoutSessionCount}件）${workoutLastSync ? ' / 最終: ' + workoutLastSync : ''}`
                    : 'データなし'}
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ── AutoSleep連携状態 ────────────────────────────────────────────── */}
        <section>
          <h2 className="text-sm font-semibold text-white mb-1">AutoSleep 連携</h2>
          <div className="bg-card rounded-xl p-4 flex flex-col gap-3">
            {(['A', 'B'] as const).map(method => {
              const stat = autoSleepLastImport[method]
              return (
                <div key={method} className="flex items-center gap-2">
                  <span className="text-accentPurple">📥</span>
                  <div>
                    <p className="text-sm text-white font-medium">
                      方法{method}：{method === 'A' ? 'Health Auto Export JSON' : 'AutoSleep CSV'}
                    </p>
                    <p className="text-xs text-muted">
                      {stat
                        ? `最終取り込み: ${stat.date}（${stat.count}件）`
                        : '未取り込み'}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        {/* ── 目標値設定 ───────────────────────────────────────────────────── */}
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

        {/* ── 連携状態サマリー ─────────────────────────────────────────────── */}
        <section>
          <h2 className="text-xs text-muted uppercase tracking-wider mb-2">データ件数サマリー</h2>
          <div className="bg-card rounded-xl p-4 flex flex-col gap-3">
            {[
              { label: 'Withings 体組成', date: lastBodyDate,  count: bodyRecords.length,  color: 'accent' },
              { label: 'AutoSleep 睡眠',  date: lastSleepDate, count: sleepRecords.length, color: 'accentPurple' },
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

        {/* ── データエクスポート ──────────────────────────────────────────── */}
        <section>
          <h2 className="text-xs text-muted uppercase tracking-wider mb-2">データエクスポート</h2>
          <div className="bg-card rounded-xl p-4 flex flex-col gap-2">
            <button onClick={handleExportBodyCSV}  className="py-2.5 bg-surface border border-border rounded-xl text-sm text-white hover:border-accent transition-colors">体組成 CSV エクスポート</button>
            <button onClick={handleExportSleepCSV} className="py-2.5 bg-surface border border-border rounded-xl text-sm text-white hover:border-accentPurple transition-colors">睡眠 CSV エクスポート</button>
            <button onClick={handleExportAllJSON}  className="py-2.5 bg-surface border border-border rounded-xl text-sm text-white hover:border-accentGreen transition-colors">全データ JSON エクスポート</button>
          </div>
        </section>

        {/* ── インポート履歴 ────────────────────────────────────────────────── */}
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

        {/* ── データリセット ────────────────────────────────────────────────── */}
        <section>
          <h2 className="text-xs text-muted uppercase tracking-wider mb-2">データリセット</h2>
          <div className="bg-card rounded-xl p-4 flex flex-col gap-2">
            <button onClick={() => setConfirmReset('body')}  className="py-2.5 border border-red-400/30 rounded-xl text-sm text-red-400">体組成データをリセット</button>
            <button onClick={() => setConfirmReset('sleep')} className="py-2.5 border border-red-400/30 rounded-xl text-sm text-red-400">睡眠データをリセット</button>
            <button onClick={() => setConfirmReset('all')}   className="py-2.5 bg-red-500/10 border border-red-500 rounded-xl text-sm text-red-400 font-semibold">すべてのデータをリセット</button>
          </div>
        </section>

        <p className="text-center text-xs text-muted">統合ヘルストラッカー v0.0.2</p>

        {/* ── デバッグパネル ────────────────────────────────────────────────── */}
        <DebugPanel />

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
            <button onClick={executeReset} className="py-3 bg-red-500 text-white rounded-xl font-semibold">削除する</button>
            <button onClick={() => setConfirmReset(null)} className="py-3 text-muted text-sm">キャンセル</button>
          </div>
        </div>
      )}
    </div>
  )
}
