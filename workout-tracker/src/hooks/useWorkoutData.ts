import { useState, useCallback, useEffect } from 'react'
import type { WorkoutData, WorkoutSession, CustomExercise } from '../types'
import {
  loadDataSync,
  loadDataAsync,
  saveData,
  clearData,
  clearUsage,
  mergeWorkoutData,
} from '../utils/storage'

export function useWorkoutData() {
  // Initialise instantly from localStorage so there is no loading flash
  const [data, setData] = useState<WorkoutData>(loadDataSync)

  // After mount, check IndexedDB.  If it has more sessions (e.g. after
  // Safari cleared localStorage in standalone mode), upgrade the state.
  useEffect(() => {
    loadDataAsync().then(idbData => {
      if (!idbData) return
      setData(prev => {
        const merged = mergeWorkoutData(prev, idbData)
        // Only trigger re-render when something actually changed
        if (merged === prev) return prev
        return merged
      })
    })
  }, [])

  // ── Mutations ─────────────────────────────────────────────────────────────

  const saveSession = useCallback((session: WorkoutSession) => {
    setData(prev => {
      const idx = prev.sessions.findIndex(s => s.id === session.id)
      const sessions =
        idx >= 0
          ? prev.sessions.map(s => (s.id === session.id ? session : s))
          : [...prev.sessions, session]
      const next = { ...prev, sessions }
      saveData(next)   // → localStorage (sync) + IDB (async)
      return next
    })
  }, [])

  const deleteSession = useCallback((id: string) => {
    setData(prev => {
      const next = { ...prev, sessions: prev.sessions.filter(s => s.id !== id) }
      saveData(next)
      return next
    })
  }, [])

  const addCustomExercise = useCallback((ex: CustomExercise) => {
    setData(prev => {
      const already = prev.customExercises.some(
        c => c.category === ex.category && c.name === ex.name,
      )
      if (already) return prev
      const next = { ...prev, customExercises: [...prev.customExercises, ex] }
      saveData(next)
      return next
    })
  }, [])

  const deleteCustomExercise = useCallback((category: string, name: string) => {
    setData(prev => {
      const next = {
        ...prev,
        customExercises: prev.customExercises.filter(
          c => !(c.category === category && c.name === name),
        ),
      }
      saveData(next)
      return next
    })
  }, [])

  const resetData = useCallback(() => {
    const empty: WorkoutData = { sessions: [], customExercises: [] }
    clearData()        // removes workout_data from localStorage + IDB
    clearUsage()       // removes exercise_usage from localStorage + IDB
    setData(empty)
  }, [])

  return {
    data,
    saveSession,
    deleteSession,
    addCustomExercise,
    deleteCustomExercise,
    resetData,
  }
}
