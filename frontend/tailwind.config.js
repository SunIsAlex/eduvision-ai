/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Claude-style warm palette: cream page, terracotta accent
        brand: {
          50: "#fbeee8",
          100: "#f6dcd0",
          300: "#e9a986",
          400: "#e08b62",
          500: "#d97757",
          600: "#c15f3c",
          700: "#9a4a2f",
        },
        cream: "#f0eee6", // page background
        card: "#faf9f6", // raised warm surface
        line: "#e4e0d4", // hairline borders
        ink: "#26251f", // primary text
        mute: "#6b675c", // secondary text
        faint: "#9c978b", // tertiary text / placeholders
        bubble: "#eae6dc", // user message bubble
      },
    },
  },
  plugins: [],
};
