import type { CachetteApi } from "@/shared/types";

declare global {
  interface Window {
    cachette?: CachetteApi;
  }
}

export {};
