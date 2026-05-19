import { useState, useEffect, useCallback, useRef } from 'react'
import type { WithingsTokens, WithingsSyncStatus, BodyRecord } from '../types'

const TOKEN_KEY      = 'withings_tokens'
const LAST_SYNC_KEY  = 'withings_last_sync'
const SYNC_INTERVAL  = 60 * 60 * 1000  // 1時間 (ms)

function loadTokens(): WithingsTokens | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY)
    if (raw) return JSON.parse(raw) as WithingsTokens
  } catch { /* ignore */ }
  return null
}

function saveTokens(tokens: WithingsTokens): void {
  try { localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens)) } catch { /* ignore */ }
}

function clearTokens(): void {
  try {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(LAST_SYNC_KEY)
  } catch { /* ignore */ }
}

function getLastSyncTime(): number {
  try {
    const raw = localStorage.getItem(LAST_SYNC_KEY)
    return raw ? parseInt(raw) : 0
  } catch { return 0 }
}

function setLastSyncTime(): void {
  try { localStorage.setItem(LAST_SYNC_KEY, String(Date.now())) } catch { /* ignore */ }
}

function relativeTime(ts: number): string {
  const diffMs = Date.now() - ts
  const mins   = Math.floor(diffMs / 60000)
  if (mins < 1)  return 'たった今'
  if (mins < 60) return `${mins}分前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}時間前`
  return `${Math.floor(hours / 24)}日前`
}

// ── Withings API response types (mirrors api/withings-data.ts) ────────────────

interface WithingsDataResponse {
  records:    BodyRecord[]
  newTokens?: { access_token: string; refresh_token: string; expires_at: number }
  error?:     string
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useWithingsStore(
  onRecordsFetched: (records: BodyRecord[]) => void,
) {
  const [tokens,     setTokens]     = useState<WithingsTokens | null>(() => loadTokens())
  const [syncStatus, setSyncStatus] = useState<WithingsSyncStatus>('idle')
  const [syncError,  setSyncError]  = useState<string | null>(null)
  const [lastSyncMs, setLastSyncMs] = useState<number>(() => getLastSyncTime())
  const syncedRef = useRef(false)

  const isConnected  = tokens !== null
  const lastSyncLabel = lastSyncMs > 0 ? relativeTime(lastSyncMs) : null

  // ── connect: fetch auth URL then navigate directly ───────────────────────
  // iOS PWA (Standalone) では /api/withings-auth からの302リダイレクトで
  // 外部ドメインへ転送されるとPWAが終了してホーム画面に戻る。
  // JSONでURLを受け取り、window.location.href に直接セットすることで回避。
  const connect = useCallback(async () => {
    try {
      const res  = await fetch('/api/withings-auth')
      const data = await res.json() as { url?: string; error?: string }
      if (data.url) {
        window.location.href = data.url
      } else {
        console.error('[Withings] auth URL取得失敗:', data.error)
      }
    } catch (e) {
      console.error('[Withings] /api/withings-auth fetch エラー:', e)
    }
  }, [])

  // ── disconnect: clear tokens ──────────────────────────────────────────────
  const disconnect = useCallback(() => {
    clearTokens()
    setTokens(null)
    setSyncStatus('idle')
    setSyncError(null)
    setLastSyncMs(0)
  }, [])

  // ── syncNow: fetch body data from /api/withings-data ─────────────────────
  const syncNow = useCallback(async (currentTokens?: WithingsTokens) => {
    const t = currentTokens ?? tokens
    if (!t) return

    setSyncStatus('syncing')
    setSyncError(null)

    try {
      const resp = await fetch('/api/withings-data', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          access_token:  t.access_token,
          refresh_token: t.refresh_token,
        }),
      })

      const data = await resp.json() as WithingsDataResponse

      if (!resp.ok || data.error) {
        setSyncStatus('error')
        setSyncError(data.error ?? `HTTP ${resp.status}`)
        return
      }

      // Update tokens if refreshed
      if (data.newTokens) {
        const updated: WithingsTokens = {
          ...t,
          access_token:  data.newTokens.access_token,
          refresh_token: data.newTokens.refresh_token,
          expires_at:    data.newTokens.expires_at,
        }
        saveTokens(updated)
        setTokens(updated)
      }

      setLastSyncTime()
      setLastSyncMs(Date.now())
      setSyncStatus('success')

      if (data.records?.length) {
        onRecordsFetched(data.records)
      }
    } catch (e) {
      setSyncStatus('error')
      setSyncError(`ネットワークエラー: ${String(e)}`)
    }
  }, [tokens, onRecordsFetched])

  // ── Auto-sync on mount if connected and interval elapsed ─────────────────
  useEffect(() => {
    if (!tokens || syncedRef.current) return
    const elapsed = Date.now() - getLastSyncTime()
    if (elapsed < SYNC_INTERVAL) return
    syncedRef.current = true
    syncNow(tokens)
  }, [tokens, syncNow])

  // ── Detect return from OAuth callback (tokens written to localStorage) ────
  useEffect(() => {
    const handleFocus = () => {
      const fresh = loadTokens()
      if (fresh && !tokens) {
        setTokens(fresh)
        // Auto-sync immediately after connection
        syncedRef.current = false
      }
    }
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [tokens])

  return {
    isConnected,
    syncStatus,
    syncError,
    lastSyncLabel,
    connect,
    disconnect,
    syncNow: () => syncNow(),
  }
}
