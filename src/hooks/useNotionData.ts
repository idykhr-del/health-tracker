import { useState, useEffect, useCallback } from 'react'
import type { NotionWorkout } from '../types'

interface StravaActivity {
  id:               string
  date:             string
  name:             string
  type:             'running' | 'walking' | 'cycling' | 'other'
  distanceKm?:      number
  durationMinutes?: number
}

interface UseNotionDataReturn {
  notionWorkouts:  NotionWorkout[]
  stravaActivities: StravaActivity[]
  notionLoading:   boolean
  notionError:     string | null
  notionRefresh:   () => void
}

/**
 * Notion DB からトレーニング・Strava データを取得するフック。
 * /api/notion/workout と /api/notion/strava を並列で呼び出す。
 */
export function useNotionData(): UseNotionDataReturn {
  const [notionWorkouts,   setNotionWorkouts]   = useState<NotionWorkout[]>([])
  const [stravaActivities, setStravaActivities] = useState<StravaActivity[]>([])
  const [notionLoading,    setNotionLoading]    = useState(false)
  const [notionError,      setNotionError]      = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    setNotionLoading(true)
    setNotionError(null)
    try {
      const [workoutRes, stravaRes] = await Promise.all([
        fetch('/api/notion/workout'),
        fetch('/api/notion/strava'),
      ])

      const workoutData = await workoutRes.json() as { workouts?: NotionWorkout[]; error?: string }
      const stravaData  = await stravaRes.json()  as { activities?: StravaActivity[]; error?: string }

      if (workoutData.error) console.warn('[useNotionData] workout:', workoutData.error)
      if (stravaData.error)  console.warn('[useNotionData] strava:',  stravaData.error)

      setNotionWorkouts(   workoutData.workouts   ?? [])
      setStravaActivities( stravaData.activities  ?? [])
    } catch (e) {
      console.warn('[useNotionData] error:', e)
      setNotionError(String(e))
    } finally {
      setNotionLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  return { notionWorkouts, stravaActivities, notionLoading, notionError, notionRefresh: fetchData }
}
