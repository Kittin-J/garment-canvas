/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0A0A0A",
        paper: "#FAFAF8",
        gold: "#C9A66B",
        golddeep: "#896932",
      },
    },
  },
  plugins: [],
};
