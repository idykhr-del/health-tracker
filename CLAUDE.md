# 総合健康トラッカー — Claude 作業ルール

## コード変更後の必須手順

**ファイルを編集・作成・削除したら、必ず以下を自動実行すること。**
ユーザーに確認を取らず、変更完了のたびに即座に実行する。

```bash
git add -A
git commit -m "<適切なコミットメッセージ>"
git push origin main
```

### コミットメッセージの形式
- 新機能追加: `feat: <内容>`
- バグ修正: `fix: <内容>`
- リファクタリング: `refactor: <内容>`
- デバッグ/ログ追加: `debug: <内容>`
- 設定変更: `chore: <内容>`

例:
- `feat: Withings 体組成10項目対応・1年分ページネーション取得`
- `fix: URLSearchParams コンマエンコード問題を修正`
- `debug: withings-data API シンプル疎通確認版に差し替え`

## プロジェクト概要

- **フレームワーク**: React 18 + TypeScript + Vite + Tailwind CSS
- **デプロイ先**: Vercel (`git push` → 自動デプロイ)
- **API**: `/api/*.ts` — Vercel Serverless Functions (Node.js)
- **外部連携**: Withings API (体組成), AutoSleep (睡眠), WorkoutDB (筋トレ)

## 主要ファイル

| パス | 役割 |
|------|------|
| `src/App.tsx` | ルートコンポーネント・タブ管理 |
| `src/tabs/Dashboard.tsx` | ダッシュボード画面 |
| `src/tabs/Charts.tsx` | グラフ画面 |
| `src/tabs/Settings.tsx` | 設定・デバッグパネル |
| `src/hooks/useWithingsStore.ts` | Withings OAuth・データ取得 |
| `api/withings-callback.ts` | OAuth コールバック処理 |
| `api/withings-data.ts` | 体組成データ取得 API |
| `scripts/merge-dist.mjs` | dist マージスクリプト |

## 注意事項

- `node_modules/`, `dist/`, `.env` はコミット対象外（`.gitignore` 設定済み）
- 環境変数 (`WITHINGS_CLIENT_ID` 等) は Vercel ダッシュボードで管理
- iOS PWA での動作確認が重要（Service Worker の挙動に注意）
