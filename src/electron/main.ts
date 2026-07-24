import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from "electron";
import path from "node:path";
import { z } from "zod";
import { VaultDatabase } from "./db";
import type { ItemDraft, ItemFilters, ItemUpdate, VaultSettings, VaultStatus } from "../shared/types";

const SERVICE_NAME = "Cachette Vault";
const SECURE_STORAGE_ACCOUNT = "vault-derived-key";
const APP_ICON_PATH = path.join(app.getAppPath(), "assets", "icon.ico");

let mainWindow: BrowserWindow | null = null;
let vault: VaultDatabase;

type KeytarModule = {
  setPassword: (service: string, account: string, password: string) => Promise<void>;
  getPassword: (service: string, account: string) => Promise<string | null>;
  deletePassword?: (service: string, account: string) => Promise<boolean>;
};

const itemTypeSchema = z.enum(["note", "link", "repo", "image", "password", "private"]);
const itemDraftSchema = z.object({
  type: itemTypeSchema,
  title: z.string().min(1).max(180),
  content: z.string().optional(),
  url: z.string().optional(),
  repoPath: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  encryptedData: z.record(z.string()).optional(),
  attachmentPaths: z.array(z.string()).optional()
});
const itemUpdateSchema = itemDraftSchema.partial().extend({
  id: z.string().min(1)
});
const filtersSchema = z
  .object({
    search: z.string().optional(),
    type: z.union([itemTypeSchema, z.literal("all")]).optional(),
    category: z.string().optional(),
    tag: z.string().optional()
  })
  .optional();

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  vault?.lock();
});

app.whenReady().then(async () => {
  vault = new VaultDatabase();
  Menu.setApplicationMenu(null);
  registerIpc();
  await createWindow();
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createWindow();
  }
});

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: "Cachette Vault",
    icon: APP_ICON_PATH,
    backgroundColor: "#0e1219",
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 14, y: 13 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    await mainWindow.loadURL(rendererUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    await mainWindow.loadFile(path.join(app.getAppPath(), "out", "index.html"));
  }
}

