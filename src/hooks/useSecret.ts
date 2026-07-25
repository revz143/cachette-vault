"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CachetteApi } from "@/shared/types";

/**
 * Loads an item's decrypted fields on demand and drops them from state as soon
 * as the item changes or `clear()` is called. A sequence counter discards
 * responses that resolve after the item has already changed.
 */
export function useSecret(api: CachetteApi, itemId: string | null | undefined) {
  const [secret, setSecret] = useState<Record<string, string> | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    seq.current += 1;
    setSecret(null);
  }, [itemId]);

  const load = useCallback(async (): Promise<Record<string, string>> => {
    if (!itemId) return {};
    const requestSeq = ++seq.current;
    const nextSecret = await api.revealSecret(itemId);
    if (requestSeq === seq.current) {
      setSecret(nextSecret);
    }
    return nextSecret;
  }, [api, itemId]);

  const clear = useCallback(() => {
    seq.current += 1;
    setSecret(null);
  }, []);

  return { secret, load, clear };
}
