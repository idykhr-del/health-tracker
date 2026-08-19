import { randomUUID } from 'node:crypto'
import type { Redis } from '@upstash/redis'

/**
 * Withings トークン管理（唯一の真実の在り処 = Redis）
 *
 * 【背景】
 * Withings の refresh token はローテーション制で、1回使うと旧トークンが失効する。
 * 以前は localStorage（フロント）と Redis（サーバー）の2箇所でトークンを管理していたため、
 * 片方が refresh するともう片方の refresh token が黙って失効し、
 * 「しばらくアプリを開かないと 401 になる」という症状が出ていた。
 *
 * → トークンは Redis の `withings:tokens` のみで管理し、refresh は必ずこのモジュールを通す。
 *   ログはすべて `[withings]` プレフィックスを付けるので、
 *   Vercel ログで refresh が1経路のみから出ていることを確認できる。
 *
 * Redis キー:
 *   withings:tokens        → { access_token, refresh_token, expires_at }（TTL 90日）
 *   withings:refresh:lock  → refresh 中の排他ロック（TTL 30秒）
 *   withings:auth_error    → { reason, at }  refresh 失敗時の理由（再連携が必要）
 *   withings:sync:last     → Unix ms（最終 sync 時刻）
 */

export const TOKENS_KEY     = 'withings:tokens'
export const LOCK_KEY       = 'withings:refresh:lock'
export const AUTH_ERROR_KEY = 'withings:auth_error'
export const SYNC_LAST_KEY  = 'withings:sync:last'

export const TOKEN_TTL_SEC = 60 * 60 * 24 * 90  // 90日
const LOCK_TTL_SEC         = 30
const LOCK_WAIT_MS         = 1000
const REFRESH_MARGIN_SEC   = 300  // 残り5分を切ったら refresh

export interface WithingsTokens {
  access_token:  string
  refresh_token: string
  expires_at:    number  // Unix 秒
}

export interface WithingsAuthError {
  reason: string
  at:     number  // Unix ms
}

export type RefreshResult =
  | { ok: true;  tokens: WithingsTokens }
  | { ok: false; reason: string }

// ─────────────────────────────────────────────────────────────────────────────
// Redis 読み書き
// ─────────────────────────────────────────────────────────────────────────────

/** Upstash は JSON 文字列を自動パースすることがあるため、文字列/オブジェクト両対応で読む */
function coerce<T>(raw: unknown): T | null {
  if (raw == null) return null
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as T } catch { return null }
  }
  if (typeof raw === 'object') return raw as T
  return null
}

export async function readTokens(redis: Redis): Promise<WithingsTokens | null> {
  const tokens = coerce<WithingsTokens>(await redis.get(TOKENS_KEY))
  if (!tokens?.access_token || !tokens?.refresh_token) return null
  return {
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at:    Number(tokens.expires_at) || 0,
  }
}

export async function saveTokens(redis: Redis, tokens: WithingsTokens): Promise<void> {
  await redis.set(TOKENS_KEY, JSON.stringify({
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at:    tokens.expires_at,
  }), { ex: TOKEN_TTL_SEC })
}

export async function clearTokens(redis: Redis): Promise<void> {
  await Promise.all([
    redis.del(TOKENS_KEY),
    redis.del(AUTH_ERROR_KEY),
    redis.del(SYNC_LAST_KEY),
  ])
}

export async function readAuthError(redis: Redis): Promise<WithingsAuthError | null> {
  return coerce<WithingsAuthError>(await redis.get(AUTH_ERROR_KEY))
}

export async function readLastSync(redis: Redis): Promise<number | null> {
  const raw = await redis.get(SYNC_LAST_KEY)
  if (raw == null) return null
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10)
  return Number.isFinite(n) ? n : null
}

