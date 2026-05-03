/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg:          '#0f0f1a',
        surface:     '#1a1a2e',
        card:        '#16213e',
        accent:      '#00d4ff',
        accentDark:  '#0099bb',
        accentGreen: '#39ff14',
        accentPurple:'#a855f7',
        accentOrange:'#f97316',
        muted:       '#8892a4',
        border:      '#2a2a4a',
      },
    },
  },
  plugins: [],
}
