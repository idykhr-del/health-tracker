import { useState, useCallback, useEffect } from 'react'
import { useBodyStore } from './hooks/useBodyStore'
import { useWorkoutStore } from './hooks/useWorkoutStore'
import { useToast } from './hooks/useToast'
import { useSettings } from './hooks/useSettings'
import { useWithingsStore } from './hooks/useWithingsStore'
import Dashboard      from './tabs/Dashboard'
import Charts         from './tabs/Charts'
import Analysis       from './tabs/Analysis'
import DataManagement from './tabs/DataManagement'
import Settings       from './tabs/Settings'
import ToastContainer from './components/ui/ToastContainer'
import type { BodyRecord, SleepRecord, WorkoutData } from './types'

type Tab = 'dashboard' | 'charts' | 'analysis' | 'data' | 'settings'

const TABS: { key: Tab; icon: string; label: string }[] = [
  { key: 'dashboard', icon: '📊', label: 'ホーム' },
  { key: 'charts',    icon: '📈', label: 'グラフ' },
  { key: 'analysis',  icon: '💡', label: '分析' },
  { key: 'data',      icon: '📥', label: 'データ' },
  { key: 'settings',  icon: '⚙️', label: '設定' },
]

const TAB_TITLES: Record<Tab, string> = {
  dashboard: '統合ヘルストラッカー',
  charts:    'グラフ',
  analysis:  '分析',
  data:      'データ管理',
  settings:  '設定',
}

