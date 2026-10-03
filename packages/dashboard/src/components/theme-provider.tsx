"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  nextQuickToggleMode,
  persistThemeMode,
  readStoredThemeMode,
  resolveThemeMode,
  type ResolvedThemeMode,
  type ThemeMode,
} from "@/lib/theme-utils";

interface ThemeContextValue {
  mode: ThemeMode;
  resolvedMode: ResolvedThemeMode;
  setMode: (nextMode: ThemeMode) => void;
  toggleMode: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const THEME_MEDIA_QUERY = "(prefers-color-scheme: dark)";

function readSystemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return true;
  }

  return window.matchMedia(THEME_MEDIA_QUERY).matches;
}

function applyResolvedTheme(resolvedMode: ResolvedThemeMode): void {
  if (typeof document === "undefined") {
    return;
  }

  const root = document.documentElement;
  root.classList.toggle("dark", resolvedMode === "dark");
  root.setAttribute("data-theme-mode", resolvedMode);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Start from the same values the server renders with, then read the browser's saved choice
  // after hydration; reading it during render made the server and client HTML differ.
  const [mode, setMode] = useState<ThemeMode>("system");
  const [prefersDark, setPrefersDark] = useState<boolean>(true);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setMode(readStoredThemeMode(window.localStorage));
    setHydrated(true);
  }, []);

  const resolvedMode = resolveThemeMode(mode, prefersDark);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQueryList = window.matchMedia(THEME_MEDIA_QUERY);
    const handleSystemThemeChange = (event: MediaQueryListEvent) => {
      setPrefersDark(event.matches);
    };

    setPrefersDark(mediaQueryList.matches);

    if (typeof mediaQueryList.addEventListener === "function") {
      mediaQueryList.addEventListener("change", handleSystemThemeChange);
      return () => {
        mediaQueryList.removeEventListener("change", handleSystemThemeChange);
      };
    }

    mediaQueryList.addListener(handleSystemThemeChange);
    return () => {
      mediaQueryList.removeListener(handleSystemThemeChange);
    };
  }, []);

  useEffect(() => {
    // Before hydration the layout's inline script has already applied the saved theme; don't
    // overwrite it (or the saved choice) with the server's "system" default.
    if (!hydrated) return;
    applyResolvedTheme(resolvedMode);
    persistThemeMode(window.localStorage, mode);
  }, [hydrated, mode, resolvedMode]);

  const toggleMode = useCallback(() => {
    setMode((currentMode) => {
      const nextResolved = resolveThemeMode(currentMode, readSystemPrefersDark());
      return nextQuickToggleMode(nextResolved);
    });
  }, []);

  const value = useMemo(
    () => ({ mode, resolvedMode, setMode, toggleMode }),
    [mode, resolvedMode, toggleMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useThemeMode(): ThemeContextValue {
  const value = useContext(ThemeContext);

  if (!value) {
    throw new Error("useThemeMode must be used within ThemeProvider");
  }

  return value;
}
