import { useState, useRef } from 'react'
import type { BodyRecord, SleepRecord, AppSettings, WorkoutData, AutoSleepLastImport } from '../types'
import { parseWithingsCSV, parseWorkoutJSON } from '../utils/parsers'

interface Props {
  settings: AppSettings
  autoSleepLastImport: AutoSleepLastImport
  onBodyImport: (records: BodyRecord[], overwrite: boolean) => number
  onSleepImport: (records: SleepRecord[], overwrite: boolean) => number
  onAutoSleepImport: (file: File) => Promise<{ records: SleepRecord[]; error?: string }>
  onAutoSleepLastImportUpdate: (method: 'A' | 'B', count: number) => void
  onWorkoutImport: (data: WorkoutData) => void
  workoutSessionCount: number
  workoutLastSync: string | null
  workoutFromFile: boolean
  showToast: (msg: string, type?: 'success' | 'error' | 'info') => void
}

// ── Preview / dialog state ────────────────────────────────────────────────────

interface BodyPreview {
  kind: 'body'
  records: BodyRecord[]
  fileName: string
  duplicates: number
}

interface SleepPreview {
  kind: 'sleep'
  method: 'A' | 'B'
  records: SleepRecord[]
  fileName: string
  duplicates: number
}

type Preview = BodyPreview | SleepPreview

// ── Component ─────────────────────────────────────────────────────────────────

