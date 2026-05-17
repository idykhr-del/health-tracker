import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  // サブパス /workout/ 以下で配信するためのベースパス設定
  base: '/workout/',

  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',

      // Pre-cache all built assets
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,ico,woff2}'],

        // index.html → NetworkFirst (最新版を優先、失敗時はキャッシュ)
        navigateFallback: 'index.html',
        navigationPreload: false,

        runtimeCaching: [
          {
            // Navigation (HTML) → NetworkFirst
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'html-cache',
              networkTimeoutSeconds: 3,
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // JS / CSS assets → CacheFirst (immutable after build hash)
            urlPattern: /\.(?:js|css)$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'assets-cache',
              expiration: {
                maxEntries: 30,
                maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Images / fonts → CacheFirst
            urlPattern: /\.(?:svg|png|ico|woff2)$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'static-cache',
              expiration: {
                maxEntries: 20,
                maxAgeSeconds: 365 * 24 * 60 * 60, // 1 year
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },

      manifest: {
        name: '筋トレトラッカー',
        short_name: '筋トレ',
        description: 'ワークアウトを記録・分析するアプリ',
        theme_color: '#0f0f1a',
        background_color: '#0f0f1a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/workout/',
        scope: '/workout/',
        icons: [
          {
            src: '/icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any',
          },
          {
            src: '/icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'maskable',
          },
        ],
      },
    }),
  ],
  server: {
    host: true,
    port: process.env.PORT ? parseInt(process.env.PORT) : 5175,
  },
})
