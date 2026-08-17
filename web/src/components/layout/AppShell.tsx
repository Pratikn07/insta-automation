import { Outlet, useLocation } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useState } from "react";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { mobileNavigationOpen } from "./mobileNavigationState";
import { titleForPath } from "@/lib/navigation";

export function AppShell() {
  const loc = useLocation();
  const [mobileOpenedForPath, setMobileOpenedForPath] = useState<string | null>(null);
  const mobileOpen = mobileNavigationOpen(mobileOpenedForPath, loc.pathname);
  // Honoured throughout rather than declared once: every entrance below collapses
  // to a plain cut when the OS asks for reduced motion. The previous shell animated
  // unconditionally, which is a vestibular hazard on a tool opened many times a day.
  const still = useReducedMotion();

  return (
    <div className="flex h-full">
      <div className="hidden md:flex">
        <Sidebar />
      </div>

      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              key="backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: still ? 0 : 0.18 }}
              className="fixed inset-0 z-40 bg-foreground/25 md:hidden"
              onClick={() => setMobileOpenedForPath(null)}
            />
            <motion.div
              key="drawer"
              initial={{ x: still ? 0 : "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: still ? 0 : "-100%" }}
              transition={{ type: "tween", duration: still ? 0 : 0.28, ease: [0.19, 1, 0.22, 1] }}
              className="fixed inset-y-0 left-0 z-50 md:hidden"
            >
              <Sidebar onNavigate={() => setMobileOpenedForPath(null)} />
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          title={titleForPath(loc.pathname)}
          onMenuClick={() => setMobileOpenedForPath(loc.pathname)}
        />
        <main className="flex-1 overflow-y-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={loc.pathname}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: still ? 0 : 0.18, ease: "easeOut" }}
              className="mx-auto max-w-6xl px-5 py-8 sm:px-10 sm:py-10"
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}