export default function DataManagement({
  settings,
  autoSleepLastImport,
  onBodyImport,
  onSleepImport,
  onAutoSleepImport,
  onAutoSleepLastImportUpdate,
  onWorkoutImport,
  workoutSessionCount,
  workoutLastSync,
  workoutFromFile,
  showToast,
}: Props) {
  const [preview, setPreview]                 = useState<Preview | null>(null)
  const [showOverwriteDialog, setShowOverwrite] = useState(false)
  const [sleepLoading, setSleepLoading]       = useState<'A' | 'B' | null>(null)

  const bodyFileRef    = useRef<HTMLInputElement>(null)
  const sleepAFileRef  = useRef<HTMLInputElement>(null)
  const sleepBFileRef  = useRef<HTMLInputElement>(null)
  const workoutFileRef = useRef<HTMLInputElement>(null)

  // ── Withings CSV ───────────────────────────────────────────────────────────

  const handleBodyFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    const text = await file.text()
    const records = parseWithingsCSV(text)
    if (!records.length) { showToast('CSVの解析に失敗しました', 'error'); return }
    setPreview({ kind: 'body', records, fileName: file.name, duplicates: 0 })
  }

  // ── AutoSleep (A / B) via API ──────────────────────────────────────────────

  const handleSleepFile = async (method: 'A' | 'B', e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setSleepLoading(method)
    const { records, error } = await onAutoSleepImport(file)
    setSleepLoading(null)
    if (error || !records.length) {
      showToast(error ?? 'データが見つかりませんでした', 'error')
      return
    }
    setPreview({ kind: 'sleep', method, records, fileName: file.name, duplicates: 0 })
  }

  // ── Confirm import ─────────────────────────────────────────────────────────

  const handlePreviewSave = () => {
    if (!preview) return
    if (preview.kind === 'body') {
      const count    = onBodyImport(preview.records, false)
      const dupCount = preview.records.length - count
      if (dupCount > 0) {
        setPreview(p => p ? { ...p, duplicates: dupCount } : null)
        setShowOverwrite(true)
      } else {
        showToast(`体組成データ ${count}件をインポートしました`)
        setPreview(null)
      }
    } else {
      const count    = onSleepImport(preview.records, false)
      const dupCount = preview.records.length - count
      if (dupCount > 0) {
        setPreview(p => p ? { ...p, duplicates: dupCount } : null)
        setShowOverwrite(true)
      } else {
        onAutoSleepLastImportUpdate(preview.method, count)
        showToast(`睡眠データ ${count}件をインポートしました`)
        setPreview(null)
      }
    }
  }

  const confirmImport = (overwrite: boolean) => {
    if (!preview) return
    if (preview.kind === 'body') {
      const count = onBodyImport(preview.records, overwrite)
      showToast(`体組成データ ${count}件をインポートしました`)
    } else {
      const count = onSleepImport(preview.records, overwrite)
      onAutoSleepLastImportUpdate(preview.method, count)
      showToast(`睡眠データ ${count}件をインポートしました`)
    }
    setPreview(null)
    setShowOverwrite(false)
  }

  // ── workout-tracker JSON ───────────────────────────────────────────────────

  const handleWorkoutFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    const text = await file.text()
    const data = parseWorkoutJSON(text)
    if (!data) { showToast('workout-trackerのJSONではありません', 'error'); return }
    onWorkoutImport(data)
    showToast(`筋トレデータ ${data.sessions.length}件を読み込みました`)
  }

  // ── Shared UI pieces ───────────────────────────────────────────────────────

  const FileDropZone = ({
    loading, color, label, onClick,
  }: { loading: boolean; color: string; label: string; onClick: () => void }) => (
    <button
      onClick={onClick}
      disabled={loading}
      className={`w-full py-3 border-2 border-dashed rounded-xl text-sm transition-colors
        ${loading
          ? 'border-border text-muted cursor-not-allowed'
          : `border-border text-muted hover:border-${color} hover:text-${color}`}`}
    >
      {loading ? '読み込み中...' : label}
    </button>
  )

  const PreviewCard = ({ p }: { p: Preview }) => (
    <div className="bg-card rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-start gap-2">
        <span className="text-xs bg-accentPurple/20 text-accentPurple px-2 py-0.5 rounded-full shrink-0">
          プレビュー
        </span>
        <p className="text-xs text-white font-medium break-all">{p.fileName}</p>
      </div>
      <p className="text-xs text-muted">{p.records.length}件のデータが見つかりました</p>
      <div className="flex gap-2">
        <button
          onClick={handlePreviewSave}
          className="flex-1 py-2 bg-accentPurple text-white rounded-xl text-sm font-semibold"
        >
          保存する
        </button>
        <button
          onClick={() => setPreview(null)}
          className="px-4 py-2 bg-surface text-muted rounded-xl text-sm"
        >
          キャンセル
        </button>
      </div>
    </div>
  )

  const lastImportLabel = (stat?: { date: string; count: number }) =>
    stat ? `最終取り込み: ${stat.date}（${stat.count}件）` : '未取り込み'

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="overflow-y-auto h-full pb-6">
      <div className="px-4 pt-4 flex flex-col gap-5">

        {/* ── Withings Body Smart CSV ──────────────────────────────────────── */}
        <section>
          <h2 className="text-sm font-semibold text-white mb-1">Withings Body Smart CSVインポート</h2>
          <p className="text-xs text-muted mb-3">
            Health MateアプリのMyData → Exportから出力したCSVをインポートします。
          </p>

          {preview?.kind === 'body' ? (
            <PreviewCard p={preview} />
          ) : (
            <>
              <input ref={bodyFileRef} type="file" accept=".csv" className="hidden" onChange={handleBodyFile} />
              <FileDropZone
                loading={false}
                color="accent"
                label="CSVファイルを選択"
                onClick={() => bodyFileRef.current?.click()}
              />
            </>
          )}
        </section>

        {/* ── AutoSleep 方法A ──────────────────────────────────────────────── */}
        <section>
          <div className="flex items-center gap-2 mb-1">
            <h2 className="text-sm font-semibold text-white">AutoSleep 方法A</h2>
            <span className="text-xs bg-accentPurple/20 text-accentPurple px-2 py-0.5 rounded-full">推奨・準自動</span>
          </div>
          <p className="text-xs text-muted mb-1">
            Health Auto Export（App Store・年1,100円）で毎朝自動保存されたJSONを取り込みます。
          </p>
          <p className="text-xs text-accentGreen mb-3">{lastImportLabel(autoSleepLastImport.A)}</p>

          {/* Step guide accordion */}
          <details className="bg-card rounded-xl mb-3">
            <summary className="px-4 py-3 text-xs text-muted cursor-pointer select-none flex justify-between items-center">
              <span className="font-medium text-white">設定手順を見る</span>
              <span>▼</span>
            </summary>
            <div className="px-4 pb-4 flex flex-col gap-3">
              {[
                {
                  step: 'STEP 1',
                  text: 'App Storeで「Health Auto Export」をインストール（年1,100円）',
                },
                {
                  step: 'STEP 2',
                  text: 'アプリ内でAutomations → Add Automation\nExport Type: JSON\nData: Sleep Analysis を選択\nDestination: iCloud Drive\nSchedule: Daily at 09:00',
                },
                {
                  step: 'STEP 3',
                  text: 'iOSショートカットのオートメーション設定\n毎朝9時に通知 → 1タップでエクスポート自動実行',
                },
                {
                  step: 'STEP 4',
                  text: 'iCloud DriveのJSONファイルをこのボタンで取り込む',
                },
              ].map(({ step, text }) => (
                <div key={step} className="flex gap-3">
                  <span className="text-xs font-bold text-accentPurple shrink-0 w-12">{step}</span>
                  <p className="text-xs text-muted whitespace-pre-line leading-relaxed">{text}</p>
                </div>
              ))}
            </div>
          </details>

          {preview?.kind === 'sleep' && preview.method === 'A' ? (
            <PreviewCard p={preview} />
          ) : (
            <>
              <input
                ref={sleepAFileRef}
                type="file"
                accept=".json"
                className="hidden"
                onChange={e => handleSleepFile('A', e)}
              />
              <FileDropZone
                loading={sleepLoading === 'A'}
                color="accentPurple"
                label="JSONファイルを選択して取り込む"
                onClick={() => sleepAFileRef.current?.click()}
              />
            </>
          )}
        </section>

        {/* ── AutoSleep 方法B ──────────────────────────────────────────────── */}
        <section>
          <div className="flex items-center gap-2 mb-1">
            <h2 className="text-sm font-semibold text-white">AutoSleep 方法B</h2>
            <span className="text-xs bg-border text-muted px-2 py-0.5 rounded-full">無料・週次手動</span>
          </div>
          <p className="text-xs text-muted mb-1">
            AutoSleepアプリのHistory ExportからCSVを出力して取り込みます。
          </p>
          <p className="text-xs text-accentGreen mb-3">{lastImportLabel(autoSleepLastImport.B)}</p>

          {/* Step guide accordion */}
          <details className="bg-card rounded-xl mb-3">
            <summary className="px-4 py-3 text-xs text-muted cursor-pointer select-none flex justify-between items-center">
              <span className="font-medium text-white">エクスポート手順を見る</span>
              <span>▼</span>
            </summary>
            <div className="px-4 pb-4 flex flex-col gap-3">
              {[
                { step: 'STEP 1', text: 'AutoSleepアプリを開く' },
                { step: 'STEP 2', text: '画面下部「Z」タブ → 右上「...」→ Export' },
                { step: 'STEP 3', text: '期間を選択 → Export History（CSVで書き出し）' },
                { step: 'STEP 4', text: '出力されたCSVファイルをこのボタンで取り込む' },
              ].map(({ step, text }) => (
                <div key={step} className="flex gap-3">
                  <span className="text-xs font-bold text-muted shrink-0 w-12">{step}</span>
                  <p className="text-xs text-muted leading-relaxed">{text}</p>
                </div>
              ))}
            </div>
          </details>

          {preview?.kind === 'sleep' && preview.method === 'B' ? (
            <PreviewCard p={preview} />
          ) : (
            <>
              <input
                ref={sleepBFileRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={e => handleSleepFile('B', e)}
              />
              <FileDropZone
                loading={sleepLoading === 'B'}
                color="accentPurple"
                label="CSVファイルを選択して取り込む"
                onClick={() => sleepBFileRef.current?.click()}
              />
            </>
          )}
        </section>

        {/* ── workout-tracker 連携 ─────────────────────────────────────────── */}
        <section>
          <h2 className="text-sm font-semibold text-white mb-1">workout-tracker 連携</h2>
          <div className="bg-card rounded-xl p-4 flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${workoutSessionCount > 0 ? 'bg-accentGreen' : 'bg-red-400'}`} />
              <span className="text-sm text-white">
                {workoutSessionCount > 0 ? `${workoutSessionCount}件 読み込み済み` : 'データなし'}
              </span>
              {workoutFromFile
                ? <span className="text-xs text-muted">（ファイル）</span>
                : workoutSessionCount > 0 && <span className="text-xs text-accentGreen">（同一ドメイン自動連携）</span>}
            </div>
            {workoutLastSync && (
              <p className="text-xs text-muted">最終セッション日: {workoutLastSync}</p>
            )}
            <p className="text-xs text-muted">
              同一ドメインのlocalStorageから自動取得します。
              別ブラウザの場合はworkout-trackerのJSONエクスポートをインポートしてください。
            </p>
            <input ref={workoutFileRef} type="file" accept=".json" className="hidden" onChange={handleWorkoutFile} />
            <button
              onClick={() => workoutFileRef.current?.click()}
              className="py-2 border border-border rounded-xl text-muted text-sm hover:border-accentGreen hover:text-accentGreen transition-colors"
            >
              JSONファイルをインポート
            </button>
          </div>
        </section>

        {/* ── インポート履歴 ─────────────────────────────────────────────────── */}
        {settings.importHistory.length > 0 && (
          <section>
            <h2 className="text-xs text-muted uppercase tracking-wider mb-2">インポート履歴</h2>
            <div className="bg-card rounded-xl overflow-hidden">
              {[...settings.importHistory].reverse().slice(0, 10).map(h => (
                <div key={h.id} className="flex items-center justify-between px-4 py-3 border-b border-border last:border-0">
                  <div>
                    <p className="text-xs text-white">{h.source}</p>
                    <p className="text-xs text-muted">{new Date(h.timestamp).toLocaleString('ja-JP')}</p>
                  </div>
                  <span className={`text-xs font-medium px-2 py-1 rounded-full
                    ${h.type === 'body'  ? 'bg-accent/20 text-accent' :
                      h.type === 'sleep' ? 'bg-accentPurple/20 text-accentPurple' :
                                           'bg-accentGreen/20 text-accentGreen'}`}>
                    {h.count}件
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

      </div>

      {/* ── 重複確認ダイアログ ──────────────────────────────────────────────── */}
      {showOverwriteDialog && preview && (
        <div className="fixed inset-0 bg-black/70 z-40 flex items-end">
          <div className="bg-surface rounded-t-2xl w-full p-6 flex flex-col gap-4">
            <h3 className="text-white font-semibold">重複データがあります</h3>
            <p className="text-sm text-muted">
              {preview.duplicates}件のデータが既存と日付が重複しています。上書きしますか？
            </p>
            <button
              onClick={() => confirmImport(true)}
              className="py-3 bg-accentPurple text-white rounded-xl font-semibold"
            >
              上書きして保存
            </button>
            <button
              onClick={() => confirmImport(false)}
              className="py-3 bg-card text-white rounded-xl"
            >
              重複をスキップして保存
            </button>
            <button
              onClick={() => { setShowOverwrite(false); setPreview(null) }}
              className="py-3 text-muted text-sm"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
