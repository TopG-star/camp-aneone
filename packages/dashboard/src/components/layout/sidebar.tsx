"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Inbox,
  Zap,
  Bell,
  Settings,
  MessageSquare,
  CalendarClock,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/today", label: "Today", icon: LayoutDashboard },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/actions", label: "Actions", icon: Zap },
  { href: "/deadlines", label: "Deadlines", icon: CalendarClock },
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/notifications", label: "Notifications", icon: Bell },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed inset-y-0 left-0 z-30 flex w-56 flex-col bg-surface-low dark:bg-dark-surface-low">
      {/* Logo */}
      <div className="flex h-16 items-center px-6">
        <Link href="/today" className="flex items-center gap-2">
          <span className="text-xl font-bold tracking-tight text-on-surface dark:text-dark-on-surface">
            ONEON
          </span>
        </Link>
      </div>

      {/* Primary nav */}
      <nav className="flex-1 space-y-1 px-3 pt-4">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 rounded-eight px-3 py-2.5 text-sm font-medium transition-colors",
                active
                  ? "bg-surface-lowest text-on-surface shadow-ambient dark:bg-dark-surface-container dark:text-dark-on-surface"
                  : "text-on-surface-variant hover:bg-surface hover:text-on-surface dark:text-dark-on-surface-variant dark:hover:bg-dark-surface dark:hover:text-dark-on-surface",
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          );
        })}

        {/* Stub items placeholder for future features */}
      </nav>

      {/* Footer */}
      <div className="px-6 py-4">
        <p className="text-label-sm text-on-surface-variant/40 dark:text-dark-on-surface-variant/40">
          v0.8.0
        </p>
      </div>
    </aside>
  );
}
