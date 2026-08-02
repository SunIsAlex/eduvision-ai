/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eef4ff",
          100: "#dbe6ff",
          500: "#4f6ef7",
          600: "#3b5bf0",
          700: "#2f47c9",
        },
      },
    },
  },
  plugins: [],
};