export default function App() {
  const [tab, setTab] = useState<Tab>(() => {
    // '#settings': Withings コールバック後の戻り（旧方式・念のため残す）
    if (window.location.hash === '#settings') {
      window.history.replaceState(null, '', '/')
      return 'settings'
    }
    // '?code=': OAuth code が URL に残っている → useWithingsStore が処理するのでここでは設定タブを表示
    if (new URLSearchParams(window.location.search).get('code')) {
      return 'settings'
    }
    return 'dashboard'
  })

  // withings:connected カスタムイベント受信 → 設定タブへ遷移
  useEffect(() => {
    const handler = () => setTab('settings')
    window.addEventListener('withings:connected', handler)
    return () => window.removeEventListener('withings:connected', handler)
  }, [])

  const bodyStore    = useBodyStore()
  const workoutStore = useWorkoutStore()
  const { toasts, showToast, dismissToast } = useToast()
  const { settings, addImportHistory, clearHistory } = useSettings()

  // ── Withings store ────────────────────────────────────────────────────────
  const handleWithingsRecords = useCallback((records: BodyRecord[]) => {
    bodyStore.overwriteBodyRecords(records)
    addImportHistory({
      timestamp: new Date().toISOString(),
      source:    'Withings API',
      count:     records.length,
      type:      'body',
    })
    showToast(`Withings: ${records.length}件を同期しました`)
  }, [bodyStore, addImportHistory, showToast])

  const withings = useWithingsStore(handleWithingsRecords)

  // ── import handlers ───────────────────────────────────────────────────────

  const handleBodyImport = useCallback((records: BodyRecord[], overwrite: boolean): number => {
    if (overwrite) {
      bodyStore.overwriteBodyRecords(records)
      addImportHistory({ timestamp: new Date().toISOString(), source: 'Withings CSV', count: records.length, type: 'body' })
      return records.length
    }
    const existingDates = new Set(bodyStore.data.bodyRecords.map(r => r.date))
    const newRecords = records.filter(r => !existingDates.has(r.date))
    bodyStore.addBodyRecords(newRecords)
    if (newRecords.length > 0) {
      addImportHistory({ timestamp: new Date().toISOString(), source: 'Withings CSV', count: newRecords.length, type: 'body' })
    }
    return newRecords.length
  }, [bodyStore, addImportHistory])

  const handleSleepImport = useCallback((records: SleepRecord[], overwrite: boolean): number => {
    const sourceLabel = records[0]?.source === 'health_auto_export' ? 'Health Auto Export JSON' : 'AutoSleep CSV'
    if (overwrite) {
      bodyStore.overwriteSleepRecords(records)
      addImportHistory({ timestamp: new Date().toISOString(), source: sourceLabel, count: records.length, type: 'sleep' })
      return records.length
    }
    const existingDates = new Set(bodyStore.data.sleepRecords.map(r => r.date))
    const newRecords = records.filter(r => !existingDates.has(r.date))
    bodyStore.addSleepRecords(newRecords)
    if (newRecords.length > 0) {
      addImportHistory({ timestamp: new Date().toISOString(), source: sourceLabel, count: newRecords.length, type: 'sleep' })
    }
    return newRecords.length
  }, [bodyStore, addImportHistory])

  const handleWorkoutImport = useCallback((data: WorkoutData) => {
    workoutStore.importFromJSON(data)
    addImportHistory({ timestamp: new Date().toISOString(), source: 'workout-tracker JSON', count: data.sessions.length, type: 'workout' })
  }, [workoutStore, addImportHistory])

  return (
    <div className="flex flex-col h-svh bg-bg text-white">
      {/* Header */}
      <header className="flex items-center justify-between px-4 pt-12 pb-3 border-b border-border bg-surface shrink-0">
        <h1 className="text-base font-bold text-white">{TAB_TITLES[tab]}</h1>
        <div className="text-accent text-lg">🏃</div>
      </header>

      {/* Page content */}
      <main className="flex-1 overflow-hidden relative">
        {TABS.map(t => (
          <div
            key={t.key}
            className={`absolute inset-0 transition-opacity duration-150 ${tab === t.key ? 'opacity-100 z-10' : 'opacity-0 z-0 pointer-events-none'}`}
          >
            {t.key === 'dashboard' && (
              <Dashboard
                data={bodyStore.data}
                sessions={workoutStore.sessions}
                onNavigateToData={() => setTab('data')}
                withingsSyncStatus={withings.syncStatus}
                withingsLastSync={withings.lastSyncLabel}
                onWithingsSyncNow={withings.syncNow}
              />
            )}
            {t.key === 'charts' && (
              <Charts
                data={bodyStore.data}
                sessions={workoutStore.sessions}
                onNavigateToData={() => setTab('data')}
              />
            )}
            {t.key === 'analysis' && (
              <Analysis
                data={bodyStore.data}
                sessions={workoutStore.sessions}
                onNavigateToData={() => setTab('data')}
              />
            )}
            {t.key === 'data' && (
              <DataManagement
                settings={settings}
                autoSleepLastImport={bodyStore.autoSleepLastImport}
                onBodyImport={handleBodyImport}
                onSleepImport={handleSleepImport}
                onAutoSleepImport={bodyStore.importAutoSleepData}
                onAutoSleepLastImportUpdate={bodyStore.updateAutoSleepLastImport}
                onWorkoutImport={handleWorkoutImport}
                workoutSessionCount={workoutStore.sessionCount}
                workoutLastSync={workoutStore.lastSyncDate}
                workoutFromFile={workoutStore.fromFile}
                showToast={showToast}
              />
            )}
            {t.key === 'settings' && (
              <Settings
                goals={bodyStore.data.goals}
                settings={settings}
                bodyRecords={bodyStore.data.bodyRecords}
                sleepRecords={bodyStore.data.sleepRecords}
                autoSleepLastImport={bodyStore.autoSleepLastImport}
                onUpdateGoals={bodyStore.updateGoals}
                onResetBody={bodyStore.resetBodyData}
                onResetSleep={bodyStore.resetSleepData}
                onResetAll={bodyStore.resetAll}
                onClearHistory={clearHistory}
                showToast={showToast}
                withingsConnected={withings.isConnected}
                withingsSyncStatus={withings.syncStatus}
                withingsSyncError={withings.syncError}
                withingsLastSync={withings.lastSyncLabel}
                onWithingsConnect={withings.connect}
                onWithingsDisconnect={withings.disconnect}
                onWithingsSyncNow={withings.syncNow}
                workoutSameOrigin={!workoutStore.fromFile && workoutStore.sessionCount > 0}
                workoutSessionCount={workoutStore.sessionCount}
                workoutLastSync={workoutStore.lastSyncDate}
              />
            )}
          </div>
        ))}
      </main>

      {/* Bottom navigation */}
      <nav className="shrink-0 flex border-t border-border bg-surface pb-safe">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 flex flex-col items-center gap-0.5 py-2 transition-colors
              ${tab === t.key ? 'text-accent' : 'text-muted'}`}
          >
            <span className="text-lg leading-none">{t.icon}</span>
            <span className="text-[10px]">{t.label}</span>
          </button>
        ))}
      </nav>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
    </div>
  )
}
