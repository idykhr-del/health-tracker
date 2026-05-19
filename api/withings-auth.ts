import type { IncomingMessage, ServerResponse } from 'http'

/**
 * GET /api/withings-auth
 * Withings OAuth2 認証URLをJSONで返す。
 *
 * 302リダイレクト方式だとiOS PWA（Standalone）が外部ドメインへの
 * リダイレクトを検知してPWAを終了させてしまうため、URLをJSONで返し
 * フロント側で window.location.href に直接セットする方式に変更。
 *
 * 環境変数:
 *   WITHINGS_CLIENT_ID
 *   WITHINGS_REDIRECT_URI
 */
export default function handler(_req: IncomingMessage, res: ServerResponse) {
  const clientId    = process.env.WITHINGS_CLIENT_ID
  const redirectUri = process.env.WITHINGS_REDIRECT_URI

  if (!clientId || !redirectUri) {
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Missing environment variables: WITHINGS_CLIENT_ID, WITHINGS_REDIRECT_URI' }))
    return
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     clientId,
    redirect_uri:  redirectUri,
    scope:         'user.metrics',
    state:         'health-tracker',
  })

  const url = `https://account.withings.com/oauth2_user/authorize2?${params.toString()}`

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ url }))
}
