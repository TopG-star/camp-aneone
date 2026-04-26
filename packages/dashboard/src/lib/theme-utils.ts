export type ThemeMode = "light" | "dark" | "system";
export type ResolvedThemeMode = "light" | "dark";

export const THEME_STORAGE_KEY = "oneon-theme";

const VALID_THEME_MODES: ThemeMode[] = ["light", "dark", "system"];

function isThemeMode(value: string): value is ThemeMode {
  return VALID_THEME_MODES.includes(value as ThemeMode);
}

export function normalizeThemeMode(value: string | null | undefined): ThemeMode {
  if (!value) {
    return "system";
  }

  return isThemeMode(value) ? value : "system";
}

export function resolveThemeMode(mode: ThemeMode, prefersDark: boolean): ResolvedThemeMode {
  if (mode === "system") {
    return prefersDark ? "dark" : "light";
  }

  return mode;
}

export function nextQuickToggleMode(currentResolvedMode: ResolvedThemeMode): ThemeMode {
  return currentResolvedMode === "dark" ? "light" : "dark";
}

export function readStoredThemeMode(storage: Storage | null | undefined): ThemeMode {
  if (!storage) {
    return "system";
  }

  try {
    return normalizeThemeMode(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export function persistThemeMode(storage: Storage | null | undefined, mode: ThemeMode): void {
  if (!storage) {
    return;
  }

  try {
    storage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Ignore storage quota and privacy mode errors.
  }
}
