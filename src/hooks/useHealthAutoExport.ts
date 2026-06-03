import { useState, useEffect, useCallback } from 'react'
import type { BodyRecord, SleepRecord, HaeActivityRecord } from '../types'

interface HaeApiResponse {
  bodyRecords?:        Partial<BodyRecord>[]
  sleepRecords?:       Partial<SleepRecord>[]
  activityRecords?:    HaeActivityRecord[]
  sleepStartHistory?:  number[]
  error?:              string
}

interface UseHealthAutoExportReturn {
  haeBody:             BodyRecord[]
  haeSleep:            SleepRecord[]
  haeActivity:         HaeActivityRecord[]
  sleepStartHistory:   number[]
  haeLoading:          boolean
  haeError:            string | null
  haeRefresh:          () => void
}

/**
 * Upstash Redis に保存された Health Auto Export データを取得するフック。
 * アプリ起動時に /api/health-data を呼び出す（直近7日分）。
 */
export function useHealthAutoExport(): UseHealthAutoExportReturn {
  const [haeBody,            setHaeBody]            = useState<BodyRecord[]>([])
  const [haeSleep,           setHaeSleep]           = useState<SleepRecord[]>([])
  const [haeActivity,        setHaeActivity]        = useState<HaeActivityRecord[]>([])
  const [sleepStartHistory,  setSleepStartHistory]  = useState<number[]>([])
  const [haeLoading,         setHaeLoading]         = useState(false)
  const [haeError,           setHaeError]           = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setHaeLoading(true)
    setHaeError(null)
    try {
      const res  = await fetch('/api/health-data')
      const data = await res.json() as HaeApiResponse

      if (data.error) console.warn('[useHealthAutoExport]', data.error)

      // デバッグ: APIから受け取ったbodyRecordsのbodyFatPctを確認
      console.log('[useHealthAutoExport] bodyRecords count:', (data.bodyRecords ?? []).length)
      ;(data.bodyRecords ?? []).forEach((r: Partial<BodyRecord>) => {
        console.log(`[useHealthAutoExport] body ${r.date}: weight=${r.weight} bodyFatPct=${r.bodyFatPct} leanBodyMass=${r.leanBodyMass}`)
      })
      console.log('[useHealthAutoExport] activityRecords:', JSON.stringify(data.activityRecords ?? []))

      setHaeBody(           (data.bodyRecords     ?? []) as BodyRecord[])
      setHaeSleep(          (data.sleepRecords    ?? []) as SleepRecord[])
      setHaeActivity(        data.activityRecords ?? [])
      setSleepStartHistory(  data.sleepStartHistory ?? [])
    } catch (e) {
      console.warn('[useHealthAutoExport] fetch error:', e)
      setHaeError(String(e))
    } finally {
      setHaeLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  return { haeBody, haeSleep, haeActivity, sleepStartHistory, haeLoading, haeError, haeRefresh: fetchData }
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
      // Withings にない日付: sec.asleepMinutes は health-data.ts 側で
      // totalMinutes からマップ済みなので、そのまま追加
      map.set(sec.date, { ...sec })
    }
  }

  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date))
}
