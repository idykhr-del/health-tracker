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

// ── URLハッシュパラメータからトークンを読み取る ──────────────────────────────
// コールバックが /#/settings?withings_token=...&withings_refresh=...&... に
// リダイレクトするので、ハッシュ部分からパラメータを抽出する。
// 例: window.location.hash === "#/settings?withings_token=abc&withings_refresh=def&..."

function parseWithingsHashParams(): WithingsTokens | null {
  try {
    const hash = window.location.hash           // "#/settings?withings_token=..."
    const qIdx = hash.indexOf('?')
    if (qIdx === -1) return null

    const params = new URLSearchParams(hash.slice(qIdx + 1))
    const access_token  = params.get('withings_token')
    const refresh_token = params.get('withings_refresh')
    const userid        = params.get('withings_userid')
    const expires_str   = params.get('withings_expires')

    if (!access_token || !refresh_token || !userid || !expires_str) return null

    console.log('[useWithingsStore] withings token params found in URL hash ✅')
    return {
      access_token,
      refresh_token,
      userid,
      expires_at: parseInt(expires_str, 10),
    }
  } catch (e) {
    console.warn('[useWithingsStore] failed to parse hash params:', e)
    return null
  }
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
  // URLハッシュにトークンがあれば優先して使う（OAuth コールバック直後）
  const [tokens, setTokens] = useState<WithingsTokens | null>(() => {
    const fromHash = parseWithingsHashParams()
    if (fromHash) {
      saveTokens(fromHash)
      localStorage.setItem(LAST_SYNC_KEY, '0')
      // ハッシュはクリーンアップ（useEffect でやると1フレーム遅れるため初期化時に実行）
      try { window.history.replaceState(null, '', '/#settings') } catch { /* ignore */ }
      console.log('[useWithingsStore] tokens initialized from URL hash ✅')
      return fromHash
    }
    return loadTokens()
  })
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

  // ── Detect return from OAuth (fallback: focus/visibilitychange) ──────────
  // URLハッシュからのトークン読み取りは useState 初期化時に済んでいる。
  // focus/visibilitychange は PWA が一時的にサスペンドされたケースへのフォールバック。
  useEffect(() => {
    const checkLocalStorage = () => {
      if (tokens) return  // already connected
      const fresh = loadTokens()
      if (fresh) {
        console.log('[useWithingsStore] tokens detected in localStorage on focus ✅')
        setTokens(fresh)
        syncedRef.current = false
      }
    }
    document.addEventListener('visibilitychange', checkLocalStorage)
    window.addEventListener('focus', checkLocalStorage)
    return () => {
      document.removeEventListener('visibilitychange', checkLocalStorage)
      window.removeEventListener('focus', checkLocalStorage)
    }
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
