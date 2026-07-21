"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const MIN_VISIBLE_MS = 250;
const FALLBACK_HIDE_MS = 1800;

export function NavigationLoadingIndicator() {
  const pathname = usePathname();
  const previousPathname = useRef(pathname);
  const startedAt = useRef(0);
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    function clearTimers() {
      if (fallbackTimer.current) window.clearTimeout(fallbackTimer.current);
      if (finishTimer.current) window.clearTimeout(finishTimer.current);
      fallbackTimer.current = null;
      finishTimer.current = null;
    }

    function startLoading() {
      clearTimers();
      startedAt.current = Date.now();
      setLoading(true);
      fallbackTimer.current = window.setTimeout(() => setLoading(false), FALLBACK_HIDE_MS);
    }

    function handleDocumentClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const target = event.target;
      if (!(target instanceof Element)) return;

      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;

      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin) return;
      if (
        destination.pathname === window.location.pathname &&
        destination.search === window.location.search
      ) {
        return;
      }

      startLoading();
    }

    function handlePopState() {
      startLoading();
    }

    document.addEventListener("click", handleDocumentClick, true);
    window.addEventListener("popstate", handlePopState);

    return () => {
      document.removeEventListener("click", handleDocumentClick, true);
      window.removeEventListener("popstate", handlePopState);
      clearTimers();
    };
  }, []);

  useEffect(() => {
    if (previousPathname.current === pathname) return;
    previousPathname.current = pathname;

    const elapsed = Date.now() - startedAt.current;
    const remaining = Math.max(0, MIN_VISIBLE_MS - elapsed);

    if (fallbackTimer.current) window.clearTimeout(fallbackTimer.current);
    if (finishTimer.current) window.clearTimeout(finishTimer.current);

    finishTimer.current = window.setTimeout(() => {
      setLoading(false);
      finishTimer.current = null;
    }, remaining);
  }, [pathname]);

  return (
    <div
      aria-hidden={!loading}
      aria-label="Đang chuyển trang"
      className={`route-progress${loading ? " route-progress-active" : ""}`}
      role="progressbar"
    >
      <span className="route-progress-bar" />
    </div>
  );
}
