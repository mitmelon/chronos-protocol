/** @type {import('tailwindcss').Config} */
module.exports = {
  // Scan all EJS views and client-side JS for class names
  content: [
    './src/views/**/*.ejs',
    './public/js/**/*.js',
  ],
  theme: {
    extend: {
      fontFamily: {
        display: ['Space Grotesk', 'system-ui', 'sans-serif'],
        body:    ['DM Sans', 'system-ui', 'sans-serif'],
        mono:    ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      colors: {
        bg:         '#0c0f1a',
        surface:    '#111827',
        'surface-2':'#1a2035',
        border:     '#1e2d40',
        ink:        '#e8eaf2',
        subtle:     '#8b9ab4',
        accent:     '#4f8ef7',
        'accent-dim':'#1e3a6e',
        success:    '#22d3a6',
        danger:     '#f76c6c',
        warning:    '#f5c542',
      },
      borderRadius: {
        DEFAULT: '10px',
        lg:      '16px',
      },
    },
  },
  plugins: [],
};
