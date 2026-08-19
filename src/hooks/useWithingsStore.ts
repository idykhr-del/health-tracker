import { useState, useEffect, useCallback, useRef } from 'react'
import type { WithingsSyncStatus, BodyRecord } from '../types'

/**
 * Withings 連携フック
 *
 * トークンはサーバー（Redis）が唯一の真実の在り処で、フロントは一切保持しない。
 * 以前は localStorage にもトークンを持っていたため、サーバー側が refresh すると
 * localStorage 側の refresh token が失効し（Withings はローテーション制）、
 * しばらくアプリを開かないと 401 になる問題があった。
 *
 * エンドポイント:
 *   GET  /api/withings-data                   → { connected, expires_at, last_sync, auth_error }
 *   POST /api/withings-data                   → 同期（body なし）
 *   POST /api/withings-data?action=disconnect → 連携解除
 */

const LEGACY_TOKEN_KEY = 'withings_tokens'
const LEGACY_SYNC_KEY  = 'withings_last_sync'
const MIGRATED_KEY     = 'withings_migrated_to_server'  // 旧移行フラグ（解除時の掃除用）
const SYNC_INTERVAL    = 60 * 60 * 1000  // 1時間 (ms)

function relativeTime(ts: number): string {
  const diffMs = Date.now() - ts
  const mins   = Math.floor(diffMs / 60000)
  if (mins < 1)  return 'たった今'
  if (mins < 60) return `${mins}分前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}時間前`
  return `${Math.floor(hours / 24)}日前`
}

function lsRemove(...keys: string[]): void {
  try { for (const k of keys) localStorage.removeItem(k) } catch { /* ignore */ }
}

// ── API response types ────────────────────────────────────────────────────────

interface StatusResponse {
  connected:  boolean
  expires_at: number | null
  last_sync:  number | null
  auth_error: string | null
}

interface SyncResponse {
  records?: BodyRecord[]
  error?:   string
  reason?:  string | null
}

interface CallbackResponse {
  ok?:     boolean
  userid?: string
  error?:  string
}

