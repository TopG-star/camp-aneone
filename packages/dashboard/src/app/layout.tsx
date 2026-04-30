import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { DashboardShell } from "@/components/layout/dashboard-shell";
import { Providers } from "@/components/providers";
import { THEME_STORAGE_KEY } from "@/lib/theme-utils";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

const themeInitScript = `(() => {
  try {
    const storedMode = localStorage.getItem("${THEME_STORAGE_KEY}");
    const mode = storedMode === "light" || storedMode === "dark" || storedMode === "system"
      ? storedMode
      : "system";
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const resolved = mode === "system" ? (prefersDark ? "dark" : "light") : mode;
    document.documentElement.classList.toggle("dark", resolved === "dark");
    document.documentElement.setAttribute("data-theme-mode", resolved);
  } catch {
    document.documentElement.classList.add("dark");
  }
})();`;

export const metadata: Metadata = {
  title: "Oneon",
  description: "Your personal AI agent dashboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className={`${inter.variable} font-sans`}>
        <Providers>
          <DashboardShell>{children}</DashboardShell>
        </Providers>
      </body>
    </html>
  );
}
