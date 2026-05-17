import { useState, useEffect, useCallback } from 'react'
import { loadBodySync, loadBodyAsync, saveBody, clearBody } from '../utils/storage'
import type { BodyData, BodyRecord, SleepRecord, Goals, AutoSleepLastImport } from '../types'

const AUTOSLEEP_LAST_IMPORT_KEY = 'autosleep_last_import'

// ── AutoSleep last-import persistence ─────────────────────────────────────────

function loadAutoSleepLastImport(): AutoSleepLastImport {
  try {
    const raw = localStorage.getItem(AUTOSLEEP_LAST_IMPORT_KEY)
    if (raw) return JSON.parse(raw) as AutoSleepLastImport
  } catch { /* ignore */ }
  return {}
}

function saveAutoSleepLastImport(val: AutoSleepLastImport): void {
  try { localStorage.setItem(AUTOSLEEP_LAST_IMPORT_KEY, JSON.stringify(val)) } catch { /* ignore */ }
}

// ── API response type ─────────────────────────────────────────────────────────

interface AutoSleepImportResponse {
  records?: SleepRecord[]
  error?:   string
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useBodyStore() {
  const [data, setData] = useState<BodyData>(() => loadBodySync())
  const [autoSleepLastImport, setAutoSleepLastImport] = useState<AutoSleepLastImport>(
    () => loadAutoSleepLastImport()
  )

  // Hydrate from IndexedDB on mount (may have more data than localStorage)
  useEffect(() => {
    loadBodyAsync().then(idbData => {
      if (!idbData) return
      setData(prev => mergeBodyData(prev, idbData))
    })
  }, [])

  const persist = useCallback((next: BodyData) => {
    setData(next)
    saveBody(next)
  }, [])

  // ── Body records ──────────────────────────────────────────────────────────

  const addBodyRecords = useCallback((incoming: BodyRecord[]) => {
    setData(prev => {
      const existingDates = new Set(prev.bodyRecords.map(r => r.date))
      const merged = [
        ...prev.bodyRecords,
        ...incoming.filter(r => !existingDates.has(r.date)),
      ]
      const next = { ...prev, bodyRecords: merged }
      saveBody(next)
      return next
    })
  }, [])

  const overwriteBodyRecords = useCallback((incoming: BodyRecord[]) => {
    setData(prev => {
      const incomingDates = new Set(incoming.map(r => r.date))
      const kept = prev.bodyRecords.filter(r => !incomingDates.has(r.date))
      const next = { ...prev, bodyRecords: [...kept, ...incoming] }
      saveBody(next)
      return next
    })
  }, [])

  // ── Sleep records ─────────────────────────────────────────────────────────

  const addSleepRecords = useCallback((incoming: SleepRecord[]) => {
    setData(prev => {
      const existingDates = new Set(prev.sleepRecords.map(r => r.date))
      const merged = [
        ...prev.sleepRecords,
        ...incoming.filter(r => !existingDates.has(r.date)),
      ]
      const next = { ...prev, sleepRecords: merged }
      saveBody(next)
      return next
    })
  }, [])

  const overwriteSleepRecords = useCallback((incoming: SleepRecord[]) => {
    setData(prev => {
      const incomingDates = new Set(incoming.map(r => r.date))
      const kept = prev.sleepRecords.filter(r => !incomingDates.has(r.date))
      const next = { ...prev, sleepRecords: [...kept, ...incoming] }
      saveBody(next)
      return next
    })
  }, [])

  // Returns count of duplicates so caller can show override dialog
  const checkDuplicates = useCallback((
    type: 'body' | 'sleep',
    incoming: BodyRecord[] | SleepRecord[],
  ): number => {
    if (type === 'body') {
      const existingDates = new Set(data.bodyRecords.map(r => r.date))
      return (incoming as BodyRecord[]).filter(r => existingDates.has(r.date)).length
    }
    const existingDates = new Set(data.sleepRecords.map(r => r.date))
    return (incoming as SleepRecord[]).filter(r => existingDates.has(r.date)).length
  }, [data])

  // ── AutoSleep import via API ──────────────────────────────────────────────

  /**
   * ファイルを /api/autosleep-import へ送信し、パース済みレコードを返す。
   * 保存はしない — 呼び出し元がダイアログを出してから overwriteSleepRecords / addSleepRecords を呼ぶ。
   */
  const importAutoSleepData = useCallback(async (
    file: File,
  ): Promise<{ records: SleepRecord[]; error?: string }> => {
    try {
      const content = await file.text()
      const res = await fetch('/api/autosleep-import', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ content, filename: file.name }),
      })
      const json = await res.json() as AutoSleepImportResponse
      if (!res.ok || json.error) {
        return { records: [], error: json.error ?? `HTTP ${res.status}` }
      }
      return { records: json.records ?? [] }
    } catch (e) {
      return { records: [], error: `ネットワークエラー: ${String(e)}` }
    }
  }, [])

  /**
   * AutoSleep 最終取り込み情報を更新する（インポート確定後に呼ぶ）
   */
  const updateAutoSleepLastImport = useCallback((
    method: 'A' | 'B',
    count:  number,
  ) => {
    const date = new Date().toISOString().slice(0, 10)
    setAutoSleepLastImport(prev => {
      const next = { ...prev, [method]: { date, count } }
      saveAutoSleepLastImport(next)
      return next
    })
  }, [])

  // ── Goals ─────────────────────────────────────────────────────────────────

  const updateGoals = useCallback((goals: Goals) => {
    setData(prev => {
      const next = { ...prev, goals }
      saveBody(next)
      return next
    })
  }, [])

  // ── Reset ─────────────────────────────────────────────────────────────────

  const resetBodyData = useCallback(() => {
    persist({ bodyRecords: [], sleepRecords: data.sleepRecords, goals: data.goals })
  }, [data.goals, data.sleepRecords, persist])

  const resetSleepData = useCallback(() => {
    setData(prev => {
      const next = { ...prev, sleepRecords: [] }
      saveBody(next)
      return next
    })
    setAutoSleepLastImport({})
    saveAutoSleepLastImport({})
  }, [])

  const resetAll = useCallback(() => {
    clearBody()
    setData({ bodyRecords: [], sleepRecords: [], goals: {} })
    setAutoSleepLastImport({})
    saveAutoSleepLastImport({})
  }, [])

  return {
    data,
    autoSleepLastImport,
    addBodyRecords,
    addSleepRecords,
    checkDuplicates,
    overwriteBodyRecords,
    overwriteSleepRecords,
    importAutoSleepData,
    updateAutoSleepLastImport,
    updateGoals,
    resetBodyData,
    resetSleepData,
    resetAll,
  }
}

// ── merge helper ─────────────────────────────────────────────────────────────

function mergeBodyData(a: BodyData, b: BodyData): BodyData {
  if (b.bodyRecords.length > a.bodyRecords.length || b.sleepRecords.length > a.sleepRecords.length) {
    return {
      bodyRecords:  b.bodyRecords.length  >= a.bodyRecords.length  ? b.bodyRecords  : a.bodyRecords,
      sleepRecords: b.sleepRecords.length >= a.sleepRecords.length ? b.sleepRecords : a.sleepRecords,
      goals: Object.keys(b.goals).length ? b.goals : a.goals,
    }
  }
  return a
}
