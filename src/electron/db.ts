import Database from "better-sqlite3";
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createVaultKdf, decryptJson, deriveKey, encryptJson, verifyKey, type VaultKdf } from "./crypto";
import type {
  AttachmentPreview,
  AttachmentRecord,
  BackupExportResult,
  ItemDraft,
  ItemFilters,
  ItemUpdate,
  VaultItem,
  VaultStatus
} from "../shared/types";

type ItemRow = {
  id: string;
  type: VaultItem["type"];
  title: string;
  content: string;
  url: string | null;
  repo_path: string | null;
  category: string;
  tags: string;
  encrypted_data: string | null;
  created_at: string;
  updated_at: string;
};

type AttachmentRow = {
  id: string;
  item_id: string;
  file_path: string;
  kind: AttachmentRecord["kind"];
  original_name: string;
  created_at: string;
};

type BackupPayload = {
  version: 1;
  exportedAt: string;
  metadata: Array<{ key: string; value: string }>;
  items: ItemRow[];
  attachments: AttachmentRow[];
  files: Array<{ filePath: string; data: string }>;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('note', 'link', 'repo', 'image', 'password', 'private')),
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  url TEXT,
  repo_path TEXT,
  category TEXT NOT NULL DEFAULT 'General',
  tags TEXT NOT NULL DEFAULT '[]',
  encrypted_data TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);
CREATE INDEX IF NOT EXISTS idx_items_updated_at ON items(updated_at);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'image', 'screenshot')),
  original_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attachments_item_id ON attachments(item_id);
