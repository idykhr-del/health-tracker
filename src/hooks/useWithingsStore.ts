import { useState, useEffect, useCallback, useRef } from 'react'
import type { WithingsTokens, WithingsSyncStatus, BodyRecord } from '../types'

const TOKEN_KEY     = 'withings_tokens'
const LAST_SYNC_KEY = 'withings_last_sync'
const SYNC_INTERVAL = 60 * 60 * 1000  // 1時間 (ms)

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

// ── Withings API response types ───────────────────────────────────────────────

interface WithingsDataResponse {
  records:    BodyRecord[]
  newTokens?: { access_token: string; refresh_token: string; expires_at: number }
  error?:     string
}

interface CallbackJsonResponse {
  access_token?:  string
  refresh_token?: string
  userid?:        string
  expires_at?:    number
  error?:         string
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useWithingsStore(
  onRecordsFetched: (records: BodyRecord[]) => void,
) {
  const [tokens,     setTokens]     = useState<WithingsTokens | null>(() => loadTokens())
  const [syncStatus, setSyncStatus] = useState<WithingsSyncStatus>('idle')
  const [syncError,  setSyncError]  = useState<string | null>(null)
  const [lastSyncMs, setLastSyncMs] = useState<number>(() => getLastSyncTime())
  const syncedRef    = useRef(false)
  const codeHandled  = useRef(false)  // 二重実行防止

  const isConnected   = tokens !== null
  const lastSyncLabel = lastSyncMs > 0 ? relativeTime(lastSyncMs) : null

  // ── 起動時: URLの ?code= を検出してフロントからトークン交換 ──────────────────
  // iOS PWA では Service Worker が /api/withings-callback を index.html で返すため、
  // React が起動した後に自ら /api/withings-callback?code=... を fetch してトークンを取得する。
  useEffect(() => {
    if (codeHandled.current) return
    const search = window.location.search          // "?code=xxx&state=health-tracker"
    const params = new URLSearchParams(search)
    const code   = params.get('code')
    const state  = params.get('state')

    if (!code || state !== 'health-tracker') return
    codeHandled.current = true

    // URLをすぐにクリーンアップ（codeが残り続けないように）
    window.history.replaceState(null, '', '/')

    console.log('[useWithingsStore] OAuth code detected in URL, fetching tokens...')
    setSyncStatus('syncing')

    fetch(`/api/withings-callback${search}`)
      .then(res => res.json())
      .then((data: CallbackJsonResponse) => {
        if (data.error || !data.access_token || !data.refresh_token || !data.userid) {
          console.error('[useWithingsStore] Token exchange failed:', data.error)
          setSyncStatus('error')
          setSyncError(data.error ?? 'トークン取得に失敗しました')
          return
        }

        const newTokens: WithingsTokens = {
          access_token:  data.access_token,
          refresh_token: data.refresh_token,
          userid:        data.userid,
          expires_at:    data.expires_at ?? Math.floor(Date.now() / 1000) + 10800,
        }
        saveTokens(newTokens)
        localStorage.setItem(LAST_SYNC_KEY, '0')
        setTokens(newTokens)
        setSyncStatus('idle')
        syncedRef.current = false

        // 設定タブへのナビゲーションをアプリ全体に通知
        window.dispatchEvent(new CustomEvent('withings:connected'))
        console.log('[useWithingsStore] Tokens saved from OAuth callback ✅ userid:', data.userid)
      })
      .catch(e => {
        console.error('[useWithingsStore] Fetch error:', e)
        setSyncStatus('error')
        setSyncError(`通信エラー: ${String(e)}`)
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])  // マウント時1回のみ

  // ── connect: auth URLを取得してPWA内で直接遷移 ───────────────────────────────
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

  // ── disconnect: トークンを削除 ────────────────────────────────────────────
  const disconnect = useCallback(() => {
    clearTokens()
    setTokens(null)
    setSyncStatus('idle')
    setSyncError(null)
    setLastSyncMs(0)
  }, [])

  // ── syncNow: /api/withings-data からボディデータを取得 ───────────────────────
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

  // ── マウント時の自動同期 ──────────────────────────────────────────────────
  useEffect(() => {
    if (!tokens || syncedRef.current) return
    const elapsed = Date.now() - getLastSyncTime()
    if (elapsed < SYNC_INTERVAL) return
    syncedRef.current = true
    syncNow(tokens)
  }, [tokens, syncNow])

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
