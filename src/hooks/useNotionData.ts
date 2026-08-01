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

interface JsonResult<T> {
  data:  T | null
  error: string | null
}

/**
 * 1エンドポイントを取得して JSON を読む。ネットワークエラー・非 2xx・
 * JSON でないレスポンス（Vercel のエラーページ等）をすべて error に畳み込み、
 * 呼び出し側へ throw しない。
 */
async function readJson<T>(url: string): Promise<JsonResult<T>> {
  try {
    const res = await fetch(url)
    const text = await res.text()

    let parsed: T
    try {
      parsed = JSON.parse(text) as T
    } catch {
      // Vercel のエラーページ等、JSON でないレスポンス
      console.warn(`[useNotionData] non-JSON response from ${url}:`, text.slice(0, 300))
      return { data: null, error: `HTTP ${res.status}（JSON でないレスポンス）` }
    }

    // API 自身がエラーを返した場合（200 でも error フィールドを持つケースを含む）
    const apiError = (parsed as { error?: string } | null)?.error
    if (!res.ok || apiError) {
      return { data: null, error: apiError ?? `HTTP ${res.status}` }
    }

    return { data: parsed, error: null }
  } catch (e) {
    return { data: null, error: String(e) }
  }
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
      // 並列取得は維持しつつ、片方が失敗しても もう片方は表示できるように
      // それぞれ独立して読み取る
      const [workout, strava] = await Promise.all([
        readJson<{ workouts?: NotionWorkout[] }>('/api/notion/workout'),
        readJson<{ activities?: StravaActivity[] }>('/api/notion/strava'),
      ])

      if (workout.error) console.warn('[useNotionData] workout:', workout.error)
      if (strava.error)  console.warn('[useNotionData] strava:',  strava.error)

      setNotionWorkouts(   workout.data?.workouts   ?? [])
      setStravaActivities( strava.data?.activities  ?? [])

      const failures = [
        workout.error ? `トレーニング: ${workout.error}` : null,
        strava.error  ? `Strava: ${strava.error}`        : null,
      ].filter((s): s is string => s !== null)

      setNotionError(failures.length > 0 ? failures.join(' / ') : null)
    } catch (e) {
      // readJson は throw しない想定だが、念のため
      console.warn('[useNotionData] error:', e)
      setNotionError(String(e))
    } finally {
      setNotionLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  return { notionWorkouts, stravaActivities, notionLoading, notionError, notionRefresh: fetchData }
}
