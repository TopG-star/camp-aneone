"use client";

import { useEffect } from "react";
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
  X,
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

interface SidebarProps {
  mobileOpen?: boolean;
  onClose?: () => void;
}

export function Sidebar({ mobileOpen = false, onClose }: SidebarProps) {
  const pathname = usePathname();

  useEffect(() => {
    onClose?.();
  }, [pathname, onClose]);

  return (
    <>
      <button
        aria-label="Close navigation overlay"
        title="Close navigation"
        tabIndex={mobileOpen ? 0 : -1}
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-30 bg-black/40 backdrop-blur-[1px] transition-opacity md:hidden",
          mobileOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        <span className="sr-only">Close navigation overlay</span>
      </button>

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-[18rem] max-w-[88vw] flex-col border-r border-outline-variant/25 bg-surface-low/95 backdrop-blur-glass transition-transform duration-300 ease-out md:z-30 md:w-56 md:max-w-none md:translate-x-0 dark:border-dark-outline-variant/30 dark:bg-dark-surface-low/95",
          mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
        )}
      >
        {/* Logo */}
        <div className="flex h-16 items-center justify-between px-6">
          <Link href="/today" className="flex items-center gap-2">
            <span className="text-xl font-bold tracking-tight text-on-surface dark:text-dark-on-surface">
              ONEON
            </span>
          </Link>

          <button
            onClick={onClose}
            className="rounded-eight p-2 text-on-surface-variant transition-colors hover:bg-surface hover:text-on-surface md:hidden dark:text-dark-on-surface-variant dark:hover:bg-dark-surface dark:hover:text-dark-on-surface"
            aria-label="Close navigation"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Primary nav */}
        <nav className="flex-1 space-y-1 px-3 pt-4">
          {navItems.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(href + "/");
            return (
              <Link
                key={href}
                href={href}
                title={label}
                onClick={onClose}
                className={cn(
                  "flex items-center gap-3 rounded-eight px-3 py-2.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-surface-lowest text-on-surface shadow-ambient dark:bg-dark-surface-container dark:text-dark-on-surface"
                    : "text-on-surface-variant hover:bg-surface hover:text-on-surface dark:text-dark-on-surface-variant dark:hover:bg-dark-surface dark:hover:text-dark-on-surface",
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{label}</span>
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
    </>
  );
}