const REAUTH_MESSAGE = '再連携が必要です'

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useWithingsStore(
  onRecordsFetched: (records: BodyRecord[]) => void,
) {
  const [isConnected, setIsConnected] = useState(false)
  const [syncStatus,  setSyncStatus]  = useState<WithingsSyncStatus>('idle')
  const [syncError,   setSyncError]   = useState<string | null>(null)
  const [lastSyncMs,  setLastSyncMs]  = useState<number>(0)
  const bootstrapped = useRef(false)  // 二重実行防止（StrictMode 対策も兼ねる）

  // syncNow を安定させるためコールバックは ref 経由で参照する
  const onRecordsFetchedRef = useRef(onRecordsFetched)
  onRecordsFetchedRef.current = onRecordsFetched

  const lastSyncLabel = lastSyncMs > 0 ? relativeTime(lastSyncMs) : null

  // ── サーバーから連携ステータスを取得 ──────────────────────────────────────
  const fetchStatus = useCallback(async (): Promise<StatusResponse | null> => {
    try {
      const res  = await fetch('/api/withings-data')
      if (!res.ok) {
        console.warn('[withings] status HTTP', res.status)
        return null
      }
      const data = await res.json() as StatusResponse
      setIsConnected(data.connected)
      setLastSyncMs(data.last_sync ?? 0)
      if (data.auth_error) setSyncError(REAUTH_MESSAGE)
      return data
    } catch (e) {
      console.error('[withings] status fetch error:', e)
      return null
    }
  }, [])

  // ── syncNow: サーバー側のトークンで Withings から取得 ───────────────────────
  const syncNow = useCallback(async () => {
    setSyncStatus('syncing')
    setSyncError(null)

    try {
      const res  = await fetch('/api/withings-data', { method: 'POST' })
      const data = await res.json() as SyncResponse

      if (res.status === 401) {
        setIsConnected(false)
        setSyncStatus('error')
        setSyncError(data.error === 'reauth_required'
          ? REAUTH_MESSAGE
          : 'Withings と連携されていません')
        return
      }

      if (!res.ok || data.error) {
        setSyncStatus('error')
        setSyncError(data.error ?? `HTTP ${res.status}`)
        return
      }

      setIsConnected(true)
      setLastSyncMs(Date.now())
      setSyncStatus('success')

      if (data.records?.length) onRecordsFetchedRef.current(data.records)
    } catch (e) {
      setSyncStatus('error')
      setSyncError(`ネットワークエラー: ${String(e)}`)
    }
  }, [])

  // ── 起動時: OAuth コールバック処理 → ステータス取得 → 必要なら移行/同期 ──────
  // iOS PWA では Service Worker が /api/withings-callback を index.html で返すため、
  // React 起動後に自ら /api/withings-callback?code=... を fetch する。
  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true

    const href   = window.location.href
    const search = window.location.search

    let code:  string | null = new URLSearchParams(search).get('code')
    let state: string | null = new URLSearchParams(search).get('state')
    if (!code) {
      const m = href.match(/[?&]code=([^&#]+)/)
      code = m ? decodeURIComponent(m[1]) : null
    }
    if (!state) {
      const m = href.match(/[?&]state=([^&#]+)/)
      state = m ? decodeURIComponent(m[1]) : null
    }

    const exchangeCode = async (authCode: string): Promise<boolean> => {
      if (state !== 'health-tracker') {
        console.warn('[withings] unexpected state value:', state, '(continuing anyway)')
      }
      window.history.replaceState(null, '', '/')
      setSyncStatus('syncing')

      try {
        const res  = await fetch(
          `/api/withings-callback?code=${encodeURIComponent(authCode)}&state=${encodeURIComponent(state ?? '')}`,
        )
        const data = await res.json() as CallbackResponse
        if (!res.ok || data.error || !data.ok) {
          console.error('[withings] token exchange failed:', data.error)
          setSyncStatus('error')
          setSyncError(data.error ?? 'トークン取得に失敗しました')
          return false
        }
        // トークンはサーバー（Redis）に保存済み。フロントは状態を取り直すだけ。
        setSyncStatus('idle')
        setSyncError(null)
        lsRemove(LEGACY_TOKEN_KEY, LEGACY_SYNC_KEY)
        window.dispatchEvent(new CustomEvent('withings:connected'))
        console.log('[withings] connected. userid:', data.userid)
        return true
      } catch (e) {
        console.error('[withings] callback fetch error:', e)
        setSyncStatus('error')
        setSyncError(`通信エラー: ${String(e)}`)
        return false
      }
    }

    void (async () => {
      let justConnected = false
      if (code) justConnected = await exchangeCode(code)

      const status = await fetchStatus()

      if (!status?.connected) return

      // 連携直後、または最終同期から1時間以上経過していれば自動同期
      const elapsed = Date.now() - (status.last_sync ?? 0)
      if (justConnected || elapsed >= SYNC_INTERVAL) await syncNow()
    })()
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
        console.error('[withings] auth URL取得失敗:', data.error)
      }
    } catch (e) {
      console.error('[withings] /api/withings-auth fetch エラー:', e)
    }
  }, [])

  // ── disconnect: サーバー側（Redis）のトークンを削除 ─────────────────────────
  const disconnect = useCallback(async () => {
    try {
      await fetch('/api/withings-data?action=disconnect', { method: 'POST' })
    } catch (e) {
      console.error('[withings] disconnect error:', e)
    }
    lsRemove(LEGACY_TOKEN_KEY, LEGACY_SYNC_KEY, MIGRATED_KEY)
    setIsConnected(false)
    setSyncStatus('idle')
    setSyncError(null)
    setLastSyncMs(0)
  }, [])

  return {
    isConnected,
    syncStatus,
    syncError,
    lastSyncLabel,
    connect,
    disconnect,
    syncNow,
    refreshStatus: fetchStatus,
  }
}
