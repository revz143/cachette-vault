import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, safeStorage, shell, Tray } from "electron";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { VaultDatabase } from "./db";
import type { RememberStatus, VaultSettings, VaultStatus } from "../shared/types";

const SERVICE_NAME = "Cachette Vault";
const APP_ICON_PATH = path.join(app.getAppPath(), "assets", "icon.ico");
const SHORTCUT_NAME = "Cachette Vault.lnk";
const APP_SETTINGS_FILE = "cachette-settings.json";
const DEFAULT_TRAY_SHORTCUT = "CommandOrControl+Shift+L";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let vault: VaultDatabase;
let isQuitting = false;
let registeredTrayShortcut = "";

type AppSettings = {
  trayShortcut: string;
  rememberSecret?: string;
};

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
  content: z.string().max(1_000_000).optional(),
  contentFormat: contentFormatSchema.optional(),
  todos: z.array(todoEntrySchema).optional(),
  url: z.string().optional(),
  repoPath: z.string().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  encryptedData: z.record(z.string()).optional(),
  attachmentPaths: z.array(z.string()).optional()
});
const itemUpdateSchema = itemDraftSchema.omit({ attachmentPaths: true }).partial().extend({
  id: z.string().min(1)
});

// File types Windows will execute when opened via the shell; item data can be
// seeded by imported backups, so never launch these from the vault.
const BLOCKED_OPEN_EXTENSIONS = new Set([
  ".exe", ".bat", ".cmd", ".com", ".scr", ".ps1", ".psm1", ".vbs", ".vbe",
  ".js", ".jse", ".wsf", ".wsh", ".msi", ".msp", ".lnk", ".hta", ".pif", ".reg", ".jar"
]);
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

app.on("window-all-closed", () => undefined);

app.on("before-quit", () => {
  isQuitting = true;
  globalShortcut.unregisterAll();
  vault?.close();
});

app.whenReady().then(async () => {
  vault = new VaultDatabase();
  Menu.setApplicationMenu(null);
  registerIpc();
  createTray();
  registerTrayShortcut(readAppSettings().trayShortcut);
  await createWindow();
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createWindow();
  } else {
    showMainWindow();
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
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const rendererUrl = process.env.ELECTRON_RENDERER_URL;
    const allowed = rendererUrl ? url.startsWith(rendererUrl) : url.startsWith("file://");
    if (!allowed) {
      event.preventDefault();
    }
  });

  mainWindow.on("close", (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    await mainWindow.loadURL(rendererUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    await mainWindow.loadFile(path.join(app.getAppPath(), "out", "index.html"));
  }
}

function createTray(): void {
  if (tray) return;

  tray = new Tray(APP_ICON_PATH);
  tray.setToolTip("Cachette Vault");
  tray.setContextMenu(createTrayMenu());
  tray.on("click", () => {
    showMainWindow();
  });
}

function createTrayMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: "Open Cachette",
      click: () => {
        showMainWindow();
      }
    },
    {
      label: "Lock vault",
      click: () => {
        clearRemember();
        vault?.lock();
      }
    },
    { type: "separator" },
    {
      label: "Exit",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]);
}

async function toggleMainWindow(): Promise<void> {
  if (!mainWindow || !mainWindow.isVisible() || mainWindow.isMinimized()) {
    await showMainWindow();
    return;
  }

  mainWindow.hide();
}

