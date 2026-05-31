import { useState, useEffect, useCallback } from 'react'
import type { BodyRecord, SleepRecord, HaeActivityRecord } from '../types'

interface HaeApiResponse {
  bodyRecords?:     Partial<BodyRecord>[]
  sleepRecords?:    Partial<SleepRecord>[]
  activityRecords?: HaeActivityRecord[]
  error?:           string
}

interface UseHealthAutoExportReturn {
  haeBody:      BodyRecord[]
  haeSleep:     SleepRecord[]
  haeActivity:  HaeActivityRecord[]
  haeLoading:   boolean
  haeError:     string | null
  haeRefresh:   () => void
}

/**
 * Upstash Redis に保存された Health Auto Export データを取得するフック。
 * アプリ起動時に /api/health-data を呼び出す（直近7日分）。
 */
export function useHealthAutoExport(): UseHealthAutoExportReturn {
  const [haeBody,     setHaeBody]     = useState<BodyRecord[]>([])
  const [haeSleep,    setHaeSleep]    = useState<SleepRecord[]>([])
  const [haeActivity, setHaeActivity] = useState<HaeActivityRecord[]>([])
  const [haeLoading,  setHaeLoading]  = useState(false)
  const [haeError,    setHaeError]    = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setHaeLoading(true)
    setHaeError(null)
    try {
      const res  = await fetch('/api/health-data')
      const data = await res.json() as HaeApiResponse

      if (data.error) console.warn('[useHealthAutoExport]', data.error)

      setHaeBody(    (data.bodyRecords     ?? []) as BodyRecord[])
      setHaeSleep(   (data.sleepRecords    ?? []) as SleepRecord[])
      setHaeActivity( data.activityRecords ?? [])
    } catch (e) {
      console.warn('[useHealthAutoExport] fetch error:', e)
      setHaeError(String(e))
    } finally {
      setHaeLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  return { haeBody, haeSleep, haeActivity, haeLoading, haeError, haeRefresh: fetchData }
}

/**
 * 体組成レコードをマージする。
 * - 同一日: primary を優先しつつ、HAE 固有フィールド (leanBodyMass 等) を補完
 * - primary にない日付: secondary をそのまま追加
 */
export function mergeBodyRecords(primary: BodyRecord[], secondary: BodyRecord[]): BodyRecord[] {
  const map = new Map<string, BodyRecord>(primary.map(r => [r.date, { ...r }]))

  for (const sec of secondary) {
    if (map.has(sec.date)) {
      // Withings にない HAE 固有フィールドを補完
      const existing = map.get(sec.date)!
      if (existing.bodyFatPct          == null) existing.bodyFatPct          = sec.bodyFatPct
      if (existing.leanBodyMass        == null) existing.leanBodyMass        = sec.leanBodyMass
      if (existing.estimatedMuscleMass == null) existing.estimatedMuscleMass = sec.estimatedMuscleMass
    } else {
      // Withings にない日付は HAE レコードをそのまま追加（weight が必須なのでチェック）
      if (sec.weight != null) map.set(sec.date, sec)
    }
  }

  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * 睡眠レコードをマージする。
 * - 同一日: primary 優先。totalMinutes/deepMinutes/remMinutes は HAE 値で補完
 * - primary にない日付: secondary をそのまま追加
 */
export function mergeSleepRecords(primary: SleepRecord[], secondary: SleepRecord[]): SleepRecord[] {
  const map = new Map<string, SleepRecord>(primary.map(r => [r.date, { ...r }]))

  for (const sec of secondary) {
    const haeRec = sec as SleepRecord & { totalMinutes?: number }
    if (map.has(sec.date)) {
      // Withings レコードに HAE 値で不足フィールドを補完
      const existing = map.get(sec.date)!
      if (existing.asleepMinutes == null) existing.asleepMinutes = haeRec.totalMinutes ?? sec.asleepMinutes
      if (existing.deepMinutes   == null) existing.deepMinutes   = sec.deepMinutes
      if (existing.remMinutes    == null) existing.remMinutes    = sec.remMinutes
    } else {
      // Withings にない日付: totalMinutes → asleepMinutes にマップして追加
      const mapped: SleepRecord = {
        ...sec,
        asleepMinutes: haeRec.totalMinutes ?? sec.asleepMinutes,
      }
      map.set(sec.date, mapped)
    }
  }

  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date))
}
