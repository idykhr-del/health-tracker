import { useState, useEffect, useCallback } from 'react'
import { loadBodySync, loadBodyAsync, saveBody, clearBody } from '../utils/storage'
import type { BodyData, BodyRecord, SleepRecord, Goals } from '../types'

export function useBodyStore() {
  const [data, setData] = useState<BodyData>(() => loadBodySync())

  // Hydrate from IndexedDB on mount (may have more data than localStorage)
  useEffect(() => {
    loadBodyAsync().then(idbData => {
      if (!idbData) return
      setData(prev => {
        const merged = mergeBodyData(prev, idbData)
        return merged
      })
    })
  }, [])

  const persist = useCallback((next: BodyData) => {
    setData(next)
    saveBody(next)
  }, [])

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

  // Override: replaces records on duplicate dates
  const overwriteBodyRecords = useCallback((incoming: BodyRecord[]) => {
    setData(prev => {
      const incomingDates = new Set(incoming.map(r => r.date))
      const kept = prev.bodyRecords.filter(r => !incomingDates.has(r.date))
      const next = { ...prev, bodyRecords: [...kept, ...incoming] }
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

  const updateGoals = useCallback((goals: Goals) => {
    setData(prev => {
      const next = { ...prev, goals }
      saveBody(next)
      return next
    })
  }, [])

  const resetBodyData = useCallback(() => {
    const empty: BodyData = { bodyRecords: [], sleepRecords: [], goals: data.goals }
    persist(empty)
  }, [data.goals, persist])

  const resetSleepData = useCallback(() => {
    setData(prev => {
      const next = { ...prev, sleepRecords: [] }
      saveBody(next)
      return next
    })
  }, [])

  const resetAll = useCallback(() => {
    clearBody()
    setData({ bodyRecords: [], sleepRecords: [], goals: {} })
  }, [])

  return {
    data,
    addBodyRecords,
    addSleepRecords,
    checkDuplicates,
    overwriteBodyRecords,
    overwriteSleepRecords,
    updateGoals,
    resetBodyData,
    resetSleepData,
    resetAll,
  }
}

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
