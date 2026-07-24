import { contextBridge, ipcRenderer } from "electron";
import type { CachetteApi, ItemDraft, ItemFilters, ItemUpdate } from "../shared/types";

const api: CachetteApi = {
  vaultStatus: () => ipcRenderer.invoke("vault:status"),
  setupVault: (masterPassword: string, rememberWithOsStorage?: boolean) =>
    ipcRenderer.invoke("vault:setup", masterPassword, rememberWithOsStorage),
  unlockVault: (masterPassword: string) => ipcRenderer.invoke("vault:unlock", masterPassword),
  unlockWithOsStorage: () => ipcRenderer.invoke("vault:unlock-os"),
  lockVault: () => ipcRenderer.invoke("vault:lock"),
  listItems: (filters?: ItemFilters) => ipcRenderer.invoke("items:list", filters),
  createItem: (draft: ItemDraft) => ipcRenderer.invoke("items:create", draft),
  updateItem: (update: ItemUpdate) => ipcRenderer.invoke("items:update", update),
  deleteItem: (id: string) => ipcRenderer.invoke("items:delete", id),
  pickAttachments: () => ipcRenderer.invoke("attachments:pick"),
  addAttachments: (itemId: string, filePaths: string[]) => ipcRenderer.invoke("attachments:add", itemId, filePaths),
  attachmentPreview: (attachmentId: string) => ipcRenderer.invoke("attachments:preview", attachmentId),
  revealSecret: (itemId: string) => ipcRenderer.invoke("items:reveal-secret", itemId),
  exportBackup: (backupPassword: string) => ipcRenderer.invoke("backup:export", backupPassword),
  importBackup: (backupPath: string, backupPassword: string) =>
    ipcRenderer.invoke("backup:import", backupPath, backupPassword),
  settingsStatus: () => ipcRenderer.invoke("settings:status"),
  rememberWithOsStorage: () => ipcRenderer.invoke("settings:remember-os"),
  forgetOsStorage: () => ipcRenderer.invoke("settings:forget-os"),
  changeMasterPassword: (currentPassword: string, nextPassword: string) =>
    ipcRenderer.invoke("settings:change-password", currentPassword, nextPassword),
  openPath: (targetPath: string) => ipcRenderer.invoke("shell:open-path", targetPath),
  openExternal: (url: string) => ipcRenderer.invoke("shell:open-external", url),
  copyText: (text: string) => ipcRenderer.invoke("clipboard:write-text", text),
  windowMinimize: () => ipcRenderer.invoke("window:minimize"),
  windowToggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  windowClose: () => ipcRenderer.invoke("window:close")
};

contextBridge.exposeInMainWorld("cachette", api);
