/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#EEF0FF',
          100: '#E0E3FF',
          200: '#C7CCFF',
          300: '#A5A8FF',
          400: '#8386FF',
          500: '#6F6FFF',
          600: '#4B3FE3',
          700: '#3C2ECA',
          800: '#2D22A0',
          900: '#1A1759',
        },
      },
      fontFamily: {
        sans: ['"SF Pro Text"', '"PingFang SC"', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"SF Mono"', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        'soft': '0 2px 8px -2px rgba(0, 0, 0, 0.08), 0 4px 16px -4px rgba(0, 0, 0, 0.04)',
        'card': '0 4px 12px -2px rgba(0, 0, 0, 0.08), 0 8px 24px -8px rgba(0, 0, 0, 0.06)',
        'card-hover': '0 8px 24px -4px rgba(75, 63, 227, 0.18), 0 12px 32px -8px rgba(0, 0, 0, 0.1)',
        'brand': '0 4px 14px 0 rgba(75, 63, 227, 0.25)',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'scale-in': {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        'slide-in-right': {
          '0%': { opacity: '0', transform: 'translateX(20px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        'toast-in': {
          '0%': { opacity: '0', transform: 'translateY(-12px) scale(0.96)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'shimmer': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        'spin-fast': {
          '0%': { transform: 'rotate(0deg)' },
          '100%': { transform: 'rotate(360deg)' },
        },
        'bounce-in': {
          '0%': { opacity: '0', transform: 'scale(0.3)' },
          '50%': { opacity: '1', transform: 'scale(1.05)' },
          '70%': { transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.3s ease-out',
        'fade-in-up': 'fade-in-up 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
        'scale-in': 'scale-in 0.2s ease-out',
        'slide-in-right': 'slide-in-right 0.3s ease-out',
        'toast-in': 'toast-in 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
        'shimmer': 'shimmer 1.5s infinite linear',
        'spin-fast': 'spin-fast 0.6s linear infinite',
        'bounce-in': 'bounce-in 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
      },
      transitionTimingFunction: {
        'out-back': 'cubic-bezier(0.16, 1, 0.3, 1)',
        'spring': 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
    },
  },
  plugins: [],
}
