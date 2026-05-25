import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// ── Service Worker 自動更新 ────────────────────────────────────────────────────
// workbox の skipWaiting + clientsClaim により、新しい SW が activate すると
// navigator.serviceWorker.controller が切り替わり controllerchange イベントが発火する。
// このタイミングでリロードすることで、デプロイ直後の次回起動時に最新版が確実に適用される。
if ('serviceWorker' in navigator) {
  // ページ読み込み時点で既に SW が制御中かどうかを記録する
  // （初回インストール時の不要なリロードを防ぐ）
  const hadController = Boolean(navigator.serviceWorker.controller)
  let reloading = false

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // 初回インストール（hadController=false）はスキップ
    if (!hadController || reloading) return
    reloading = true
    console.log('[SW] 新バージョン検出 → 自動リロード')
    window.location.reload()
  })

  // アプリがフォアグラウンドに戻ったとき SW の更新チェックを実行
  // （長時間バックグラウンドにいた後の起動でも最新版を取得できる）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    navigator.serviceWorker.ready
      .then(reg => reg.update())
      .catch(() => { /* ignore network errors */ })
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
