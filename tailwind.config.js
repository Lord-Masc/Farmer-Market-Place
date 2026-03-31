/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'green-deep': '#1a3a2a',
        'green-mid': '#2d6a4f',
        'green-fresh': '#52b788',
        'amber': '#e9a84c',
        'amber-light': '#f4c87a',
        'cream': '#fdf6ec',
        'cream-dark': '#f0e8d5',
        'soil': '#7a4f2e',
        'footer-dark': '#111d17',
      },
      fontFamily: {
        playfair: ['"Playfair Display"', 'serif'],
        dmsans: ['"DM Sans"', 'sans-serif'],
      },
      opacity: {
        '12': '0.12',
        '15': '0.15',
        '55': '0.55',
        '65': '0.65',
        '85': '0.85',
        '92': '0.92',
      },
      keyframes: {
        slideDown: {
          '0%': { transform: 'translateY(-100%)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        fadeUp: {
          '0%': { transform: 'translateY(24px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        fadeIn: {
          '0%': { transform: 'scale(0.95)', opacity: '0' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0) scale(1)' },
          '50%': { transform: 'translateY(-30px) scale(1.05)' },
        },
        floatCard: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-8px)' },
        },
        pulseBadge: {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.5', transform: 'scale(1.4)' },
        },
        scrollReveal: {
          '0%': { opacity: '0', transform: 'translateY(30px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        }
      },
      animation: {
        slideDown: 'slideDown 0.6s ease both',
        fadeUp: 'fadeUp 0.7s ease both',
        fadeIn: 'fadeIn 1s ease both',
        float: 'float 8s ease-in-out infinite',
        floatCard: 'floatCard 4s ease-in-out infinite',
        pulseBadge: 'pulseBadge 2s infinite',
        scrollReveal: 'scrollReveal 0.7s ease both',
      }
    },
  },
  plugins: [],
}
