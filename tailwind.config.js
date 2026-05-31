/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg:          '#F0F2F5',   // ライトグレー背景
        surface:     '#FFFFFF',   // ホワイトサーフェス（ヘッダー・ナビ）
        card:        '#FFFFFF',   // ホワイトカード
        foreground:  '#1A1A1A',  // メインテキスト（ダークグレー）
        accent:      '#0EA5E9',  // スカイブルー（白背景で視認性◎）
        accentDark:  '#0284C7',
        accentGreen: '#16A34A',  // グリーン（白背景対応）
        accentPurple:'#9333EA',  // パープル
        accentOrange:'#EA580C',  // オレンジ
        muted:       '#6B7280',  // グレーテキスト
        border:      '#E5E7EB',  // ライトボーダー
      },
      boxShadow: {
        card: '0 1px 3px 0 rgb(0 0 0 / 0.08), 0 1px 2px -1px rgb(0 0 0 / 0.06)',
      },
    },
  },
  plugins: [],
}
