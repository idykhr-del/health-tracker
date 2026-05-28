import { useState, useCallback, useEffect } from 'react'
import type { Goals, AppSettings, WithingsSyncStatus, AutoSleepLastImport } from '../types'
import { exportBodyCSV, exportSleepCSV, downloadFile } from '../utils/export'
import type { BodyRecord, SleepRecord } from '../types'
import { migrateBodyRecords, hasMigratedBody, markMigratedBody } from '../utils/notionBodySync'

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
  // Notion
  isBodyNotionLoading?: boolean
}

// ── デバッグパネル ────────────────────────────────────────────────────────────

function DebugPanel() {
  const [lines, setLines] = useState<string[]>([])
  const [fetching, setFetching] = useState(false)

  const addLine = useCallback((text: string) => {
    setLines(prev => [...prev, `${new Date().toISOString().slice(11, 23)} ${text}`])
  }, [])

  const collect = useCallback(() => {
    const rows: string[] = []
    const r = (label: string, val: unknown) => rows.push(`${label}: ${String(val)}`)

    r('standalone', (navigator as Navigator & { standalone?: boolean }).standalone ?? 'n/a')
    r('href',    window.location.href)
    r('search',  window.location.search  || '(empty)')
    r('hash',    window.location.hash    || '(empty)')
    r('pathname', window.location.pathname)

    const tokens = localStorage.getItem('withings_tokens')
    r('withings_tokens',    tokens ? `EXISTS(${tokens.slice(0,50)}...)` : 'NOT FOUND')
    r('withings_last_sync', localStorage.getItem('withings_last_sync') ?? 'NOT FOUND')

    // search から code を抽出
    const sp    = new URLSearchParams(window.location.search)
    const code  = sp.get('code')
    const state = sp.get('state')
    r('search.code',  code  ? code.slice(0, 12) + '...' : 'none')
    r('search.state', state ?? 'none')

    // href から正規表現で抽出（URLSearchParamsで取れないケース）
    const mCode  = window.location.href.match(/[?&]code=([^&#]+)/)
    const mState = window.location.href.match(/[?&]state=([^&#]+)/)
    r('href.code(regex)',  mCode  ? mCode[1].slice(0, 12) + '...' : 'none')
    r('href.state(regex)', mState ? mState[1] : 'none')

    try {
      localStorage.setItem('_dbg', '1')
      const ok = localStorage.getItem('_dbg') === '1'
      localStorage.removeItem('_dbg')
      r('ls write', ok ? 'OK' : 'FAIL')
    } catch (e) { r('ls write', `ERROR: ${e}`) }

    r('userAgent', navigator.userAgent.slice(0, 80))
    setLines(rows)
  }, [])

  // マウント時に自動収集
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { collect() }, [])

  // ── Withings API 直接テスト ────────────────────────────────────────────────
  const testWithingsApi = useCallback(async () => {
    setFetching(true)
    addLine('--- Withings API テスト 開始 ---')

    const raw = localStorage.getItem('withings_tokens')
    if (!raw) {
      addLine('❌ withings_tokens が localStorage にありません')
      setFetching(false)
      return
    }

    let tokens: Record<string, unknown>
    try { tokens = JSON.parse(raw) as Record<string, unknown> }
    catch { addLine('❌ withings_tokens のJSONパース失敗'); setFetching(false); return }

    // access_token の最初の20文字を表示（デバッグ用）
    const tokenStr = String(tokens['access_token'] ?? '')
    addLine(`access_token(20文字): ${tokenStr.slice(0, 20)}...`)
    addLine(`access_token 長さ: ${tokenStr.length}文字`)
    addLine('POST /api/withings-data ...')

    try {
      const res  = await fetch('/api/withings-data', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          access_token:  tokens['access_token'],
          refresh_token: tokens['refresh_token'],
        }),
      })
      addLine(`HTTP status: ${res.status}`)

      const data = await res.json() as {
        records?: Record<string, unknown>[]
        error?:   string
        detail?:  string
        debug?: {
          totalGrps:       number
          totalSessions:   number
          recordsReturned: number
          meastypesFound:  number[]
          meastypeCounts:  Record<number, number>
          firstRecord:     Record<string, unknown> | null
          latestRecord:    Record<string, unknown> | null
        }
      }

      if (data.error) {
        addLine(`❌ error: ${data.error}`)
        if (data.detail) addLine(`  detail: ${data.detail}`)
        setFetching(false); return
      }

      // records 件数
      addLine(`✅ records: ${data.records?.length ?? 0}件`)

      if (data.debug) {
        const d = data.debug
        addLine(`totalGrps: ${d.totalGrps} / totalSessions: ${d.totalSessions}`)
        addLine(`meastypesFound: [${d.meastypesFound.join(', ')}]`)

        const LABELS: Record<number, string> = {
          1: '体重', 6: '体脂肪率', 8: '筋肉量', 73: 'BMI',
          76: '除脂肪体重', 77: '水分量', 88: '骨量',
          170: '内臓脂肪', 226: '基礎代謝', 227: '代謝年齢',
        }
        for (const [type, count] of Object.entries(d.meastypeCounts)) {
          const label = LABELS[Number(type)] ?? `type${type}`
          addLine(`  meastype${type}(${label}): ${count}件`)
        }

        // 最初のレコード
        if (d.firstRecord) {
          addLine('--- 最初のレコード ---')
          for (const [k, v] of Object.entries(d.firstRecord)) {
            if (k !== 'source' && v !== undefined) addLine(`  ${k}: ${v}`)
          }
        }
        // 最新レコード
        if (d.latestRecord) {
          addLine('--- 最新のレコード ---')
          for (const [k, v] of Object.entries(d.latestRecord)) {
            if (k !== 'source' && v !== undefined) addLine(`  ${k}: ${v}`)
          }
        }
      }
    } catch (e) {
      addLine(`❌ fetchエラー: ${e}`)
    }
    setFetching(false)
  }, [addLine])

  // ── 手動コード交換 ─────────────────────────────────────────────────────────
  const manualExchange = useCallback(async () => {
    setFetching(true)
    addLine('--- 手動コード交換 開始 ---')

    // code を search と href の両方から探す
    const sp  = new URLSearchParams(window.location.search)
    let code  = sp.get('code')
    let state = sp.get('state')
    if (!code) {
      const m = window.location.href.match(/[?&]code=([^&#]+)/)
      code = m ? decodeURIComponent(m[1]) : null
    }
    if (!state) {
      const m = window.location.href.match(/[?&]state=([^&#]+)/)
      state = m ? decodeURIComponent(m[1]) : null
    }

    addLine(`code: ${code ? code.slice(0, 12) + '...' : 'NOT FOUND'}`)
    addLine(`state: ${state ?? 'null'}`)

    if (!code) {
      addLine('❌ code が見つかりません。先にWithings認証を行ってください')
      setFetching(false)
      return
    }

    const fetchUrl = `/api/withings-callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state ?? '')}`
    addLine(`fetch → ${fetchUrl.slice(0, 60)}...`)

    try {
      const res  = await fetch(fetchUrl)
      addLine(`HTTP status: ${res.status}`)
      const json = await res.json() as Record<string, unknown>
      addLine(`response keys: ${Object.keys(json).join(', ')}`)

      if (json['error']) {
        addLine(`❌ error: ${json['error']}`)
      } else if (json['access_token']) {
        const tokensStr = JSON.stringify(json)
        localStorage.setItem('withings_tokens', tokensStr)
        localStorage.setItem('withings_last_sync', '0')
        addLine('✅ localStorageに保存しました')
        addLine('ページをリロードして連携状態を確認してください')
        window.history.replaceState(null, '', '/')
        // カスタムイベントでアプリに通知
        window.dispatchEvent(new CustomEvent('withings:connected'))
        collect()  // パネル情報を再取得
      } else {
        addLine('❌ access_tokenが見つかりません')
        addLine(JSON.stringify(json).slice(0, 200))
      }
    } catch (e) {
      addLine(`❌ fetchエラー: ${e}`)
    }
    setFetching(false)
  }, [addLine, collect])

  const copyAll = useCallback(() => {
    navigator.clipboard.writeText(lines.join('\n')).catch(() => {/* ignore */})
  }, [lines])

  return (
    <div className="border border-yellow-500/40 rounded-xl overflow-hidden">
      <div className="px-4 py-3 bg-yellow-500/10 flex items-center justify-between">
        <span className="text-xs font-semibold text-yellow-400">🔧 デバッグパネル</span>
        <button onClick={collect} className="text-[10px] px-2 py-1 bg-yellow-500/20 rounded text-yellow-300">
          再取得
        </button>
      </div>

      {/* ステータス表示 */}
      <div className="px-4 py-3 bg-black/40 font-mono text-[11px] text-green-300 leading-5 break-all whitespace-pre-wrap max-h-56 overflow-y-auto">
        {lines.length > 0 ? lines.join('\n') : '読み込み中...'}
      </div>

      {/* 操作ボタン */}
      <div className="px-4 py-3 flex flex-col gap-2">
        <button
          onClick={testWithingsApi}
          disabled={fetching}
          className={`py-3 rounded-xl text-sm font-semibold
            ${fetching ? 'bg-border text-muted' : 'bg-blue-500/20 border border-blue-500/50 text-blue-300'}`}
        >
          {fetching ? '実行中...' : '📡 Withings APIを直接テスト'}
        </button>
        <button
          onClick={manualExchange}
          disabled={fetching}
          className={`py-3 rounded-xl text-sm font-semibold
            ${fetching ? 'bg-border text-muted' : 'bg-yellow-500/20 border border-yellow-500/50 text-yellow-300'}`}
        >
          {fetching ? '実行中...' : '🔑 手動でコード交換を試みる'}
        </button>
        <button onClick={copyAll} className="py-2.5 bg-surface border border-border rounded-xl text-xs text-muted">
          全文コピー（開発者に送る）
        </button>
        <p className="text-[10px] text-muted leading-5">
          「Withings APIテスト」→ どのmeastypeが返ってきているか確認<br />
          「手動コード交換」→ Withings認証直後の ?code= を使って連携
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
  isBodyNotionLoading,
}: Props) {
  const [editGoals, setEditGoals] = useState<Goals>({ ...goals })
  const [confirmReset, setConfirmReset] = useState<'body' | 'sleep' | 'all' | null>(null)

  // ── Notion migration state ─────────────────────────────────────────────────
  const [migrating,     setMigrating]     = useState(false)
  const [migrationDone, setMigrationDone] = useState(() => hasMigratedBody())
  const [migProgress,   setMigProgress]   = useState(0)
  const [migResult,     setMigResult]     = useState<{ success: number; errors: number } | null>(null)

  const handleMigrate = useCallback(async () => {
    if (migrating || bodyRecords.length === 0) return
    setMigrating(true)
    setMigProgress(0)
    setMigResult(null)

    const result = await migrateBodyRecords(bodyRecords, ({ done, total }) => {
      setMigProgress(Math.round((done / total) * 100))
    })

    setMigResult(result)
    setMigrating(false)

    if (result.errors === 0) {
      markMigratedBody()
      setMigrationDone(true)
      showToast(`Notionへの移行完了：${result.success}件`, 'success')
    } else {
      showToast(`移行完了（エラー ${result.errors}件）`, 'error')
    }
  }, [migrating, bodyRecords, showToast])

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

        {/* ── Notion連携 ──────────────────────────────────────────────────── */}
        <section>
          <h2 className="text-sm font-semibold text-white mb-1">Notion 連携</h2>
          <div className="bg-card rounded-xl p-4 flex flex-col gap-3">

            {/* 同期状態 */}
            <div className="flex items-center gap-2">
              {isBodyNotionLoading ? (
                <>
                  <span className="text-accent animate-pulse">⏳</span>
                  <div>
                    <p className="text-sm text-white font-medium">Notionから読み込み中…</p>
                    <p className="text-xs text-muted">初回起動時はしばらくお待ちください</p>
                  </div>
                </>
              ) : migrationDone ? (
                <>
                  <span className="text-accentGreen text-lg">✅</span>
                  <div>
                    <p className="text-sm text-white font-medium">Notion同期 有効</p>
                    <p className="text-xs text-muted">
                      体組成データはNotion DBと自動同期されます
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <span className="text-accentOrange text-lg">☁️</span>
                  <div>
                    <p className="text-sm text-white font-medium">Notion連携</p>
                    <p className="text-xs text-muted">
                      body_records DBと自動同期します。初回はデータを移行してください。
                    </p>
                  </div>
                </>
              )}
            </div>

            {/* 移行セクション */}
            {!migrationDone && (
              <div className="flex flex-col gap-2 pt-1 border-t border-border">
                <p className="text-xs text-muted">
                  ローカルの体組成データ（{bodyRecords.length}件）をNotionへ一括アップロードします。
                  初回のみ実行してください。
                </p>

                {migrating && (
                  <div className="flex flex-col gap-1">
                    <div className="h-1.5 bg-surface rounded-full overflow-hidden">
                      <div
                        className="h-full bg-accent rounded-full transition-all duration-300"
                        style={{ width: `${migProgress}%` }}
                      />
                    </div>
                    <p className="text-xs text-muted text-right">{migProgress}%</p>
                  </div>
                )}

                {migResult && !migrating && (
                  <p className={`text-xs ${migResult.errors === 0 ? 'text-accentGreen' : 'text-red-400'}`}>
                    {migResult.errors === 0
                      ? `✅ ${migResult.success}件の移行が完了しました`
                      : `⚠️ ${migResult.success}件成功 / ${migResult.errors}件エラー`}
                  </p>
                )}

                <button
                  onClick={handleMigrate}
                  disabled={migrating || bodyRecords.length === 0}
                  className={`py-2.5 rounded-xl text-sm font-semibold transition-colors
                    ${migrating || bodyRecords.length === 0
                      ? 'bg-border text-muted cursor-not-allowed'
                      : 'bg-accent text-bg'}`}
                >
                  {migrating ? `移行中… (${migProgress}%)` : 'Notionへ移行する'}
                </button>

                {bodyRecords.length === 0 && (
                  <p className="text-xs text-muted">
                    体組成データがありません。先にWithingsまたはCSVからインポートしてください。
                  </p>
                )}
              </div>
            )}

            {migrationDone && (
              <button
                onClick={() => setMigrationDone(false)}
                className="text-xs text-muted underline text-left"
              >
                再移行する
              </button>
            )}
          </div>
        </section>

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
