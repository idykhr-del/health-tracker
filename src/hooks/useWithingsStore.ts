import { useState, useEffect, useCallback, useRef } from 'react'
import type { WithingsTokens, WithingsSyncStatus, BodyRecord } from '../types'

const TOKEN_KEY      = 'withings_tokens'
const LAST_SYNC_KEY  = 'withings_last_sync'
const PENDING_COOKIE = 'withings_pending'
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

// ── Cookie helpers ────────────────────────────────────────────────────────────
// iOS では Safari と PWA(Standalone) で localStorage が別々だが Cookie は共有される。
// コールバックページで書いた withings_pending Cookie をここで読み取る。

function readPendingCookie(): WithingsTokens | null {
  try {
    const match = document.cookie.match(/(?:^|;\s*)withings_pending=([^;]+)/)
    if (!match) return null
    const decoded = decodeURIComponent(match[1])
    console.log('[useWithingsStore] withings_pending cookie found')
    return JSON.parse(decoded) as WithingsTokens
  } catch (e) {
    console.warn('[useWithingsStore] failed to parse withings_pending cookie:', e)
    return null
  }
}

function clearPendingCookie(): void {
  try {
    document.cookie = `${PENDING_COOKIE}=; Path=/; Max-Age=0`
    console.log('[useWithingsStore] withings_pending cookie cleared')
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

  // ── Detect return from OAuth callback ────────────────────────────────────
  // iOS PWAはSafariとlocalStorageが別々。CookieはSafari/PWA間で共有される。
  // mount・visibilitychange・focus の3タイミングでCookieを確認し、
  // 見つかればlocalStorageへ移してトークンとして採用する。
  useEffect(() => {
    const tokensRef_current = tokens  // snapshot for closure

    const checkForPendingAuth = () => {
      console.log('[useWithingsStore] checkForPendingAuth called, isConnected:', !!tokensRef_current)

      // 1. Cookie経由（iOS Safari→PWA連携の主要経路）
      const pending = readPendingCookie()
      if (pending) {
        clearPendingCookie()
        saveTokens(pending)
        localStorage.setItem('withings_last_sync', '0')
        console.log('[useWithingsStore] tokens loaded from cookie ✅')
        setTokens(pending)
        syncedRef.current = false
        return
      }

      // 2. localStorage直読み（PWAコンテキスト内でコールバックが開かれた場合）
      const fresh = loadTokens()
      if (fresh && !tokensRef_current) {
        console.log('[useWithingsStore] tokens loaded from localStorage ✅')
        setTokens(fresh)
        syncedRef.current = false
      }
    }

    // マウント時にも即チェック（リダイレクト後の再描画に対応）
    checkForPendingAuth()

    document.addEventListener('visibilitychange', checkForPendingAuth)
    window.addEventListener('focus', checkForPendingAuth)
    return () => {
      document.removeEventListener('visibilitychange', checkForPendingAuth)
      window.removeEventListener('focus', checkForPendingAuth)
    }
  // tokens が変化したらクロージャを更新するため再登録
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
