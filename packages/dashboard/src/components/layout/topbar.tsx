"use client";

import { Bell, Settings, LogOut } from "lucide-react";
import Link from "next/link";
import { useSession, signOut } from "next-auth/react";
import { CycleStatusBar } from "@/components/cycle-status-bar";

export function Topbar() {
  const { data: session } = useSession();

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b-0 bg-surface/80 px-8 backdrop-blur-glass dark:bg-dark-surface/80">
      <CycleStatusBar />

      <div className="flex items-center gap-4">
        {session?.user?.email && (
          <span className="text-label-sm text-on-surface-variant dark:text-dark-on-surface-variant">
            {session.user.email}
          </span>
        )}
        <Link
          href="/notifications"
          className="rounded-eight p-2 text-on-surface-variant transition-colors hover:bg-surface-low hover:text-on-surface dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-low dark:hover:text-dark-on-surface"
        >
          <Bell className="h-5 w-5" />
        </Link>
        <Link
          href="/settings"
          className="rounded-eight p-2 text-on-surface-variant transition-colors hover:bg-surface-low hover:text-on-surface dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-low dark:hover:text-dark-on-surface"
        >
          <Settings className="h-5 w-5" />
        </Link>
        {session && (
          <button
            onClick={() => signOut({ callbackUrl: "/auth/signin" })}
            className="rounded-eight p-2 text-on-surface-variant transition-colors hover:bg-surface-low hover:text-on-surface dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-low dark:hover:text-dark-on-surface"
            title="Sign out"
          >
            <LogOut className="h-5 w-5" />
          </button>
        )}
      </div>
    </header>
  );
}
