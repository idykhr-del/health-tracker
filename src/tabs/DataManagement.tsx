import { useState, useRef } from 'react'
import type { BodyRecord, SleepRecord, SleepImportMethod, AppSettings, WorkoutData } from '../types'
import { parseWithingsCSV, parseAutoSleepCSV, parseHealthAutoExportJSON, parseWorkoutJSON } from '../utils/parsers'

interface Props {
  settings: AppSettings
  onSleepMethodChange: (method: SleepImportMethod) => void
  onBodyImport: (records: BodyRecord[], overwrite: boolean) => number
  onSleepImport: (records: SleepRecord[], overwrite: boolean) => number
  onWorkoutImport: (data: WorkoutData) => void
  workoutSessionCount: number
  workoutLastSync: string | null
  workoutFromFile: boolean
  showToast: (msg: string, type?: 'success' | 'error' | 'info') => void
}

interface PreviewState {
  type: 'body' | 'sleep'
  records: BodyRecord[] | SleepRecord[]
  fileName: string
  duplicates: number
}

export default function DataManagement({
  settings,
  onSleepMethodChange,
  onBodyImport,
  onSleepImport,
  onWorkoutImport,
  workoutSessionCount,
  workoutLastSync,
  workoutFromFile,
  showToast,
}: Props) {
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const [showOverwriteDialog, setShowOverwriteDialog] = useState(false)
  const bodyFileRef   = useRef<HTMLInputElement>(null)
  const sleepFileRef  = useRef<HTMLInputElement>(null)
  const workoutFileRef = useRef<HTMLInputElement>(null)

  // ── Withings CSV ──────────────────────────────────────────────────────────
  const handleBodyFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    const records = parseWithingsCSV(text)
    if (!records.length) { showToast('CSVの解析に失敗しました', 'error'); return }

    setPreview({ type: 'body', records, fileName: file.name, duplicates: 0 })
    e.target.value = ''
  }

  // ── AutoSleep / Health Auto Export ────────────────────────────────────────
  const handleSleepFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()

    let records: SleepRecord[] = []
    if (file.name.endsWith('.json')) {
      records = parseHealthAutoExportJSON(text)
    } else {
      records = parseAutoSleepCSV(text)
    }

    if (!records.length) { showToast('ファイルの解析に失敗しました', 'error'); return }
    setPreview({ type: 'sleep', records, fileName: file.name, duplicates: 0 })
    e.target.value = ''
  }

  const confirmImport = (overwrite: boolean) => {
    if (!preview) return
    if (preview.type === 'body') {
      const count = onBodyImport(preview.records as BodyRecord[], overwrite)
      showToast(`体組成データ ${count}件をインポートしました`)
    } else {
      const count = onSleepImport(preview.records as SleepRecord[], overwrite)
      showToast(`睡眠データ ${count}件をインポートしました`)
    }
    setPreview(null)
    setShowOverwriteDialog(false)
  }

  const handlePreviewSave = () => {
    if (!preview) return
    // Check duplicates by calling import with overwrite=false first
    if (preview.type === 'body') {
      const count = onBodyImport(preview.records as BodyRecord[], false)
      const dupCount = preview.records.length - count
      if (dupCount > 0) {
        setPreview(prev => prev ? { ...prev, duplicates: dupCount } : null)
        setShowOverwriteDialog(true)
      } else {
        showToast(`体組成データ ${count}件をインポートしました`)
        setPreview(null)
      }
    } else {
      const count = onSleepImport(preview.records as SleepRecord[], false)
      const dupCount = preview.records.length - count
      if (dupCount > 0) {
        setPreview(prev => prev ? { ...prev, duplicates: dupCount } : null)
        setShowOverwriteDialog(true)
      } else {
        showToast(`睡眠データ ${count}件をインポートしました`)
        setPreview(null)
      }
    }
  }

  // ── workout-tracker JSON ──────────────────────────────────────────────────
  const handleWorkoutFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    const data = parseWorkoutJSON(text)
    if (!data) { showToast('workout-trackerのJSONではありません', 'error'); return }
    onWorkoutImport(data)
    showToast(`筋トレデータ ${data.sessions.length}件を読み込みました`)
    e.target.value = ''
  }

  const sleepMethods: { key: SleepImportMethod; label: string; badge: string }[] = [
    { key: 'A', label: 'Health Auto Export', badge: '推奨' },
    { key: 'B', label: 'iOSショートカット',  badge: '無料' },
    { key: 'C', label: 'AutoSleep直接エクスポート', badge: '手動' },
  ]

  const guideA = `Health Auto Exportの設定手順：
① App Storeで「Health Auto Export」をインストール（年1,100円）
② アプリ内で「睡眠分析」を有効化し、Google Drive またはiCloud Driveへの書き出しを設定
③ iOSオートメーションで毎朝9時に「Health Auto Export: Export」ショートカットを実行
④ 書き出されたJSONファイルをこの画面でインポート`

  const guideB = `iOSショートカットの設定手順：
① 「ショートカット」アプリを開き、新規ショートカットを作成
② アクション追加 → AutoSleep → 「Get Sleep Data」を選択
③ 「テキスト」アクションで取得データを整形
④ 「ファイルに保存」でiCloud Drive/Documents に保存
⑤ オートメーション → 時刻 → 毎朝9時 で上記ショートカットを実行
⑥ 保存されたファイルをこの画面でインポート`

  const guideC = `AutoSleep History Exportの手順：
① AutoSleepアプリを開く
② 右上メニュー → History → 右上のExportボタン
③ 期間を選択してCSVで書き出し
④ このファイルをこの画面でインポート`

  const guides: Record<SleepImportMethod, string> = { A: guideA, B: guideB, C: guideC }

  return (
    <div className="overflow-y-auto h-full pb-6">
      <div className="px-4 pt-4 flex flex-col gap-5">

        {/* Withings CSV */}
        <section>
          <h2 className="text-sm font-semibold text-white mb-1">Withings Body Smart CSVインポート</h2>
          <p className="text-xs text-muted mb-3">
            Health MateアプリのMyData → Exportから出力したCSVをインポートします。
          </p>

          {preview?.type === 'body' ? (
            <div className="bg-card rounded-xl p-4 flex flex-col gap-3">
              <p className="text-sm text-white font-medium">{preview.fileName}</p>
              <p className="text-xs text-muted">{preview.records.length}件のデータが見つかりました</p>
              <div className="flex gap-2">
                <button
                  onClick={handlePreviewSave}
                  className="flex-1 py-2 bg-accent text-bg rounded-xl text-sm font-semibold"
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
          ) : (
            <>
              <input
                ref={bodyFileRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={handleBodyFile}
              />
              <button
                onClick={() => bodyFileRef.current?.click()}
                className="w-full py-3 border-2 border-dashed border-border rounded-xl text-muted text-sm hover:border-accent hover:text-accent transition-colors"
              >
                CSVファイルを選択
              </button>
            </>
          )}
        </section>

        {/* AutoSleep */}
        <section>
          <h2 className="text-sm font-semibold text-white mb-1">AutoSleep データインポート</h2>

          {/* Method tabs */}
          <div className="flex gap-1 bg-surface rounded-xl p-1 mb-3">
            {sleepMethods.map(m => (
              <button
                key={m.key}
                onClick={() => onSleepMethodChange(m.key)}
                className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors relative
                  ${settings.sleepImportMethod === m.key ? 'bg-accentPurple text-white' : 'text-muted'}`}
              >
                方法{m.key}
              </button>
            ))}
          </div>

          {/* Guide accordion */}
          <details className="bg-card rounded-xl mb-3">
            <summary className="px-4 py-3 text-sm text-muted cursor-pointer select-none flex justify-between">
              <span>
                {sleepMethods.find(m => m.key === settings.sleepImportMethod)?.label}
                <span className="ml-2 text-xs bg-accentPurple/20 text-accentPurple px-2 py-0.5 rounded-full">
                  {sleepMethods.find(m => m.key === settings.sleepImportMethod)?.badge}
                </span>
              </span>
              <span>設定手順を見る ▼</span>
            </summary>
            <div className="px-4 pb-4">
              <pre className="text-xs text-muted whitespace-pre-wrap leading-relaxed font-sans">
                {guides[settings.sleepImportMethod]}
              </pre>
            </div>
          </details>

          {preview?.type === 'sleep' ? (
            <div className="bg-card rounded-xl p-4 flex flex-col gap-3">
              <p className="text-sm text-white font-medium">{preview.fileName}</p>
              <p className="text-xs text-muted">{preview.records.length}件のデータが見つかりました</p>
              <div className="flex gap-2">
                <button
                  onClick={handlePreviewSave}
                  className="flex-1 py-2 bg-accent text-bg rounded-xl text-sm font-semibold"
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
          ) : (
            <>
              <input
                ref={sleepFileRef}
                type="file"
                accept=".csv,.json"
                className="hidden"
                onChange={handleSleepFile}
              />
              <button
                onClick={() => sleepFileRef.current?.click()}
                className="w-full py-3 border-2 border-dashed border-border rounded-xl text-muted text-sm hover:border-accentPurple hover:text-accentPurple transition-colors"
              >
                CSV または JSON ファイルを選択
              </button>
            </>
          )}
        </section>

        {/* workout-tracker sync */}
        <section>
          <h2 className="text-sm font-semibold text-white mb-1">workout-tracker 連携</h2>
          <div className="bg-card rounded-xl p-4 flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${workoutSessionCount > 0 ? 'bg-accentGreen' : 'bg-red-400'}`} />
              <span className="text-sm text-white">
                {workoutSessionCount > 0 ? `${workoutSessionCount}件 読み込み済み` : 'データなし'}
              </span>
              {workoutFromFile && <span className="text-xs text-muted">（ファイル）</span>}
              {!workoutFromFile && workoutSessionCount > 0 && (
                <span className="text-xs text-accentGreen">（同一ブラウザ自動連携）</span>
              )}
            </div>
            {workoutLastSync && (
              <p className="text-xs text-muted">最終セッション日: {workoutLastSync}</p>
            )}
            <p className="text-xs text-muted">
              同一ブラウザのlocalStorageから自動取得します。
              別ブラウザの場合はworkout-trackerのJSONエクスポートをインポートしてください。
            </p>
            <input
              ref={workoutFileRef}
              type="file"
              accept=".json"
              className="hidden"
              onChange={handleWorkoutFile}
            />
            <button
              onClick={() => workoutFileRef.current?.click()}
              className="py-2 border border-border rounded-xl text-muted text-sm hover:border-accentGreen hover:text-accentGreen transition-colors"
            >
              JSONファイルをインポート
            </button>
          </div>
        </section>

        {/* Import history */}
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
                    ${h.type === 'body'    ? 'bg-accent/20 text-accent' :
                      h.type === 'sleep'   ? 'bg-accentPurple/20 text-accentPurple' :
                                             'bg-accentGreen/20 text-accentGreen'}`}>
                    {h.count}件
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

      </div>

      {/* Overwrite dialog */}
      {showOverwriteDialog && preview && (
        <div className="fixed inset-0 bg-black/70 z-40 flex items-end">
          <div className="bg-surface rounded-t-2xl w-full p-6 flex flex-col gap-4">
            <h3 className="text-white font-semibold">重複データがあります</h3>
            <p className="text-sm text-muted">
              {preview.duplicates}件のデータが既存と日付が重複しています。
              上書きしますか？
            </p>
            <button
              onClick={() => confirmImport(true)}
              className="py-3 bg-accent text-bg rounded-xl font-semibold"
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
              onClick={() => { setShowOverwriteDialog(false); setPreview(null) }}
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
