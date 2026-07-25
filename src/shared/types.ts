export type ItemType = "note" | "link" | "repo" | "image" | "password" | "private" | "todo";

export type ItemContentFormat = "markdown" | "richtext" | "plain";

export type TodoEntry = {
  id: string;
  text: string;
  done: boolean;
};

export type VaultStatus = {
  initialized: boolean;
  unlocked: boolean;
  itemCount: number;
};

export type VaultSettings = {
  desktopShortcutCreated: boolean;
  runAtStartup: boolean;
  trayShortcut: string;
  trayShortcutRegistered: boolean;
  developmentMode: boolean;
};

export type VaultSetupResult = {
  status: VaultStatus;
  recoveryKeys: string[];
};

export type VaultRecoveryResult = {
  status: VaultStatus;
  replacementRecoveryKey: string;
};

export type AttachmentRecord = {
  id: string;
  itemId: string;
  filePath: string;
  kind: "file" | "image" | "screenshot";
  originalName: string;
  createdAt: string;
};

export type VaultItem = {
  id: string;
  type: ItemType;
  title: string;
  content: string;
  contentFormat: ItemContentFormat;
  todos?: TodoEntry[];
  url?: string;
  repoPath?: string;
  category: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  encryptedData?: Record<string, string>;
  attachments: AttachmentRecord[];
};

export type ItemDraft = {
  type: ItemType;
  title: string;
  content?: string;
  contentFormat?: ItemContentFormat;
  todos?: TodoEntry[];
  url?: string;
  repoPath?: string;
  category?: string;
  tags?: string[];
  encryptedData?: Record<string, string>;
  attachmentPaths?: string[];
};

export type ItemUpdate = Partial<Omit<ItemDraft, "attachmentPaths">> & {
  id: string;
};

export type ItemFilters = {
  search?: string;
  type?: ItemType | "all";
  category?: string;
  tag?: string;
};

export type BackupExportResult = {
  filePath: string;
};

export type BackupImportMode = "replace" | "merge";

export type BackupImportRequest = {
  backupPath: string;
  backupPassword: string;
  mode: BackupImportMode;
  sourceMasterPassword?: string;
};

export type BackupImportResult = {
  mode: BackupImportMode;
  itemCount: number;
  status: VaultStatus;
};

export type PickedFile = {
  path: string;
  name: string;
};

export type AttachmentPreview = {
  id: string;
  dataUrl: string;
  mimeType: string;
};

export type CachetteApi = {
  vaultStatus: () => Promise<VaultStatus>;
  setupVault: (masterPassword: string) => Promise<VaultSetupResult>;
  unlockVault: (masterPassword: string) => Promise<VaultStatus>;
  recoverVault: (recoveryKey: string, nextMasterPassword: string) => Promise<VaultRecoveryResult>;
  lockVault: () => Promise<VaultStatus>;
  listItems: (filters?: ItemFilters) => Promise<VaultItem[]>;
  createItem: (draft: ItemDraft) => Promise<VaultItem>;
  updateItem: (update: ItemUpdate) => Promise<VaultItem>;
  deleteItem: (id: string) => Promise<void>;
  pickAttachments: () => Promise<PickedFile[]>;
  addAttachments: (itemId: string, filePaths: string[]) => Promise<AttachmentRecord[]>;
  attachmentPreview: (attachmentId: string) => Promise<AttachmentPreview | null>;
  revealSecret: (itemId: string) => Promise<Record<string, string>>;
  exportBackup: (backupPassword: string) => Promise<BackupExportResult>;
  pickBackupFile: () => Promise<PickedFile | null>;
  importBackup: (request: BackupImportRequest) => Promise<BackupImportResult>;
  settingsStatus: () => Promise<VaultSettings>;
  setDesktopShortcut: (enabled: boolean) => Promise<VaultSettings>;
  setRunAtStartup: (enabled: boolean) => Promise<VaultSettings>;
  setTrayShortcut: (shortcut: string) => Promise<VaultSettings>;
  resetForOnboarding: () => Promise<VaultStatus>;
  changeMasterPassword: (currentPassword: string, nextPassword: string) => Promise<VaultStatus>;
  openPath: (targetPath: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  copyText: (text: string) => Promise<void>;
  windowMinimize: () => Promise<boolean>;
  windowToggleMaximize: () => Promise<boolean>;
  windowClose: () => Promise<boolean>;
};
