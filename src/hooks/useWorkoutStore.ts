import { useState, useEffect, useCallback } from 'react'
import { loadWorkoutSync, loadWorkoutAsync } from '../utils/storage'
import type { WorkoutData } from '../types'

export function useWorkoutStore() {
  const [data, setData] = useState<WorkoutData>(() => loadWorkoutSync())
  const [fromFile, setFromFile] = useState(false)

  // Hydrate from IndexedDB on mount
  useEffect(() => {
    loadWorkoutAsync().then(idbData => {
      if (!idbData) return
      setData(prev =>
        idbData.sessions.length > prev.sessions.length ? idbData : prev
      )
    })
  }, [])

  const lastSyncDate = data.sessions.length
    ? [...data.sessions].sort((a, b) => b.date.localeCompare(a.date))[0].date
    : null

  const importFromJSON = useCallback((imported: WorkoutData) => {
    setData(imported)
    setFromFile(true)
  }, [])

  return {
    data,
    sessions: data.sessions,
    sessionCount: data.sessions.length,
    lastSyncDate,
    fromFile,
    importFromJSON,
    isSameOrigin: !fromFile && data.sessions.length > 0,
  }
}
