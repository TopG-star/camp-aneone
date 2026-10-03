"use client";

import { useCallback, useEffect, useState } from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const openMobileNav = useCallback(() => {
    setMobileNavOpen(true);
  }, []);

  const closeMobileNav = useCallback(() => {
    setMobileNavOpen(false);
  }, []);

  useEffect(() => {
    if (!mobileNavOpen) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileNavOpen(false);
      }
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleEscape);
    };
  }, [mobileNavOpen]);

  return (
    <div className="flex min-h-screen">
      <Sidebar mobileOpen={mobileNavOpen} onClose={closeMobileNav} />

      <div className="flex min-w-0 flex-1 flex-col md:pl-56">
        <Topbar onOpenNav={openMobileNav} />
        <main className="flex-1 px-4 py-4 sm:py-5 md:px-6 md:py-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