async function showMainWindow(): Promise<void> {
  if (!mainWindow) {
    await createWindow();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

function registerTrayShortcut(shortcut: string): boolean {
  if (registeredTrayShortcut) {
    globalShortcut.unregister(registeredTrayShortcut);
    registeredTrayShortcut = "";
  }

  const normalizedShortcut = shortcut.trim();
  if (!normalizedShortcut) {
    return true;
  }

  let registered = false;
  try {
    registered = globalShortcut.register(normalizedShortcut, () => {
      void toggleMainWindow();
    });
  } catch {
    registered = false;
  }

  if (registered) {
    registeredTrayShortcut = normalizedShortcut;
  }

  return registered;
}

function registerIpc(): void {
  handle("vault:status", () => vault.status());

  handle("vault:setup", (_event, masterPassword) => vault.setup(requirePassword(masterPassword)));

  handle("vault:unlock", (_event, masterPassword) => vault.unlock(requirePassword(masterPassword)));

  handle("vault:recover", async (_event, recoveryKey, nextMasterPassword) => {
    const parsedRecoveryKey = z.string().parse(recoveryKey);
    if (parsedRecoveryKey.trim().length < 10) {
      throw new Error("Recovery key is required.");
    }
    const result = await vault.recoverWithRecoveryKey(parsedRecoveryKey, requirePassword(nextMasterPassword));
    clearRemember();
    return result;
  });

  handle("vault:lock", (_event, options) => {
    const parsed = z.object({ forget: z.boolean().optional() }).optional().parse(options);
    if (parsed?.forget) {
      clearRemember();
    }
    return vault.lock();
  });

  handle("vault:auto-unlock", () => attemptAutoUnlock());

  handle("remember:status", () => rememberStatus());

  handle("remember:enable", () => {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Secure storage is not available on this device.");
    }
    const secret = randomBytes(32);
    try {
      vault.createRememberSlot(secret);
      storeRememberSecret(secret);
    } finally {
      secret.fill(0);
    }
    return rememberStatus();
  });

  handle("remember:disable", () => {
    clearRemember();
    return rememberStatus();
  });

  handle("items:list", (_event, filters) => vault.listItems(filtersSchema.parse(filters)));

  handle("items:create", (_event, draft) => vault.createItem(itemDraftSchema.parse(draft)));

  handle("items:update", (_event, update) => vault.updateItem(itemUpdateSchema.parse(update)));

  handle("items:delete", (_event, id) => {
    vault.deleteItem(z.string().min(1).parse(id));
  });

  handle("items:reveal-secret", (_event, id) => vault.revealSecret(z.string().min(1).parse(id)));

  handle("attachments:pick", async () => {
    const result = await showOpenDialog({
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"] },
        { name: "All files", extensions: ["*"] }
      ]
    });

    return result.filePaths.map((filePath) => ({
      path: filePath,
      name: path.basename(filePath)
    }));
  });

  handle("attachments:add", (_event, itemId, filePaths) => {
    return vault.addAttachments(z.string().min(1).parse(itemId), z.array(z.string()).parse(filePaths));
  });

  handle("attachments:preview", (_event, attachmentId) => {
    return vault.attachmentPreview(z.string().min(1).parse(attachmentId));
  });

  handle("backup:export", (_event, backupPassword) => vault.exportBackup(requirePassword(backupPassword)));

  handle("backup:pick", async () => {
    const result = await showOpenDialog({
      properties: ["openFile"],
      filters: [
        { name: "Cachette backups", extensions: ["enc"] },
        { name: "All files", extensions: ["*"] }
      ]
    });
    const backupPath = result.filePaths[0];

    return backupPath ? { path: backupPath, name: path.basename(backupPath) } : null;
  });

  handle("backup:import", async (_event, request) => {
    const result = await vault.importBackup(backupImportSchema.parse(request));
    clearRemember();
    return result;
  });

  handle("settings:status", () => settingsStatus());

  handle("settings:desktop-shortcut", (_event, enabled) => {
    setDesktopShortcut(z.boolean().parse(enabled));
    return settingsStatus();
  });

  handle("settings:run-at-startup", (_event, enabled) => {
    setRunAtStartup(z.boolean().parse(enabled));
    return settingsStatus();
  });

  handle("settings:tray-shortcut", (_event, shortcut) => {
    const parsed = z.string().max(80).parse(shortcut).trim();
    const previousSettings = readAppSettings();
    const previousShortcut = previousSettings.trayShortcut;
    if (!registerTrayShortcut(parsed)) {
      registerTrayShortcut(previousShortcut);
      throw new Error("That shortcut could not be registered. Try a different combination.");
    }
    writeAppSettings({ ...previousSettings, trayShortcut: parsed });
    return settingsStatus();
  });

  handle("settings:change-password", async (_event, currentPassword, nextPassword) => {
    const status = await vault.changeMasterPassword(requirePassword(currentPassword), requirePassword(nextPassword));
    clearRemember();
    return status;
  });

  handle("dev:reset-onboarding", () => {
    if (!isDevelopmentMode()) {
      throw new Error("Onboarding reset is only available in development mode.");
    }
    const status = vault.resetForDevelopment();
    clearRemember();
    return status;
  });

  handle("shell:open-path", async (_event, targetPath) => {
    const parsed = z.string().min(1).parse(targetPath);
    const stats = fs.statSync(parsed, { throwIfNoEntry: false });
    if (!stats) {
      throw new Error("That path no longer exists.");
    }
    if (!stats.isDirectory() && BLOCKED_OPEN_EXTENSIONS.has(path.extname(parsed).toLowerCase())) {
      throw new Error("Opening executable files from the vault is not allowed.");
    }
    const error = await shell.openPath(parsed);
    if (error) {
      throw new Error(error);
    }
  });

  handle("shell:open-external", async (_event, url) => {
    const parsed = z.string().url().parse(url);
    const protocol = new URL(parsed).protocol;
    if (!["https:", "http:"].includes(protocol)) {
      throw new Error("Only http and https links can be opened externally.");
    }
    await shell.openExternal(parsed);
  });

  handle("clipboard:write-text", (_event, text) => {
    clipboard.writeText(z.string().parse(text));
  });

  handle("window:minimize", (event) => {
    const targetWindow = windowFor(event);
    targetWindow?.minimize();
    return Boolean(targetWindow);
  });

  handle("window:toggle-maximize", (event) => {
    const targetWindow = windowFor(event);
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

  handle("window:close", (event) => {
    const targetWindow = windowFor(event);
    targetWindow?.close();
    return Boolean(targetWindow);
  });
}

function handle(
  channel: string,
  handler: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown
): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    try {
      return await handler(event, ...args);
    } catch (error) {
      console.error(`[ipc:${channel}]`, error);
      throw new Error(publicErrorMessage(error));
    }
  });
}

function publicErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return "Invalid request payload.";
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Operation failed.";
}

function windowFor(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
}

async function showOpenDialog(options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
  return mainWindow ? dialog.showOpenDialog(mainWindow, options) : dialog.showOpenDialog(options);
}

function requirePassword(value: unknown): string {
  if (typeof value !== "string" || value.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
  return value;
}

async function settingsStatus(): Promise<VaultSettings> {
  const appSettings = readAppSettings();
  return {
    desktopShortcutCreated: desktopShortcutExists(),
    runAtStartup: runAtStartupEnabled(),
    trayShortcut: appSettings.trayShortcut,
    trayShortcutRegistered: !appSettings.trayShortcut || registeredTrayShortcut === appSettings.trayShortcut,
    developmentMode: isDevelopmentMode()
  };
}

function appSettingsPath(): string {
  return path.join(app.getPath("userData"), APP_SETTINGS_FILE);
}

function readAppSettings(): AppSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(appSettingsPath(), "utf8")) as Partial<AppSettings>;
    return {
      trayShortcut: typeof parsed.trayShortcut === "string" ? parsed.trayShortcut : DEFAULT_TRAY_SHORTCUT,
      rememberSecret: typeof parsed.rememberSecret === "string" ? parsed.rememberSecret : undefined
    };
  } catch {
    return { trayShortcut: DEFAULT_TRAY_SHORTCUT };
  }
}

function writeAppSettings(settings: AppSettings): void {
  fs.writeFileSync(appSettingsPath(), JSON.stringify(settings, null, 2), { mode: 0o600 });
}

function storeRememberSecret(secret: Buffer): void {
  const encrypted = safeStorage.encryptString(secret.toString("base64"));
  writeAppSettings({ ...readAppSettings(), rememberSecret: encrypted.toString("base64") });
}

function readRememberSecret(): Buffer | null {
  const { rememberSecret } = readAppSettings();
  if (!rememberSecret || !safeStorage.isEncryptionAvailable()) {
    return null;
  }
  try {
    return Buffer.from(safeStorage.decryptString(Buffer.from(rememberSecret, "base64")), "base64");
  } catch {
    return null;
  }
}

function clearRemember(): void {
  vault?.clearRememberSlot();
  const settings = readAppSettings();
  if (settings.rememberSecret) {
    delete settings.rememberSecret;
    writeAppSettings(settings);
  }
}

function rememberStatus(): RememberStatus {
  const available = safeStorage.isEncryptionAvailable();
  const slot = vault.readRememberSlot();
  if (!slot) {
    return { available, enabled: false };
  }
  if (!readAppSettings().rememberSecret) {
    clearRemember();
    return { available, enabled: false };
  }
  return { available, enabled: true };
}

function attemptAutoUnlock(): VaultStatus {
  if (vault.status().unlocked) {
    return vault.status();
  }
  const slot = vault.readRememberSlot();
  if (!slot) {
    return vault.status();
  }
  const secret = readRememberSecret();
  if (!secret) {
    clearRemember();
    return vault.status();
  }
  try {
    return vault.unlockWithRememberedKey(secret);
  } catch {
    clearRemember();
    return vault.status();
  } finally {
    secret.fill(0);
  }
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
