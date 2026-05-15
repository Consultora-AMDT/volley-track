/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          green: '#007E59',
          'green-dark': '#006048',
          'green-light': '#4EB05D',
          'green-soft': '#E5F4ED',
          blue: '#0E83C6',
          'blue-dark': '#0966A1',
          'blue-soft': '#E5F1FA',
        },
      },
      boxShadow: {
        card: '0 1px 2px rgba(15,23,42,0.04), 0 4px 12px rgba(15,23,42,0.04)',
        'card-md': '0 2px 4px rgba(15,23,42,0.06), 0 8px 24px rgba(15,23,42,0.06)',
        'card-lg': '0 4px 8px rgba(15,23,42,0.08), 0 16px 32px rgba(15,23,42,0.08)',
      },
    },
  },
  plugins: [],
};
