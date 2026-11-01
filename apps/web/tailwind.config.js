/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // A restrained, research-tool palette: deep slate surfaces with a
        // single violet accent, so status colours carry the meaning.
        surface: {
          950: '#0a0b10',
          900: '#0f1117',
          850: '#141620',
          800: '#1a1d29',
          700: '#242837',
          600: '#333848',
        },
        ink: {
          100: '#f4f5f8',
          200: '#dfe2ea',
          300: '#b9bfd0',
          400: '#8a92a8',
          500: '#646c82',
        },
        accent: {
          400: '#a78bfa',
          500: '#8b5cf6',
          600: '#7c3aed',
        },
        ok: { 400: '#4ade80', 600: '#16a34a' },
        warn: { 400: '#fbbf24', 600: '#d97706' },
        bad: { 400: '#f87171', 600: '#dc2626' },
        info: { 400: '#60a5fa', 600: '#2563eb' },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      boxShadow: {
        card: '0 1px 2px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.04)',
        lift: '0 8px 24px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.06)',
      },
      animation: {
        'fade-in': 'fadeIn 160ms ease-out',
        shimmer: 'shimmer 1.6s linear infinite',
      },
      keyframes: {
        fadeIn: { '0%': { opacity: '0', transform: 'translateY(2px)' }, '100%': { opacity: '1', transform: 'none' } },
        shimmer: { '0%': { backgroundPosition: '-800px 0' }, '100%': { backgroundPosition: '800px 0' } },
      },
    },
  },
  plugins: [],
};
