/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#ecfdf7",
          100: "#d1fae9",
          300: "#6ee7c2",
          400: "#34d399",
          500: "#10a37f",
          600: "#0d8f70",
          700: "#0b755d",
        },
      },
    },
  },
  plugins: [],
};
