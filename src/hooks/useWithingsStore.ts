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
    // ── デバッグ: 起動時のURL状態を全出力 ──────────────────────────────────
    console.log('[useWithingsStore:init] href   :', window.location.href)
    console.log('[useWithingsStore:init] search :', window.location.search)
    console.log('[useWithingsStore:init] hash   :', window.location.hash)
    console.log('[useWithingsStore:init] codeHandled:', codeHandled.current)

    if (codeHandled.current) {
      console.log('[useWithingsStore:init] skipped: codeHandled is true')
      return
    }

    // href 全体からも code を抽出（search が空のケースに備える）
    const href   = window.location.href
    const search = window.location.search

    // URLSearchParams で解析（search が空なら href から直接正規表現で抽出）
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

    console.log('[useWithingsStore:init] code  :', code ? code.slice(0, 10) + '...' : 'null')
    console.log('[useWithingsStore:init] state :', state)

    if (!code) {
      console.log('[useWithingsStore:init] no code found, skipping')
      return
    }
    // state チェック（Withings が変えてくる場合に備えて警告のみに緩和）
    if (state !== 'health-tracker') {
      console.warn('[useWithingsStore:init] unexpected state value:', state, '(continuing anyway)')
    }

    codeHandled.current = true

    // URLをすぐにクリーンアップ
    window.history.replaceState(null, '', '/')
    console.log('[useWithingsStore:init] URL cleaned. Fetching tokens...')
    setSyncStatus('syncing')

    const fetchSearch = `?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state ?? '')}`
    fetch(`/api/withings-callback${fetchSearch}`)
      .then(res => {
        console.log('[useWithingsStore:init] fetch status:', res.status)
        return res.json()
      })
      .then((data: CallbackJsonResponse) => {
        console.log('[useWithingsStore:init] response keys:', Object.keys(data).join(', '))
        // ── デバッグ: コールバックで受け取ったトークン長を確認 ───────────────
        console.log('[useWithingsStore:init] access_token  length:', data.access_token?.length  ?? 'undefined')
        console.log('[useWithingsStore:init] refresh_token length:', data.refresh_token?.length ?? 'undefined')
        console.log('[useWithingsStore:init] access_token  prefix:', data.access_token?.slice(0, 10))
        // ─────────────────────────────────────────────────────────────────────

        if (data.error || !data.access_token || !data.refresh_token || !data.userid) {
          console.error('[useWithingsStore:init] Token exchange failed:', data.error)
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

        // ── デバッグ: 保存直前の値を確認 ────────────────────────────────────
        console.log('[useWithingsStore:init] saving tokens. access_token length:', newTokens.access_token.length)
        saveTokens(newTokens)

        // ── 保存直後に読み返して確認 ─────────────────────────────────────────
        const savedRaw = localStorage.getItem(TOKEN_KEY)
        const savedParsed = savedRaw ? JSON.parse(savedRaw) as WithingsTokens : null
        console.log('[useWithingsStore:init] re-read access_token length:', savedParsed?.access_token?.length ?? 'null')

        localStorage.setItem(LAST_SYNC_KEY, '0')
        setTokens(newTokens)
        setSyncStatus('idle')
        syncedRef.current = false

        window.dispatchEvent(new CustomEvent('withings:connected'))
        console.log('[useWithingsStore:init] ✅ Tokens saved! userid:', data.userid)
      })
      .catch(e => {
        console.error('[useWithingsStore:init] Fetch error:', e)
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
