import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      workbox: {
        // ── 新SW を即時アクティブ化 ─────────────────────────────────────────
        // skipWaiting: 新SW は「waiting」を経ずすぐ activate される
        // clientsClaim: activate 直後に全ページを制御下に置く
        // → クライアント側の controllerchange イベントでリロードがかかる
        skipWaiting: true,
        clientsClaim: true,

        globPatterns: ['**/*.{js,css,html,svg,ico,woff2}'],
        navigateFallback: 'index.html',
        navigationPreload: false,

        runtimeCaching: [
          {
            // HTML ナビゲーション: ネットワーク優先（3秒でフォールバック）
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'html-cache',
              networkTimeoutSeconds: 3,
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // JS / CSS: キャッシュを即返しつつバックグラウンドで更新
            // Vite はファイル名にコンテンツハッシュを付けるため、
            // 新デプロイ後は新しいファイル名が要求され古いキャッシュは自然に無効化される
            urlPattern: /\.(?:js|css)$/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'assets-cache',
              expiration: { maxEntries: 40, maxAgeSeconds: 7 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // 静的ファイル（SVG・フォント等）: キャッシュ優先・7日TTL
            urlPattern: /\.(?:svg|png|ico|woff2)$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'static-cache',
              expiration: { maxEntries: 20, maxAgeSeconds: 7 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      manifest: {
        name: '統合ヘルストラッカー',
        short_name: '健康管理',
        description: '体組成・睡眠・筋トレを統合分析するアプリ',
        theme_color: '#0f0f1a',
        background_color: '#0f0f1a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
    }),
  ],
  server: {
    host: true,
    port: process.env.PORT ? parseInt(process.env.PORT) : 5174,
    strictPort: false,
  },
})