function registerIpc(): void {
  ipcMain.handle("vault:status", async () => withSecureStorage(vault.status()));

  ipcMain.handle("vault:setup", async (_event, masterPassword: string, rememberWithOsStorage?: boolean) => {
    requirePassword(masterPassword);
    vault.setup(masterPassword);

    if (rememberWithOsStorage) {
      await storeDerivedKey(vault.currentKeyForSecureStorage());
    }

    return withSecureStorage(vault.status());
  });

  ipcMain.handle("vault:unlock", async (_event, masterPassword: string) => {
    requirePassword(masterPassword);
    vault.unlock(masterPassword);
    return withSecureStorage(vault.status());
  });

  ipcMain.handle("vault:unlock-os", async () => {
    const key = await readDerivedKey();
    if (!key) {
      throw new Error("No OS secure storage key is available.");
    }

    return withSecureStorage(vault.unlockWithDerivedKey(key));
  });

  ipcMain.handle("vault:lock", async () => withSecureStorage(vault.lock()));

  ipcMain.handle("items:list", async (_event, filters?: ItemFilters) => {
    return vault.listItems(filtersSchema.parse(filters));
  });

  ipcMain.handle("items:create", async (_event, draft: ItemDraft) => {
    return vault.createItem(itemDraftSchema.parse(draft));
  });

  ipcMain.handle("items:update", async (_event, update: ItemUpdate) => {
    return vault.updateItem(itemUpdateSchema.parse(update));
  });

  ipcMain.handle("items:delete", async (_event, id: string) => {
    vault.deleteItem(z.string().min(1).parse(id));
  });

  ipcMain.handle("items:reveal-secret", async (_event, id: string) => {
    return vault.revealSecret(z.string().min(1).parse(id));
  });

  ipcMain.handle("attachments:pick", async () => {
    const openDialogOptions: Electron.OpenDialogOptions = {
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"] },
        { name: "All files", extensions: ["*"] }
      ]
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, openDialogOptions)
      : await dialog.showOpenDialog(openDialogOptions);

    return result.filePaths.map((filePath) => ({
      path: filePath,
      name: path.basename(filePath)
    }));
  });

  ipcMain.handle("attachments:add", async (_event, itemId: string, filePaths: string[]) => {
    return vault.addAttachments(z.string().min(1).parse(itemId), z.array(z.string()).parse(filePaths));
  });

  ipcMain.handle("attachments:preview", async (_event, attachmentId: string) => {
    return vault.attachmentPreview(z.string().min(1).parse(attachmentId));
  });

  ipcMain.handle("backup:export", async (_event, backupPassword: string) => {
    requirePassword(backupPassword);
    return vault.exportBackup(backupPassword);
  });

  ipcMain.handle("backup:import", async (_event, backupPath: string, backupPassword: string) => {
    requirePassword(backupPassword);
    vault.importBackup(z.string().min(1).parse(backupPath), backupPassword);
  });

  ipcMain.handle("settings:status", async () => settingsStatus());

  ipcMain.handle("settings:remember-os", async () => {
    await storeDerivedKey(vault.currentKeyForSecureStorage());
    return settingsStatus();
  });

  ipcMain.handle("settings:forget-os", async () => {
    await deleteStoredDerivedKey();
    return settingsStatus();
  });

  ipcMain.handle("settings:change-password", async (_event, currentPassword: string, nextPassword: string) => {
    requirePassword(currentPassword);
    requirePassword(nextPassword);
    vault.changeMasterPassword(currentPassword, nextPassword);
    if (await hasStoredDerivedKey()) {
      await storeDerivedKey(vault.currentKeyForSecureStorage());
    }
    return withSecureStorage(vault.status());
  });

  ipcMain.handle("shell:open-path", async (_event, targetPath: string) => {
    const parsed = z.string().min(1).parse(targetPath);
    const error = await shell.openPath(parsed);
    if (error) {
      throw new Error(error);
    }
  });

  ipcMain.handle("shell:open-external", async (_event, url: string) => {
    const parsed = z.string().url().parse(url);
    const protocol = new URL(parsed).protocol;
    if (!["https:", "http:"].includes(protocol)) {
      throw new Error("Only http and https links can be opened externally.");
    }
    await shell.openExternal(parsed);
  });

  ipcMain.handle("clipboard:write-text", async (_event, text: string) => {
    clipboard.writeText(z.string().parse(text));
  });

  ipcMain.handle("window:minimize", async (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    targetWindow?.minimize();
    return Boolean(targetWindow);
  });

  ipcMain.handle("window:toggle-maximize", async (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    if (!targetWindow) {
      return false;
    }
    if (targetWindow.isMaximized()) {
      targetWindow.unmaximize();
    } else {
      targetWindow.maximize();
    }
    return true;
  });

  ipcMain.handle("window:close", async (event) => {
    const targetWindow = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    targetWindow?.close();
    return Boolean(targetWindow);
  });
}

function requirePassword(value: string): void {
  if (!value || value.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
}

async function withSecureStorage(status: VaultStatus): Promise<VaultStatus> {
  return {
    ...status,
    secureStorageAvailable: Boolean(await loadKeytar())
  };
}

async function storeDerivedKey(keyBase64: string): Promise<void> {
  const keytar = await loadKeytar();
  if (!keytar) {
    throw new Error("OS secure storage is not available on this machine.");
  }
  await keytar.setPassword(SERVICE_NAME, SECURE_STORAGE_ACCOUNT, keyBase64);
}

async function readDerivedKey(): Promise<string | null> {
  const keytar = await loadKeytar();
  if (!keytar) {
    return null;
  }
  return keytar.getPassword(SERVICE_NAME, SECURE_STORAGE_ACCOUNT);
}

async function deleteStoredDerivedKey(): Promise<void> {
  const keytar = await loadKeytar();
  if (!keytar) {
    throw new Error("OS secure storage is not available on this machine.");
  }
  if (keytar.deletePassword) {
    await keytar.deletePassword(SERVICE_NAME, SECURE_STORAGE_ACCOUNT);
  } else {
    await keytar.setPassword(SERVICE_NAME, SECURE_STORAGE_ACCOUNT, "");
  }
}

async function hasStoredDerivedKey(): Promise<boolean> {
  return Boolean(await readDerivedKey());
}

async function settingsStatus(): Promise<VaultSettings> {
  return {
    osCredentialStored: await hasStoredDerivedKey()
  };
}

async function loadKeytar(): Promise<KeytarModule | null> {
  try {
    const imported = (await import("keytar")) as unknown as KeytarModule & { default?: KeytarModule };
    return imported.default ?? imported;
  } catch {
    return null;
  }
}
