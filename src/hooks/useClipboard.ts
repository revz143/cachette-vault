"use client";

import { useCallback, useEffect, useRef } from "react";
import type { CachetteApi } from "@/shared/types";
import { getErrorMessage } from "@/lib/utils";

type CopyOptions = {
  message?: string;
  /** Overwrite the clipboard with an empty string after this many milliseconds. */
  clearAfterMs?: number;
};

export function useClipboard(api: CachetteApi | null, onToast?: (message: string) => void) {
  const clearTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (clearTimer.current) window.clearTimeout(clearTimer.current);
    };
  }, []);

  return useCallback(
    async (text: string, options: CopyOptions = {}) => {
      if (!text) return;
      try {
        if (api) {
          await api.copyText(text);
        } else {
          await navigator.clipboard?.writeText(text);
        }
      } catch (error) {
        try {
          await navigator.clipboard?.writeText(text);
        } catch {
          onToast?.(getErrorMessage(error, "Could not copy to clipboard."));
          return;
        }
      }

      if (options.clearAfterMs) {
        if (clearTimer.current) window.clearTimeout(clearTimer.current);
        clearTimer.current = window.setTimeout(() => {
          void (api ? api.copyText("") : navigator.clipboard?.writeText(""));
        }, options.clearAfterMs);
      }
      if (options.message) onToast?.(options.message);
    },
    [api, onToast]
  );
}
