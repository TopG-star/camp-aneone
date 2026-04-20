import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
      colors: {
        /* ── Light ("Silent Orchestrator") ─────────────── */
        surface: {
          DEFAULT: "#f9f9f9",
          low: "#f3f3f3",
          lowest: "#ffffff",
          high: "#e8e8e8",
          highest: "#e2e2e2",
          bright: "#d5d4d4",
        },
        on: {
          surface: "#1a1c1c",
          "surface-variant": "#474747",
        },
        primary: {
          DEFAULT: "#000000",
          container: "#3b3b3b",
        },
        "on-primary": "#e2e2e2",
        outline: {
          DEFAULT: "#787878",
          variant: "#c6c6c6",
        },
        /* ── Dark ("Digital Curator") ──────────────────── */
        dark: {
          surface: {
            DEFAULT: "#131313",
            low: "#1b1b1b",
            lowest: "#0e0e0e",
            container: "#1f1f1f",
            high: "#2a2a2a",
            highest: "#353535",
          },
          on: {
            surface: "#e2e2e2",
            "surface-variant": "#c6c6c6",
          },
          primary: {
            DEFAULT: "#ffffff",
            container: "#3b3b3b",
          },
          "on-primary": "#1a1c1c",
          outline: {
            DEFAULT: "#787878",
            variant: "#474747",
          },
          bright: "#393939",
        },
      },
      borderRadius: {
        eight: "0.5rem",
        xl: "1.5rem",
      },
      spacing: {
        18: "4.5rem",
        88: "22rem",
      },
      boxShadow: {
        ambient: "0 20px 40px rgba(0, 0, 0, 0.06)",
        "ambient-dark": "0 20px 40px rgba(0, 0, 0, 0.4)",
      },
      backdropBlur: {
        glass: "20px",
      },
      letterSpacing: {
        display: "-0.02em",
      },
      fontSize: {
        "display-lg": ["3.5rem", { lineHeight: "1.1", letterSpacing: "-0.02em" }],
        "display-md": ["2.5rem", { lineHeight: "1.15", letterSpacing: "-0.02em" }],
        "title-md": ["1.125rem", { lineHeight: "1.4" }],
        "label-md": ["0.75rem", { lineHeight: "1.2", letterSpacing: "0.05em" }],
        "label-sm": ["0.6875rem", { lineHeight: "1.2", letterSpacing: "0.05em" }],
      },
    },
  },
  plugins: [typography],
};

export default config;
