import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cachette Vault",
  description: "Local encrypted vault starter for notes, links, repos, images, and secrets."
};

// Next.js static export relies on inline bootstrap scripts, so 'unsafe-inline'
// stays; the CSP still blocks every remote script, style, image, and request.
// Next dev mode additionally needs 'unsafe-eval' for HMR/source maps.
const isDev = process.env.NODE_ENV === "development";
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws://localhost:*",
  "object-src 'none'",
  "base-uri 'none'"
].join("; ");

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta httpEquiv="Content-Security-Policy" content={CSP} />
      </head>
      <body>{children}</body>
    </html>
  );
}
