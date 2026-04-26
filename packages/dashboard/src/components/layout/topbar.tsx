"use client";

import { Bell, Settings, LogOut, Moon, Sun, PanelLeft } from "lucide-react";
import Link from "next/link";
import { useSession, signOut } from "next-auth/react";
import { CycleStatusBar } from "@/components/cycle-status-bar";
import { useThemeMode } from "@/components/theme-provider";

interface TopbarProps {
  onOpenNav?: () => void;
}

export function Topbar({ onOpenNav }: TopbarProps) {
  const { data: session } = useSession();
  const { mode, resolvedMode, toggleMode } = useThemeMode();
  const nextMode = resolvedMode === "dark" ? "light" : "dark";

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b-0 bg-surface/75 px-3 sm:px-4 md:px-6 lg:px-8 backdrop-blur-glass dark:bg-dark-surface/75">
      <div className="flex min-w-0 items-center gap-2">
        <button
          onClick={onOpenNav}
          className="rounded-eight p-2 text-on-surface-variant transition-colors hover:bg-surface-low hover:text-on-surface md:hidden dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-low dark:hover:text-dark-on-surface"
          aria-label="Open navigation"
        >
          <PanelLeft className="h-5 w-5" />
        </button>
        <CycleStatusBar />
      </div>

      <div className="flex items-center gap-1.5 sm:gap-3 md:gap-4">
        {session?.user?.email && (
          <span className="hidden text-label-sm meta-copy lg:block">
            {session.user.email}
          </span>
        )}
        <button
          onClick={toggleMode}
          className="rounded-eight p-2 text-on-surface-variant transition-colors hover:bg-surface-low hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-low dark:hover:text-dark-on-surface dark:focus-visible:ring-dark-primary/45 dark:focus-visible:ring-offset-dark-surface"
          title={`Switch to ${nextMode} mode${mode === "system" ? " (system mode currently active)" : ""}`}
          aria-label={`Switch to ${nextMode} mode`}
        >
          {resolvedMode === "dark" ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
        </button>
        <Link
          href="/notifications"
          className="rounded-eight p-2 text-on-surface-variant transition-colors hover:bg-surface-low hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-low dark:hover:text-dark-on-surface dark:focus-visible:ring-dark-primary/45 dark:focus-visible:ring-offset-dark-surface"
        >
          <Bell className="h-5 w-5" />
        </Link>
        <Link
          href="/settings"
          className="rounded-eight p-2 text-on-surface-variant transition-colors hover:bg-surface-low hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-low dark:hover:text-dark-on-surface dark:focus-visible:ring-dark-primary/45 dark:focus-visible:ring-offset-dark-surface"
        >
          <Settings className="h-5 w-5" />
        </Link>
        {session && (
          <button
            onClick={() => signOut({ callbackUrl: "/auth/signin" })}
            className="rounded-eight p-2 text-on-surface-variant transition-colors hover:bg-surface-low hover:text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-low dark:hover:text-dark-on-surface dark:focus-visible:ring-dark-primary/45 dark:focus-visible:ring-offset-dark-surface"
            title="Sign out"
          >
            <LogOut className="h-5 w-5" />
          </button>
        )}
      </div>
    </header>
  );
}