`;

export class VaultDatabase {
  private readonly db: Database.Database;
  private readonly attachmentRoot: string;
  private key: Buffer | null = null;

  constructor() {
    const userData = app.getPath("userData");
    fs.mkdirSync(userData, { recursive: true });
    this.attachmentRoot = path.join(userData, "attachments");
    fs.mkdirSync(this.attachmentRoot, { recursive: true });

    this.db = new Database(path.join(userData, "cachette.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
  }

  status(secureStorageAvailable = false): VaultStatus {
    return {
      initialized: Boolean(this.getMetadata("vault:kdf")),
      unlocked: Boolean(this.key),
      secureStorageAvailable,
      itemCount: this.itemCount()
    };
  }

  setup(masterPassword: string): VaultStatus {
    if (this.getMetadata("vault:kdf")) {
      throw new Error("Vault is already initialized.");
    }

    const { key, kdf } = createVaultKdf(masterPassword);
    this.setMetadata("vault:kdf", JSON.stringify(kdf));
    this.key = key;
    return this.status();
  }

  unlock(masterPassword: string): VaultStatus {
    const kdf = this.readKdf();
    const key = deriveKey(masterPassword, kdf.salt, kdf.iterations);

    if (!verifyKey(key, kdf.verifier)) {
      throw new Error("Invalid master password.");
    }

    this.key = key;
    return this.status();
  }

  unlockWithDerivedKey(keyBase64: string): VaultStatus {
    const key = Buffer.from(keyBase64, "base64");
    const kdf = this.readKdf();

    if (!verifyKey(key, kdf.verifier)) {
      throw new Error("Stored OS credential did not match this vault.");
    }

    this.key = key;
    return this.status(true);
  }

  currentKeyForSecureStorage(): string {
    return this.requireKey().toString("base64");
  }

  lock(): VaultStatus {
    this.key = null;
    return this.status();
  }

  listItems(filters: ItemFilters = {}): VaultItem[] {
    this.requireKey();
    const rows = this.db.prepare("SELECT * FROM items ORDER BY updated_at DESC").all() as ItemRow[];
    const normalizedSearch = filters.search?.trim().toLowerCase();

    return rows
      .map((row) => this.toItem(row))
      .filter((item) => {
        if (filters.type && filters.type !== "all" && item.type !== filters.type) {
          return false;
        }
        if (filters.category && item.category !== filters.category) {
          return false;
        }
        if (filters.tag && !item.tags.includes(filters.tag)) {
          return false;
        }
        if (!normalizedSearch) {
          return true;
        }

        const haystack = [item.title, item.content, item.url, item.repoPath, item.category, item.tags.join(" ")]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(normalizedSearch);
      });
  }

  createItem(draft: ItemDraft): VaultItem {
    const key = this.requireKey();
    const now = new Date().toISOString();
    const id = randomUUID();
    const encryptedData = draft.encryptedData ? encryptJson(draft.encryptedData, key) : null;

    this.db
      .prepare(
        `INSERT INTO items (id, type, title, content, url, repo_path, category, tags, encrypted_data, created_at, updated_at)
         VALUES (@id, @type, @title, @content, @url, @repoPath, @category, @tags, @encryptedData, @createdAt, @updatedAt)`
      )
      .run({
        id,
        type: draft.type,
        title: draft.title.trim(),
        content: draft.content ?? "",
        url: draft.url || null,
        repoPath: draft.repoPath || null,
        category: draft.category?.trim() || "General",
        tags: JSON.stringify(draft.tags ?? []),
        encryptedData,
        createdAt: now,
        updatedAt: now
      });

    if (draft.attachmentPaths?.length) {
      this.addAttachments(id, draft.attachmentPaths);
    }

    return this.getItem(id);
  }

  updateItem(update: ItemUpdate): VaultItem {
    const key = this.requireKey();
    const current = this.getRow(update.id);
    const nextEncrypted =
      update.encryptedData === undefined ? current.encrypted_data : encryptJson(update.encryptedData, key);

    this.db
      .prepare(
        `UPDATE items
         SET type = @type,
             title = @title,
             content = @content,
             url = @url,
             repo_path = @repoPath,
             category = @category,
             tags = @tags,
             encrypted_data = @encryptedData,
             updated_at = @updatedAt
         WHERE id = @id`
      )
      .run({
        id: update.id,
        type: update.type ?? current.type,
        title: update.title?.trim() ?? current.title,
        content: update.content ?? current.content,
        url: update.url ?? current.url,
        repoPath: update.repoPath ?? current.repo_path,
        category: update.category?.trim() ?? current.category,
        tags: JSON.stringify(update.tags ?? JSON.parse(current.tags)),
        encryptedData: nextEncrypted,
        updatedAt: new Date().toISOString()
      });

    return this.getItem(update.id);
  }

  deleteItem(id: string): void {
    this.requireKey();
    const attachments = this.getAttachments(id);
    this.db.prepare("DELETE FROM items WHERE id = ?").run(id);

    for (const attachment of attachments) {
      if (attachment.filePath.startsWith(this.attachmentRoot) && fs.existsSync(attachment.filePath)) {
        fs.rmSync(attachment.filePath, { force: true });
      }
    }
  }

  addAttachments(itemId: string, filePaths: string[]): AttachmentRecord[] {
    this.requireKey();
    this.getRow(itemId);
    const records = filePaths.map((filePath) => this.copyAttachment(itemId, filePath));

    const insert = this.db.prepare(
      `INSERT INTO attachments (id, item_id, file_path, kind, original_name, created_at)
       VALUES (@id, @itemId, @filePath, @kind, @originalName, @createdAt)`
    );
    const saveAll = this.db.transaction((items: AttachmentRecord[]) => {
      for (const item of items) {
        insert.run(item);
      }
    });
    saveAll(records);
    return records;
  }

  revealSecret(itemId: string): Record<string, string> {
    const key = this.requireKey();
    const row = this.getRow(itemId);
    return decryptJson<Record<string, string>>(row.encrypted_data, key) ?? {};
  }

  attachmentPreview(attachmentId: string): AttachmentPreview | null {
    this.requireKey();
    const row = this.db.prepare("SELECT * FROM attachments WHERE id = ?").get(attachmentId) as AttachmentRow | undefined;
    if (!row || !fs.existsSync(row.file_path) || !isImage(row.original_name)) {
      return null;
    }

    const mimeType = imageMimeType(row.original_name);
    return {
      id: row.id,
      dataUrl: `data:${mimeType};base64,${fs.readFileSync(row.file_path).toString("base64")}`,
      mimeType
    };
  }

  changeMasterPassword(currentPassword: string, nextPassword: string): VaultStatus {
    const currentKdf = this.readKdf();
    const currentKey = deriveKey(currentPassword, currentKdf.salt, currentKdf.iterations);

    if (!verifyKey(currentKey, currentKdf.verifier)) {
      throw new Error("Current master password is incorrect.");
    }

    const { key: nextKey, kdf: nextKdf } = createVaultKdf(nextPassword);
    const rows = this.db.prepare("SELECT id, encrypted_data FROM items").all() as Array<{
      id: string;
      encrypted_data: string | null;
    }>;

    const reencrypt = this.db.transaction(() => {
      const update = this.db.prepare("UPDATE items SET encrypted_data = ? WHERE id = ?");
      for (const row of rows) {
        if (!row.encrypted_data) continue;
        const clear = decryptJson<Record<string, string>>(row.encrypted_data, currentKey) ?? {};
        update.run(encryptJson(clear, nextKey), row.id);
      }
      this.setMetadata("vault:kdf", JSON.stringify(nextKdf));
    });

    reencrypt();
    this.key = nextKey;
    return this.status();
  }

  exportBackup(backupPassword: string): BackupExportResult {
    this.requireKey();
    const metadata = this.db.prepare("SELECT key, value FROM metadata").all() as Array<{ key: string; value: string }>;
    const items = this.db.prepare("SELECT * FROM items ORDER BY created_at ASC").all() as ItemRow[];
    const attachments = this.db.prepare("SELECT * FROM attachments ORDER BY created_at ASC").all() as AttachmentRow[];
    const files = attachments
      .filter((attachment) => fs.existsSync(attachment.file_path))
      .map((attachment) => ({
        filePath: attachment.file_path,
        data: fs.readFileSync(attachment.file_path).toString("base64")
      }));

    const payload: BackupPayload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      metadata,
      items,
      attachments,
      files
    };
    const { key, kdf } = createVaultKdf(backupPassword);
    const backup = JSON.stringify({
      cachetteBackup: 1,
      kdf,
      payload: encryptJson(payload, key)
    });
    const filePath = path.join(app.getPath("downloads"), `cachette-backup-${Date.now()}.enc`);

    fs.writeFileSync(filePath, backup, { mode: 0o600 });
    return { filePath };
  }

  importBackup(backupPath: string, backupPassword: string): void {
    const raw = JSON.parse(fs.readFileSync(backupPath, "utf8")) as {
      cachetteBackup: 1;
      kdf: VaultKdf;
      payload: string;
    };
    const backupKey = deriveKey(backupPassword, raw.kdf.salt, raw.kdf.iterations);

    if (!verifyKey(backupKey, raw.kdf.verifier)) {
      throw new Error("Invalid backup password.");
    }

    const payload = decryptJson<BackupPayload>(raw.payload, backupKey);
    if (!payload || payload.version !== 1) {
      throw new Error("Unsupported backup format.");
    }

    const replaceAll = this.db.transaction(() => {
      this.db.prepare("DELETE FROM attachments").run();
      this.db.prepare("DELETE FROM items").run();
      this.db.prepare("DELETE FROM metadata").run();

      const insertMeta = this.db.prepare("INSERT INTO metadata (key, value) VALUES (@key, @value)");
      const insertItem = this.db.prepare(
        `INSERT INTO items (id, type, title, content, url, repo_path, category, tags, encrypted_data, created_at, updated_at)
         VALUES (@id, @type, @title, @content, @url, @repo_path, @category, @tags, @encrypted_data, @created_at, @updated_at)`
      );
      const insertAttachment = this.db.prepare(
        `INSERT INTO attachments (id, item_id, file_path, kind, original_name, created_at)
         VALUES (@id, @item_id, @file_path, @kind, @original_name, @created_at)`
      );

      for (const row of payload.metadata) insertMeta.run(row);
      for (const row of payload.items) insertItem.run(row);
      for (const row of payload.attachments) insertAttachment.run(row);
    });

    replaceAll();

    for (const file of payload.files) {
      fs.mkdirSync(path.dirname(file.filePath), { recursive: true });
      fs.writeFileSync(file.filePath, Buffer.from(file.data, "base64"), { mode: 0o600 });
    }

    this.key = null;
  }

  private getItem(id: string): VaultItem {
    return this.toItem(this.getRow(id));
  }

  private getRow(id: string): ItemRow {
    const row = this.db.prepare("SELECT * FROM items WHERE id = ?").get(id) as ItemRow | undefined;
    if (!row) {
      throw new Error("Item not found.");
    }
    return row;
  }

  private toItem(row: ItemRow): VaultItem {
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      content: row.content,
      url: row.url ?? undefined,
      repoPath: row.repo_path ?? undefined,
      category: row.category,
      tags: JSON.parse(row.tags) as string[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      encryptedData: row.encrypted_data ? { sealed: "AES-256-GCM" } : undefined,
      attachments: this.getAttachments(row.id)
    };
  }

  private getAttachments(itemId: string): AttachmentRecord[] {
    const rows = this.db.prepare("SELECT * FROM attachments WHERE item_id = ? ORDER BY created_at ASC").all(itemId) as AttachmentRow[];
    return rows.map((row) => ({
      id: row.id,
      itemId: row.item_id,
      filePath: row.file_path,
      kind: row.kind,
      originalName: row.original_name,
      createdAt: row.created_at
    }));
  }

  private copyAttachment(itemId: string, sourcePath: string): AttachmentRecord {
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Attachment does not exist: ${sourcePath}`);
    }

    const id = randomUUID();
    const originalName = path.basename(sourcePath);
    const itemDir = path.join(this.attachmentRoot, itemId);
    const destination = path.join(itemDir, `${id}-${originalName}`);
    fs.mkdirSync(itemDir, { recursive: true });
    fs.copyFileSync(sourcePath, destination);

    return {
      id,
      itemId,
      filePath: destination,
      kind: isImage(originalName) ? "image" : "file",
      originalName,
      createdAt: new Date().toISOString()
    };
  }

  private readKdf(): VaultKdf {
    const raw = this.getMetadata("vault:kdf");
    if (!raw) {
      throw new Error("Vault has not been initialized.");
    }
    return JSON.parse(raw) as VaultKdf;
  }

  private getMetadata(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  private setMetadata(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)").run(key, value);
  }

  private itemCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM items").get() as { count: number };
    return row.count;
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new Error("Vault is locked.");
    }
    return this.key;
  }
}

function isImage(fileName: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(fileName);
}

function imageMimeType(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  return {
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp"
  }[extension] ?? "application/octet-stream";
}
