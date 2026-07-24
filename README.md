# Cachette Vault Starter

Secure local desktop application starter using Electron, Next.js, React, and SQLite.

## File Structure

```txt
src/
  app/                 Next.js App Router entry and global styling
  components/          React vault UI, detail panes, add/edit modal
  data/schema.sql      SQLite schema example
  electron/            Main process, preload bridge, SQLite, crypto, backups
  shared/              Shared item and API types
```

## Run

```bash
npm install
npm run dev
```

The renderer runs in Next.js. Electron loads it through `ELECTRON_RENDERER_URL` in development and loads the static export from `out/` in production builds.

## Security Model

- The master password is never stored.
- PBKDF2-SHA512 derives a 256-bit key from the password and a per-vault salt.
- Sensitive payloads are encrypted with AES-256-GCM before they are written to SQLite.
- The derived key stays in the Electron main process memory and is cleared on lock.
- The preload script exposes a small typed API; the React app has no direct Node.js access.
- `keytar` is included as an optional dependency for OS secure storage experiments.

This is starter code, not a completed security audit. Before production, add threat modeling, dependency review, memory-handling review, signing/notarization, CSP hardening, and automated tests.
