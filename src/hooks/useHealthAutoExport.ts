import { useState, useEffect, useCallback } from 'react'
import type { BodyRecord, SleepRecord } from '../types'

interface HaeData {
  bodyRecords:  BodyRecord[]
  sleepRecords: SleepRecord[]
}

interface UseHealthAutoExportReturn {
  haeBody:    BodyRecord[]
  haeSleep:   SleepRecord[]
  haeLoading: boolean
  haeError:   string | null
  haeRefresh: () => void
}

/**
 * Vercel KV に保存された Health Auto Export データを取得するフック。
 * アプリ起動時に /api/health-data を呼び出し、bodyRecords と sleepRecords を返す。
 *
 * マージ戦略（App.tsx 側で実施）:
 *   - 同じ日付は Withings 優先（より精度が高い）
 *   - HAE のみ存在する日付は HAE データを使用
 */
export function useHealthAutoExport(): UseHealthAutoExportReturn {
  const [haeBody,    setHaeBody]    = useState<BodyRecord[]>([])
  const [haeSleep,   setHaeSleep]   = useState<SleepRecord[]>([])
  const [haeLoading, setHaeLoading] = useState(false)
  const [haeError,   setHaeError]   = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setHaeLoading(true)
    setHaeError(null)
    try {
      const res  = await fetch('/api/health-data')
      const data = await res.json() as HaeData & { error?: string }

      if (data.error) {
        // KV 未設定などのエラーはアプリを壊さず静かに処理
        console.warn('[useHealthAutoExport] API returned error:', data.error)
      }

      setHaeBody( (data.bodyRecords  ?? []) as BodyRecord[])
      setHaeSleep((data.sleepRecords ?? []) as SleepRecord[])
    } catch (e) {
      console.warn('[useHealthAutoExport] fetch error:', e)
      setHaeError(String(e))
    } finally {
      setHaeLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  return { haeBody, haeSleep, haeLoading, haeError, haeRefresh: fetchData }
}

/**
 * 2 つの BodyRecord 配列をマージする。
 * 同じ日付は primary を優先。secondary は primary にない日付のみ補完。
 */
export function mergeBodyRecords(primary: BodyRecord[], secondary: BodyRecord[]): BodyRecord[] {
  const primaryDates = new Set(primary.map(r => r.date))
  const merged = [
    ...primary,
    ...secondary.filter(r => !primaryDates.has(r.date)),
  ]
  return merged.sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * 2 つの SleepRecord 配列をマージする。
 * 同じ日付は primary を優先。secondary は primary にない日付のみ補完。
 */
export function mergeSleepRecords(primary: SleepRecord[], secondary: SleepRecord[]): SleepRecord[] {
  const primaryDates = new Set(primary.map(r => r.date))
  const merged = [
    ...primary,
    ...secondary.filter(r => !primaryDates.has(r.date)),
  ]
  return merged.sort((a, b) => a.date.localeCompare(b.date))
}
