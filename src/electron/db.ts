import Database from "better-sqlite3";
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createVaultKdf,
  decryptJson,
  deriveKey,
  encryptJson,
  generateRecoveryKey,
  generateVaultKey,
  normalizeRecoveryKey,
  verifyKey,
  zeroKey,
  type VaultKdf
} from "./crypto";
import type {
  AttachmentPreview,
  AttachmentRecord,
  BackupExportResult,
  BackupImportRequest,
  BackupImportResult,
  ItemDraft,
  ItemFilters,
  ItemUpdate,
  TodoEntry,
  VaultRecoveryResult,
  VaultItem,
  VaultSetupResult,
  VaultStatus
} from "../shared/types";

type ItemRow = {
  id: string;
  type: VaultItem["type"];
  title: string;
  content: string;
  content_format?: VaultItem["contentFormat"];
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

type RecoverySlot = {
  id: string;
  label: string;
  kdf: VaultKdf;
  wrappedKey: string;
  usedAt?: string;
};

type VaultWrapping = {
  v: 2;
  master: {
    kdf: VaultKdf;
    wrappedKey: string;
  };
  recovery: RecoverySlot[];
};

const WRAPPING_METADATA_KEY = "vault:wrapping";
const LEGACY_KDF_METADATA_KEY = "vault:kdf";
const REMEMBER_METADATA_KEY = "vault:remember";
const RECOVERY_KEY_COUNT = 3;

export type RememberSlot = {
  wrappedKey: string;
  createdAt: string;
};

const INSERT_ITEM_SQL = `INSERT INTO items (id, type, title, content, content_format, url, repo_path, category, tags, encrypted_data, created_at, updated_at)
 VALUES (@id, @type, @title, @content, @content_format, @url, @repo_path, @category, @tags, @encrypted_data, @created_at, @updated_at)`;

const INSERT_ATTACHMENT_SQL = `INSERT INTO attachments (id, item_id, file_path, kind, original_name, created_at)
 VALUES (@id, @item_id, @file_path, @kind, @original_name, @created_at)`;

const vaultKdfSchema = z.object({
  salt: z.string().min(1),
  iterations: z.number().int().positive().max(5_000_000),
  digest: z.string(),
  verifier: z.string().min(1)
});

const backupEnvelopeSchema = z.object({
  cachetteBackup: z.literal(1),
  kdf: vaultKdfSchema,
  payload: z.string().min(1)
});

const backupPayloadSchema = z.object({
  version: z.literal(1),
  exportedAt: z.string(),
  metadata: z.array(z.object({ key: z.string(), value: z.string() })),
  items: z.array(
    z.object({
      id: z.string().min(1),
      type: z.enum(["note", "link", "repo", "image", "password", "private", "todo"]),
      title: z.string(),
      content: z.string(),
      content_format: z.enum(["markdown", "richtext", "plain"]).optional(),
      url: z.string().nullable(),
      repo_path: z.string().nullable(),
      category: z.string(),
      tags: z.string(),
      encrypted_data: z.string().nullable(),
      created_at: z.string(),
      updated_at: z.string()
    })
  ),
  attachments: z.array(
    z.object({
      id: z.string().min(1),
      item_id: z.string().min(1),
      file_path: z.string().min(1),
      kind: z.enum(["file", "image", "screenshot"]),
      original_name: z.string().min(1),
      created_at: z.string()
    })
  ),
  files: z.array(z.object({ filePath: z.string().min(1), data: z.string() }))
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('note', 'link', 'repo', 'image', 'password', 'private', 'todo')),
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  content_format TEXT NOT NULL DEFAULT 'plain' CHECK (content_format IN ('markdown', 'richtext', 'plain')),
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
    this.migrateItemsTable();
  }

  status(): VaultStatus {
    return {
      initialized: Boolean(this.getMetadata(WRAPPING_METADATA_KEY) || this.getMetadata(LEGACY_KDF_METADATA_KEY)),
      unlocked: Boolean(this.key),
      itemCount: this.itemCount()
    };
  }

  async setup(masterPassword: string): Promise<VaultSetupResult> {
    if (this.getMetadata(WRAPPING_METADATA_KEY) || this.getMetadata(LEGACY_KDF_METADATA_KEY)) {
      throw new Error("Vault is already initialized.");
    }

    const vaultKey = generateVaultKey();
    const { key: masterKey, kdf: masterKdf } = await createVaultKdf(masterPassword);
    const recoveryKeys = Array.from({ length: RECOVERY_KEY_COUNT }, () => generateRecoveryKey());
    const recoverySlots: RecoverySlot[] = [];
    for (const [index, recoveryKey] of recoveryKeys.entries()) {
      recoverySlots.push(await this.createRecoverySlot(recoveryKey, vaultKey, index));
    }
    const wrapping: VaultWrapping = {
      v: 2,
      master: {
        kdf: masterKdf,
        wrappedKey: this.wrapVaultKey(vaultKey, masterKey)
      },
      recovery: recoverySlots
    };
    zeroKey(masterKey);

    this.setMetadata(WRAPPING_METADATA_KEY, JSON.stringify(wrapping));
    this.key = vaultKey;
    return {
      status: this.status(),
      recoveryKeys
    };
  }

  async unlock(masterPassword: string): Promise<VaultStatus> {
    const wrapping = this.readWrapping();
    if (wrapping) {
      const key = await this.deriveAndVerify(masterPassword, wrapping.master.kdf, "Invalid master password.");
      this.key = this.unwrapVaultKey(wrapping.master.wrappedKey, key);
      zeroKey(key);
      return this.status();
    }

    const kdf = this.readKdf();
    this.key = await this.deriveAndVerify(masterPassword, kdf, "Invalid master password.");
    return this.status();
  }

  lock(): VaultStatus {
    zeroKey(this.key);
    this.key = null;
    return this.status();
  }

  readRememberSlot(): RememberSlot | undefined {
    const raw = this.getMetadata(REMEMBER_METADATA_KEY);
    return raw ? (JSON.parse(raw) as RememberSlot) : undefined;
  }

  createRememberSlot(secret: Buffer): RememberSlot {
    const key = this.requireKey();
    const slot: RememberSlot = {
      wrappedKey: this.wrapVaultKey(key, secret),
      createdAt: new Date().toISOString()
    };
    this.setMetadata(REMEMBER_METADATA_KEY, JSON.stringify(slot));
    return slot;
  }

  clearRememberSlot(): void {
    this.db.prepare("DELETE FROM metadata WHERE key = ?").run(REMEMBER_METADATA_KEY);
  }

  unlockWithRememberedKey(secret: Buffer): VaultStatus {
    const slot = this.readRememberSlot();
    if (!slot) {
      throw new Error("No remembered session.");
    }
    this.key = this.unwrapVaultKey(slot.wrappedKey, secret);
    return this.status();
  }

  close(): void {
    this.lock();
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.close();
  }

  async recoverWithRecoveryKey(recoveryKey: string, nextMasterPassword: string): Promise<VaultRecoveryResult> {
    const wrapping = this.readWrapping();
    if (!wrapping) {
      throw new Error("This vault does not have recovery keys. Unlock with the master password first.");
    }

    const normalizedRecoveryKey = normalizeRecoveryKey(recoveryKey);
    let slotIndex = -1;
    let recoveryDerivedKey: Buffer | null = null;
    for (const [index, slot] of wrapping.recovery.entries()) {
      if (slot.usedAt || !slot.wrappedKey) continue;
      const key = await deriveKey(normalizedRecoveryKey, slot.kdf.salt, slot.kdf.iterations);
      if (verifyKey(key, slot.kdf.verifier)) {
        slotIndex = index;
        recoveryDerivedKey = key;
        break;
      }
      zeroKey(key);
    }

    if (slotIndex < 0 || !recoveryDerivedKey) {
      throw new Error("Invalid or already used recovery key.");
    }

    const slot = wrapping.recovery[slotIndex];
    const vaultKey = this.unwrapVaultKey(slot.wrappedKey, recoveryDerivedKey);
    zeroKey(recoveryDerivedKey);
    const { key: nextMasterKey, kdf: nextMasterKdf } = await createVaultKdf(nextMasterPassword);
    const replacementRecoveryKey = generateRecoveryKey();
    const replacementSlot = await this.createRecoverySlot(replacementRecoveryKey, vaultKey, slotIndex);

    const nextWrapping: VaultWrapping = {
      ...wrapping,
      master: {
        kdf: nextMasterKdf,
        wrappedKey: this.wrapVaultKey(vaultKey, nextMasterKey)
      },
      recovery: wrapping.recovery.map((currentSlot, index) =>
        index === slotIndex ? replacementSlot : currentSlot
      )
    };
    zeroKey(nextMasterKey);

    this.setMetadata(WRAPPING_METADATA_KEY, JSON.stringify(nextWrapping));
    this.key = vaultKey;
    return {
      status: this.status(),
      replacementRecoveryKey
    };
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

        const haystack = [item.title, item.content, item.todos?.map((todo) => todo.text).join(" "), item.url, item.repoPath, item.category, item.tags.join(" ")]
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

    this.db.prepare(INSERT_ITEM_SQL).run({
      id,
      type: draft.type,
      title: draft.title.trim(),
      content: serializeItemContent(draft),
      content_format: draft.contentFormat ?? defaultContentFormat(draft.type),
      url: draft.url || null,
      repo_path: draft.repoPath || null,
      category: draft.category?.trim() || "General",
      tags: JSON.stringify(draft.tags ?? []),
      encrypted_data: encryptedData,
      created_at: now,
      updated_at: now
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
             content_format = @contentFormat,
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
        content: serializeItemContent({
          type: update.type ?? current.type,
          content: update.content ?? current.content,
          todos: update.todos
        }),
        contentFormat: update.contentFormat ?? current.content_format ?? defaultContentFormat(update.type ?? current.type),
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
      if (this.isUnderAttachmentRoot(attachment.filePath) && fs.existsSync(attachment.filePath)) {
        fs.rmSync(attachment.filePath, { force: true });
      }
    }
  }

  addAttachments(itemId: string, filePaths: string[]): AttachmentRecord[] {
    this.requireKey();
    this.getRow(itemId);
    const records = filePaths.map((filePath) => this.copyAttachment(itemId, filePath));

    const insert = this.db.prepare(INSERT_ATTACHMENT_SQL);
    const saveAll = this.db.transaction((items: AttachmentRecord[]) => {
      for (const item of items) {
        insert.run({
          id: item.id,
          item_id: item.itemId,
          file_path: item.filePath,
          kind: item.kind,
          original_name: item.originalName,
          created_at: item.createdAt
        });
      }
    });

    try {
      saveAll(records);
    } catch (error) {
      for (const record of records) {
        fs.rmSync(record.filePath, { force: true });
      }
      throw error;
    }
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
    if (!row || !this.isUnderAttachmentRoot(row.file_path) || !fs.existsSync(row.file_path) || !isImage(row.original_name)) {
      return null;
    }

    const mimeType = imageMimeType(row.original_name);
    return {
      id: row.id,
      dataUrl: `data:${mimeType};base64,${fs.readFileSync(row.file_path).toString("base64")}`,
      mimeType
    };
  }

  async changeMasterPassword(currentPassword: string, nextPassword: string): Promise<VaultStatus> {
    const wrapping = this.readWrapping();
    if (wrapping) {
      const currentKey = await this.deriveAndVerify(
        currentPassword,
        wrapping.master.kdf,
        "Current master password is incorrect."
      );

      const vaultKey = this.unwrapVaultKey(wrapping.master.wrappedKey, currentKey);
      zeroKey(currentKey);
      const { key: nextKey, kdf: nextKdf } = await createVaultKdf(nextPassword);
      const nextWrapping: VaultWrapping = {
        ...wrapping,
        master: {
          kdf: nextKdf,
          wrappedKey: this.wrapVaultKey(vaultKey, nextKey)
        }
      };
      zeroKey(nextKey);

      this.setMetadata(WRAPPING_METADATA_KEY, JSON.stringify(nextWrapping));
      this.key = vaultKey;
      return this.status();
    }

    const currentKdf = this.readKdf();
    const currentKey = await this.deriveAndVerify(currentPassword, currentKdf, "Current master password is incorrect.");

    const { key: nextKey, kdf: nextKdf } = await createVaultKdf(nextPassword);
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
    zeroKey(currentKey);
    this.key = nextKey;
    return this.status();
  }

  async exportBackup(backupPassword: string): Promise<BackupExportResult> {
    this.requireKey();
    // Remember-me slots are device-bound; never carry them across machines in backups.
    const metadata = (
      this.db.prepare("SELECT key, value FROM metadata").all() as Array<{ key: string; value: string }>
    ).filter((row) => row.key !== REMEMBER_METADATA_KEY);
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
    const { key, kdf } = await createVaultKdf(backupPassword);
    const backup = JSON.stringify({
      cachetteBackup: 1,
      kdf,
      payload: encryptJson(payload, key)
    });
    zeroKey(key);
    const filePath = path.join(app.getPath("downloads"), `cachette-backup-${Date.now()}.enc`);

    fs.writeFileSync(filePath, backup, { mode: 0o600 });
    return { filePath };
  }

  async importBackup(request: BackupImportRequest): Promise<BackupImportResult> {
    const raw = backupEnvelopeSchema.parse(JSON.parse(fs.readFileSync(request.backupPath, "utf8")));
    const backupKey = await this.deriveAndVerify(request.backupPassword, raw.kdf, "Invalid backup password.");

    const decrypted = decryptJson<unknown>(raw.payload, backupKey);
    zeroKey(backupKey);
    const parsedPayload = backupPayloadSchema.safeParse(decrypted);
    if (!parsedPayload.success) {
      throw new Error("Unsupported backup format.");
    }
    const payload: BackupPayload = parsedPayload.data;

    if (request.mode === "merge") {
      await this.mergeBackup(payload, request.sourceMasterPassword);
    } else {
      this.replaceBackup(payload);
      this.lock();
    }

    return {
      mode: request.mode,
      itemCount: payload.items.length,
      status: this.status()
    };
  }

  resetForDevelopment(): VaultStatus {
    const clearAll = this.db.transaction(() => {
      this.db.prepare("DELETE FROM attachments").run();
      this.db.prepare("DELETE FROM items").run();
      this.db.prepare("DELETE FROM metadata").run();
    });

    clearAll();
    fs.rmSync(this.attachmentRoot, { force: true, recursive: true });
    fs.mkdirSync(this.attachmentRoot, { recursive: true });
    zeroKey(this.key);
    this.key = null;
    return this.status();
  }

  private migrateItemsTable(): void {
    const table = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'items'").get() as
      | { sql: string }
      | undefined;
    const columns = this.db.prepare("PRAGMA table_info(items)").all() as Array<{ name: string }>;
    const hasContentFormat = columns.some((column) => column.name === "content_format");
    const supportsTodo = Boolean(table?.sql.includes("'todo'"));

    if (hasContentFormat && supportsTodo) {
      return;
    }

    const contentFormatExpression = hasContentFormat
      ? "COALESCE(content_format, CASE WHEN type = 'note' THEN 'markdown' ELSE 'plain' END)"
      : "CASE WHEN type = 'note' THEN 'markdown' ELSE 'plain' END";

    this.db.pragma("foreign_keys = OFF");
    try {
      const migrate = this.db.transaction(() => {
        this.db.exec(`
        DROP TABLE IF EXISTS items_next;

        CREATE TABLE items_next (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK (type IN ('note', 'link', 'repo', 'image', 'password', 'private', 'todo')),
          title TEXT NOT NULL,
          content TEXT NOT NULL DEFAULT '',
          content_format TEXT NOT NULL DEFAULT 'plain' CHECK (content_format IN ('markdown', 'richtext', 'plain')),
          url TEXT,
          repo_path TEXT,
          category TEXT NOT NULL DEFAULT 'General',
          tags TEXT NOT NULL DEFAULT '[]',
          encrypted_data TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        INSERT INTO items_next (id, type, title, content, content_format, url, repo_path, category, tags, encrypted_data, created_at, updated_at)
        SELECT id, type, title, content, ${contentFormatExpression}, url, repo_path, category, tags, encrypted_data, created_at, updated_at
        FROM items;

        DROP TABLE items;
        ALTER TABLE items_next RENAME TO items;
        CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
        CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);
        CREATE INDEX IF NOT EXISTS idx_items_updated_at ON items(updated_at);
      `);
      });
      migrate();
    } finally {
      this.db.pragma("foreign_keys = ON");
    }
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
    const contentFormat = row.content_format ?? defaultContentFormat(row.type);
    return {
      id: row.id,
      type: row.type,
      title: row.title,
      content: row.type === "todo" ? "" : row.content,
      contentFormat,
      todos: row.type === "todo" ? parseTodoEntries(row.content) : undefined,
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

  private normalizeBackupItemRow(row: ItemRow): ItemRow & { content_format: VaultItem["contentFormat"] } {
    return {
      ...row,
      content_format: row.content_format ?? defaultContentFormat(row.type)
    };
  }

  private copyAttachment(itemId: string, sourcePath: string): AttachmentRecord {
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Attachment does not exist: ${path.basename(sourcePath)}`);
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

  private replaceBackup(payload: BackupPayload): void {
    const fileDataByPath = new Map(payload.files.map((file) => [file.filePath, file.data]));
    const filesToWrite: Array<{ filePath: string; data: string }> = [];

    // Never trust file paths baked into a backup: recompute every attachment
    // location under this vault's attachment root.
    const nextAttachments = payload.attachments.map((attachment) => {
      const originalName = path.basename(attachment.original_name || attachment.file_path);
      const filePath = this.resolveUnderAttachmentRoot(
        path.join(this.attachmentRoot, sanitizePathSegment(attachment.item_id), `${sanitizePathSegment(attachment.id)}-${originalName}`)
      );
      const data = fileDataByPath.get(attachment.file_path);
      if (data) {
        filesToWrite.push({ filePath, data });
      }
      return { ...attachment, file_path: filePath, original_name: originalName };
    });

    const replaceAll = this.db.transaction(() => {
      this.db.prepare("DELETE FROM attachments").run();
      this.db.prepare("DELETE FROM items").run();
      this.db.prepare("DELETE FROM metadata").run();

      const insertMeta = this.db.prepare("INSERT INTO metadata (key, value) VALUES (@key, @value)");
      const insertItem = this.db.prepare(INSERT_ITEM_SQL);
      const insertAttachment = this.db.prepare(INSERT_ATTACHMENT_SQL);

      for (const row of payload.metadata) {
        if (row.key === REMEMBER_METADATA_KEY) continue;
        insertMeta.run(row);
      }
      for (const row of payload.items) insertItem.run(this.normalizeBackupItemRow(row));
      for (const row of nextAttachments) insertAttachment.run(row);
    });

    this.writeAttachmentFiles(filesToWrite, replaceAll);
  }

  private async mergeBackup(payload: BackupPayload, sourceMasterPassword: string | undefined): Promise<void> {
    const currentKey = this.requireKey();
    if (!sourceMasterPassword) {
      throw new Error("Source vault master password is required for merge imports.");
    }

    const sourceKey = await this.backupVaultKey(payload, sourceMasterPassword);

    const now = new Date().toISOString();
    const itemIdMap = new Map<string, string>();
    const fileDataByPath = new Map(payload.files.map((file) => [file.filePath, file.data]));
    const filesToWrite: Array<{ filePath: string; data: string }> = [];

    const nextItems = payload.items.map((item) => {
      const nextId = randomUUID();
      itemIdMap.set(item.id, nextId);
      let encryptedData = item.encrypted_data;

      if (item.encrypted_data) {
        const clear = decryptJson<Record<string, string>>(item.encrypted_data, sourceKey) ?? {};
        encryptedData = encryptJson(clear, currentKey);
      }

      return this.normalizeBackupItemRow({
        ...item,
        id: nextId,
        encrypted_data: encryptedData,
        created_at: item.created_at || now,
        updated_at: item.updated_at || now
      });
    });

    const nextAttachments = payload.attachments.flatMap((attachment) => {
      const nextItemId = itemIdMap.get(attachment.item_id);
      const data = fileDataByPath.get(attachment.file_path);
      if (!nextItemId || !data) return [];

      const nextId = randomUUID();
      const originalName = path.basename(attachment.original_name || attachment.file_path);
      const filePath = path.join(this.attachmentRoot, nextItemId, `${nextId}-${originalName}`);
      filesToWrite.push({ filePath, data });

      return [
        {
          ...attachment,
          id: nextId,
          item_id: nextItemId,
          file_path: filePath,
          original_name: originalName,
          created_at: attachment.created_at || now
        }
      ];
    });

    const mergeAll = this.db.transaction(() => {
      const insertItem = this.db.prepare(INSERT_ITEM_SQL);
      const insertAttachment = this.db.prepare(INSERT_ATTACHMENT_SQL);

      for (const row of nextItems) insertItem.run(row);
      for (const row of nextAttachments) insertAttachment.run(row);
    });

    zeroKey(sourceKey);
    this.writeAttachmentFiles(filesToWrite, mergeAll);
  }

  private writeAttachmentFiles(files: Array<{ filePath: string; data: string }>, commit: () => void): void {
    const written: string[] = [];
    try {
      for (const file of files) {
        const filePath = this.resolveUnderAttachmentRoot(file.filePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, Buffer.from(file.data, "base64"), { mode: 0o600 });
        written.push(filePath);
      }
      commit();
    } catch (error) {
      for (const filePath of written) {
        fs.rmSync(filePath, { force: true });
      }
      throw error;
    }
  }

  private isUnderAttachmentRoot(candidate: string): boolean {
    const resolved = path.resolve(candidate);
    const root = path.resolve(this.attachmentRoot);
    return resolved === root || resolved.startsWith(root + path.sep);
  }

  private resolveUnderAttachmentRoot(candidate: string): string {
    if (!this.isUnderAttachmentRoot(candidate)) {
      throw new Error("Attachment path is outside the vault attachment folder.");
    }
    return path.resolve(candidate);
  }

  private async backupVaultKey(payload: BackupPayload, sourceMasterPassword: string): Promise<Buffer> {
    const wrapping = this.backupWrapping(payload);
    if (wrapping) {
      const sourceMasterKey = await this.deriveAndVerify(
        sourceMasterPassword,
        wrapping.master.kdf,
        "Source vault master password is incorrect."
      );
      const vaultKey = this.unwrapVaultKey(wrapping.master.wrappedKey, sourceMasterKey);
      zeroKey(sourceMasterKey);
      return vaultKey;
    }

    const metadata = payload.metadata.find((row) => row.key === LEGACY_KDF_METADATA_KEY);
    if (!metadata) {
      throw new Error("Backup is missing vault key metadata.");
    }
    const sourceKdf = vaultKdfSchema.parse(JSON.parse(metadata.value));
    return this.deriveAndVerify(sourceMasterPassword, sourceKdf, "Source vault master password is incorrect.");
  }

  private async deriveAndVerify(password: string, kdf: VaultKdf, errorMessage: string): Promise<Buffer> {
    const key = await deriveKey(password, kdf.salt, kdf.iterations);
    if (!verifyKey(key, kdf.verifier)) {
      zeroKey(key);
      throw new Error(errorMessage);
    }
    return key;
  }

  private wrapVaultKey(vaultKey: Buffer, key: Buffer): string {
    return encryptJson(vaultKey.toString("base64"), key);
  }

  private async createRecoverySlot(recoveryKey: string, vaultKey: Buffer, index: number): Promise<RecoverySlot> {
    const normalizedRecoveryKey = normalizeRecoveryKey(recoveryKey);
    const { key, kdf } = await createVaultKdf(normalizedRecoveryKey);
    const wrappedKey = this.wrapVaultKey(vaultKey, key);
    zeroKey(key);

    return {
      id: randomUUID(),
      label: `Recovery key ${index + 1}`,
      kdf,
      wrappedKey
    };
  }

  private unwrapVaultKey(wrappedKey: string, key: Buffer): Buffer {
    const vaultKeyBase64 = decryptJson<string>(wrappedKey, key);
    if (!vaultKeyBase64) {
      throw new Error("Could not unlock vault key.");
    }
    return Buffer.from(vaultKeyBase64, "base64");
  }

  private readWrapping(): VaultWrapping | undefined {
    const raw = this.getMetadata(WRAPPING_METADATA_KEY);
    return raw ? (JSON.parse(raw) as VaultWrapping) : undefined;
  }

  private backupWrapping(payload: BackupPayload): VaultWrapping | undefined {
    const metadata = payload.metadata.find((row) => row.key === WRAPPING_METADATA_KEY);
    return metadata ? (JSON.parse(metadata.value) as VaultWrapping) : undefined;
  }

  private readKdf(): VaultKdf {
    const raw = this.getMetadata(LEGACY_KDF_METADATA_KEY);
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

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_") || "_";
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

function defaultContentFormat(type: VaultItem["type"]): VaultItem["contentFormat"] {
  return type === "note" ? "markdown" : "plain";
}

function serializeItemContent(item: Pick<ItemDraft, "type" | "content" | "todos">): string {
  if (item.type === "todo") {
    return JSON.stringify(item.todos ?? parseTodoEntries(item.content ?? ""));
  }

  return item.content ?? "";
}

function parseTodoEntries(content: string): TodoEntry[] {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return undefined;
        }

        const candidate = entry as Partial<TodoEntry>;
        return {
          id: typeof candidate.id === "string" && candidate.id ? candidate.id : randomUUID(),
          text: typeof candidate.text === "string" ? candidate.text : "",
          done: Boolean(candidate.done)
        };
      })
      .filter((entry): entry is TodoEntry => Boolean(entry?.text.trim()));
  } catch {
    return [];
  }
}
