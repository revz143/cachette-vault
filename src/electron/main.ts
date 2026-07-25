import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { VaultDatabase } from "./db";
import type { BackupImportRequest, ItemDraft, ItemFilters, ItemUpdate, VaultSettings } from "../shared/types";

const SERVICE_NAME = "Cachette Vault";
const APP_ICON_PATH = path.join(app.getAppPath(), "assets", "icon.ico");
const SHORTCUT_NAME = "Cachette Vault.lnk";

let mainWindow: BrowserWindow | null = null;
let vault: VaultDatabase;

const itemTypeSchema = z.enum(["note", "link", "repo", "image", "password", "private", "todo"]);
const contentFormatSchema = z.enum(["markdown", "richtext", "plain"]);
const todoEntrySchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  done: z.boolean()
});
const itemDraftSchema = z.object({
  type: itemTypeSchema,
  title: z.string().min(1).max(180),
  content: z.string().optional(),
  contentFormat: contentFormatSchema.optional(),
  todos: z.array(todoEntrySchema).optional(),
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
const backupImportSchema = z
  .object({
    backupPath: z.string().min(1),
    backupPassword: z.string().min(8),
    mode: z.enum(["replace", "merge"]),
    sourceMasterPassword: z.string().optional()
  })
  .superRefine((request, context) => {
    if (request.mode === "merge" && (!request.sourceMasterPassword || request.sourceMasterPassword.length < 8)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Source vault master password must be at least 8 characters.",
        path: ["sourceMasterPassword"]
      });
    }
  });

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
  ipcMain.handle("vault:status", async () => vault.status());

  ipcMain.handle("vault:setup", async (_event, masterPassword: string) => {
    requirePassword(masterPassword);
    return vault.setup(masterPassword);
  });

  ipcMain.handle("vault:unlock", async (_event, masterPassword: string) => {
    requirePassword(masterPassword);
    return vault.unlock(masterPassword);
  });

  ipcMain.handle("vault:recover", async (_event, recoveryKey: string, nextMasterPassword: string) => {
    if (!recoveryKey || recoveryKey.trim().length < 10) {
      throw new Error("Recovery key is required.");
    }
    requirePassword(nextMasterPassword);
    return vault.recoverWithRecoveryKey(recoveryKey, nextMasterPassword);
  });

  ipcMain.handle("vault:lock", async () => vault.lock());

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

  ipcMain.handle("backup:pick", async () => {
    const openDialogOptions: Electron.OpenDialogOptions = {
      properties: ["openFile"],
      filters: [
        { name: "Cachette backups", extensions: ["enc"] },
        { name: "All files", extensions: ["*"] }
      ]
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, openDialogOptions)
      : await dialog.showOpenDialog(openDialogOptions);
    const backupPath = result.filePaths[0];

    return backupPath ? { path: backupPath, name: path.basename(backupPath) } : null;
  });

  ipcMain.handle("backup:import", async (_event, request: BackupImportRequest) => {
    const parsed = backupImportSchema.parse(request);
    return vault.importBackup(parsed);
  });

  ipcMain.handle("settings:status", async () => settingsStatus());

  ipcMain.handle("settings:desktop-shortcut", async (_event, enabled: boolean) => {
    setDesktopShortcut(z.boolean().parse(enabled));
    return settingsStatus();
  });

  ipcMain.handle("settings:run-at-startup", async (_event, enabled: boolean) => {
    setRunAtStartup(z.boolean().parse(enabled));
    return settingsStatus();
  });

  ipcMain.handle("settings:change-password", async (_event, currentPassword: string, nextPassword: string) => {
    requirePassword(currentPassword);
    requirePassword(nextPassword);
    return vault.changeMasterPassword(currentPassword, nextPassword);
  });

  ipcMain.handle("dev:reset-onboarding", async () => {
    if (!isDevelopmentMode()) {
      throw new Error("Onboarding reset is only available in development mode.");
    }
    return vault.resetForDevelopment();
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

async function settingsStatus(): Promise<VaultSettings> {
  return {
    desktopShortcutCreated: desktopShortcutExists(),
    runAtStartup: runAtStartupEnabled(),
    developmentMode: isDevelopmentMode()
  };
}

function isDevelopmentMode(): boolean {
  return !app.isPackaged || Boolean(process.env.ELECTRON_RENDERER_URL);
}

function desktopShortcutPath(): string {
  return path.join(app.getPath("desktop"), SHORTCUT_NAME);
}

function desktopShortcutExists(): boolean {
  return process.platform === "win32" && fs.existsSync(desktopShortcutPath());
}

function launchOptions(): { target: string; args: string; cwd: string; icon: string } {
  return {
    target: process.execPath,
    args: app.isPackaged ? "" : `"${app.getAppPath()}"`,
    cwd: app.getAppPath(),
    icon: APP_ICON_PATH
  };
}

function loginItemOptions(): { path: string; args: string[] } {
  const { target, args } = launchOptions();
  return {
    path: target,
    args: args ? [args] : []
  };
}

function setDesktopShortcut(enabled: boolean): void {
  if (process.platform !== "win32") {
    throw new Error("Desktop shortcuts are currently supported on Windows only.");
  }

  const shortcutPath = desktopShortcutPath();
  if (!enabled) {
    if (desktopShortcutExists()) {
      fs.rmSync(shortcutPath, { force: true });
    }
    return;
  }

  const { target, args, cwd, icon } = launchOptions();
  const created = shell.writeShortcutLink(shortcutPath, "create", {
    target,
    args,
    cwd,
    icon,
    iconIndex: 0,
    appUserModelId: "app.cachette.vault",
    description: "Open Cachette Vault"
  });

  if (!created) {
    throw new Error("Could not create desktop shortcut.");
  }
}

function runAtStartupEnabled(): boolean {
  return app.getLoginItemSettings(loginItemOptions()).openAtLogin;
}

function setRunAtStartup(enabled: boolean): void {
  const loginItem = loginItemOptions();
  app.setLoginItemSettings({
    openAtLogin: enabled,
    enabled,
    name: SERVICE_NAME,
    path: loginItem.path,
    args: loginItem.args
  });
}
