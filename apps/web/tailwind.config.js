/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Tailwind consumes the CSS custom properties rather than redefining the palette, so the
      // light/dark swap costs no re-render and there is exactly ONE source of truth for colour.
      colors: {
        paper: 'var(--paper)',
        'paper-deep': 'var(--paper-deep)',
        sheet: 'var(--sheet)',
        'sheet-2': 'var(--sheet-2)',
        'sheet-edge': 'var(--sheet-edge)',
        ink: 'var(--ink)',
        'ink-2': 'var(--ink-2)',
        'ink-3': 'var(--ink-3)',
        'ink-4': 'var(--ink-4)',
        hair: 'var(--hair)',
        'hair-soft': 'var(--hair-soft)',
        emerald: {
          50: 'var(--emerald-50)',
          100: 'var(--emerald-100)',
          200: 'var(--emerald-200)',
          400: 'var(--emerald-400)',
          600: 'var(--emerald-600)',
          700: 'var(--emerald-700)',
          900: 'var(--emerald-900)',
        },
        short: 'var(--short)',
        'short-bg': 'var(--short-bg)',
        'short-edge': 'var(--short-edge)',
        watch: 'var(--watch)',
        'watch-bg': 'var(--watch-bg)',
        'watch-edge': 'var(--watch-edge)',
        info: 'var(--info)',
        'info-bg': 'var(--info-bg)',
        'info-edge': 'var(--info-edge)',
      },
      fontFamily: {
        serif: 'var(--serif)',
        sans: 'var(--sans)',
        mono: 'var(--mono)',
      },
      borderRadius: {
        sharp: 'var(--r-sharp)',
        soft: 'var(--r-soft)',
        card: 'var(--r-card)',
      },
    },
  },
  plugins: [],
};
