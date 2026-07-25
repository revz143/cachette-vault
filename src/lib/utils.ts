import type { PickedFile } from "@/shared/types";

export function normalizeTagName(name: string): string {
  return name.trim().replace(/^#/, "").toLowerCase();
}

export function parseTags(text: string): string[] {
  return text.split(",").map(normalizeTagName).filter(Boolean);
}

export function deriveRepoTitle(value: string): string {
  const trimmed = value.trim().replace(/[\\\/]+$/, "");
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    return url.pathname.split("/").filter(Boolean).pop()?.replace(/\.git$/i, "") ?? url.hostname;
  } catch {
    return trimmed.split(/[\\\/]/).filter(Boolean).pop() ?? trimmed;
  }
}

export function getErrorMessage(error: unknown, fallback = "Something went wrong."): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function validateConfirmedPassword(password: string, confirmation: string): string {
  if (password.length < 8) return "Use at least 8 characters.";
  if (password !== confirmation) return "Passwords do not match.";
  return "";
}

export function extractDroppedFiles(files: FileList | File[] | null | undefined): PickedFile[] {
  return Array.from(files ?? [])
    .map((file) => {
      const fileWithPath = file as File & { path?: string };
      return fileWithPath.path ? { path: fileWithPath.path, name: file.name } : undefined;
    })
    .filter((file): file is PickedFile => Boolean(file));
}
