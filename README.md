# Cachette Vault

Cachette Vault is a local-first desktop vault for passwords, notes, links, repository paths, screenshots, and private files. It runs as an Electron app with a Next.js/React interface and stores encrypted data locally in SQLite.

## Download

[Download Cachette Vault for Windows](https://github.com/YOUR_GITHUB_USERNAME/cachette-vault/releases/latest/download/Cachette-Vault-Setup-0.1.0.exe)

> Replace `YOUR_GITHUB_USERNAME/cachette-vault` with your GitHub repository path after publishing the project. Upload `release/Cachette-Vault-Setup-0.1.0.exe` as a GitHub Release asset so the link works.

## Features

- Local encrypted vault for passwords, notes, links, repos, images, and private entries
- AES-256-GCM encryption with PBKDF2-SHA512 key derivation
- Custom projects and tags for organizing saved items
- Markdown preview for notes
- Encrypted backup import and export
- Optional Windows Hello unlock through OS secure storage when available
- Custom desktop-style UI with dark and light themes

## Security Model

- The master password is never stored.
- PBKDF2-SHA512 derives a 256-bit key from the password and a per-vault salt.
- Sensitive payloads are encrypted with AES-256-GCM before they are written to SQLite.
- The derived key stays in Electron main-process memory and is cleared when the vault locks.
- The preload bridge exposes a small typed API; the React renderer has no direct Node.js access.
- `keytar` is optional and used only for OS secure storage support.

This project has not been independently audited. Before production use, perform threat modeling, dependency review, memory-handling review, signing/notarization, CSP hardening, and automated security testing.

## Development

```bash
npm install
npm run dev
```

The development script starts the Next.js renderer, builds the Electron main/preload files in watch mode, and launches Electron against the local renderer URL.

## Build

```bash
npm run build
npm run dist
```

The Windows installer is written to:

```txt
release/Cachette-Vault-Setup-0.1.0.exe
```

## Project Structure

```txt
src/
  app/                 Next.js App Router entry and global styles
  components/          React vault UI, detail panes, and modals
  data/schema.sql      SQLite schema
  electron/            Electron main process, preload bridge, database, crypto, backups
  shared/              Shared item and API types
assets/                Application icons and packaged assets
release/               Generated installer output
```

## Useful Scripts

```bash
npm run dev        # Start the desktop app in development
npm run build      # Build renderer and Electron process files
npm run dist       # Build the Windows installer
npm run lint       # Run ESLint
npm run typecheck  # Run TypeScript checks
```