async function setAuthError(redis: Redis, reason: string): Promise<void> {
  await redis.set(
    AUTH_ERROR_KEY,
    JSON.stringify({ reason, at: Date.now() } satisfies WithingsAuthError),
    { ex: TOKEN_TTL_SEC },
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// アクセストークン取得（refresh はここに一本化）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 有効な access_token を返す。無効/期限切れなら refresh して Redis を更新する。
 *
 * - トークンが Redis に無い → null（未連携）
 * - refresh 失敗          → null（`withings:auth_error` を立てる。トークンは消さない）
 *
 * refresh は Redis ロックで排他する。ロックを取れなかった場合は 1秒待って
 * 再読み込みし、他プロセスが更新した access_token をそのまま使う（自分では refresh しない）。
 *
 * @param force expires_at に関係なく refresh する（API が 401 を返した場合の復旧用）
 */
export async function getValidAccessToken(
  redis: Redis,
  opts: { force?: boolean } = {},
): Promise<string | null> {
  const tokens = await readTokens(redis)
  if (!tokens) {
    console.log('[withings] no tokens in Redis (not connected)')
    return null
  }

  const nowSec = Math.floor(Date.now() / 1000)
  if (!opts.force && tokens.expires_at - nowSec > REFRESH_MARGIN_SEC) {
    return tokens.access_token
  }

  const clientId     = process.env['WITHINGS_CLIENT_ID']
  const clientSecret = process.env['WITHINGS_CLIENT_SECRET']
  if (!clientId || !clientSecret) {
    console.warn('[withings] WITHINGS_CLIENT_ID / SECRET not set — cannot refresh')
    return tokens.expires_at > nowSec ? tokens.access_token : null
  }

  // ── ロック取得 ────────────────────────────────────────────────────────────
  const lockValue = randomUUID()
  const acquired  = await redis.set(LOCK_KEY, lockValue, { nx: true, ex: LOCK_TTL_SEC })
  if (acquired !== 'OK') {
    console.log('[withings] refresh lock held by another process — waiting for its result')
    await sleep(LOCK_WAIT_MS)
    const fresh = await readTokens(redis)
    if (!fresh) {
      console.warn('[withings] tokens disappeared while waiting for lock')
      return null
    }
    const refreshedByOther = fresh.access_token !== tokens.access_token
    console.log(`[withings] using token from other process (refreshed=${refreshedByOther})`)
    return fresh.access_token
  }

  try {
    // ロック取得までの間に他プロセスが refresh 済みかもしれないので読み直す
    const latest = (await readTokens(redis)) ?? tokens
    const nowSec2 = Math.floor(Date.now() / 1000)
    if (!opts.force && latest.expires_at - nowSec2 > REFRESH_MARGIN_SEC) {
      console.log('[withings] token already refreshed by another process — skip refresh')
      return latest.access_token
    }

    console.log(`[withings] refreshing access token (force=${opts.force === true}, expires_in=${latest.expires_at - nowSec2}s)`)
    const result = await refreshWithingsToken(clientId, clientSecret, latest.refresh_token)

    if (!result.ok) {
      // トークンは消さない。再連携が必要なことだけ記録する。
      await setAuthError(redis, result.reason)
      console.error(`[withings] refresh FAILED: ${result.reason} — reauth required`)
      return null
    }

    // 使う前に必ず Redis へ書き戻す（ローテーションした refresh token を失わないため）
    await saveTokens(redis, result.tokens)
    await redis.del(AUTH_ERROR_KEY)
    console.log('[withings] refresh OK — new tokens saved to Redis')
    return result.tokens.access_token
  } finally {
    await releaseLock(redis, lockValue)
  }
}

async function releaseLock(redis: Redis, lockValue: string): Promise<void> {
  try {
    const current = await redis.get(LOCK_KEY)
    if (String(current) === lockValue) await redis.del(LOCK_KEY)
  } catch (e) {
    console.warn('[withings] lock release failed (will expire):', e)
  }
}

/** Withings の refresh_token でトークンを更新する（呼び出しは getValidAccessToken 経由のみ） */
export async function refreshWithingsToken(
  clientId:     string,
  clientSecret: string,
  refreshToken: string,
): Promise<RefreshResult> {
  try {
    const body = new URLSearchParams({
      action:        'requesttoken',
      grant_type:    'refresh_token',
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    })
    const resp = await fetch('https://wbsapi.withings.net/v2/oauth2', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
    })
    const data = await resp.json() as {
      status: number
      error?: string
      body?:  { access_token: string; refresh_token: string; expires_in: number }
    }
    if (data.status !== 0 || !data.body?.access_token) {
      return { ok: false, reason: `withings status=${data.status}${data.error ? ` (${data.error})` : ''}` }
    }
    return {
      ok: true,
      tokens: {
        access_token:  data.body.access_token,
        refresh_token: data.body.refresh_token,
        expires_at:    Math.floor(Date.now() / 1000) + (data.body.expires_in ?? 10800),
      },
    }
  } catch (e) {
    return { ok: false, reason: `network error: ${String(e)}` }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
