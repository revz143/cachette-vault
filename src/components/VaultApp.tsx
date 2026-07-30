"use client";

import {
  Check,
  Clock,
  Copy,
  Download,
  Edit3,
  ExternalLink,
  Eye,
  EyeOff,
  File,
  FileImage,
  Folder,
  FolderGit2,
  FolderPlus,
  House,
  KeyRound,
  Link2,
  Lock,
  Layers,
  ListTodo,
  Moon,
  NotebookPen,
  Plus,
  Search,
  Settings,
  Shield,
  Sun,
  Trash2,
  Upload,
  X
} from "lucide-react";
import Image from "next/image";
import type { ComponentType, FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AttachmentPreview,
  BackupImportMode,
  CachetteApi,
  ItemDraft,
  ItemFilters,
  ItemContentFormat,
  ItemType,
  ItemUpdate,
  PickedFile,
  RememberStatus,
  TodoEntry,
  VaultItem,
  VaultSettings,
  VaultStatus
} from "@/shared/types";
import { AddItemModal } from "./AddItemModal";
import { MarkdownPreview } from "./MarkdownPreview";
import { NoteContentField } from "./NoteContentField";
import { PlainTextContent, RichTextPreview } from "./RichText";
import { createTodoId, TodoListEditor } from "./TodoListEditor";
import { useClipboard } from "@/hooks/useClipboard";
import { useSecret } from "@/hooks/useSecret";
import {
  deriveRepoTitle,
  extractDroppedFiles,
  getErrorMessage,
  normalizeTagName,
  parseTags,
  validateConfirmedPassword
} from "@/lib/utils";

type Theme = "dark" | "light";
type SettingsPanel = "password" | "export" | "import" | null;
type WorkspaceView = "home" | "vault";

const TYPE_META: Record<ItemType, { label: string; icon: ComponentType<{ size?: number }>; color: string }> = {
  note: { label: "Note", icon: NotebookPen, color: "var(--tnote)" },
  link: { label: "Website", icon: Link2, color: "var(--tlink)" },
  repo: { label: "Repo", icon: FolderGit2, color: "var(--trepo)" },
  image: { label: "Image", icon: FileImage, color: "var(--timg)" },
  password: { label: "Password", icon: KeyRound, color: "var(--tpass)" },
  private: { label: "Private", icon: Shield, color: "var(--tpass)" },
  todo: { label: "Todo", icon: ListTodo, color: "var(--ttodo)" }
};

const TAG_COLORS = ["#f3bf4f", "#f286a8", "#4fd1c5", "#7aa7ff", "#b48cf2", "#4ade80"];
const ITEM_TYPE_ORDER: ItemType[] = ["note", "link", "repo", "todo", "image", "password", "private"];

export function VaultApp() {
  const [api, setApi] = useState<CachetteApi | null>(null);
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [allItems, setAllItems] = useState<VaultItem[]>([]);
  const [items, setItems] = useState<VaultItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [type, setType] = useState<ItemType | "all">("all");
  const [category, setCategory] = useState("All");
  const [tag, setTag] = useState<string | undefined>();
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("home");
  const [theme, setTheme] = useState<Theme>("dark");
  const [modalOpen, setModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPanel, setSettingsPanel] = useState<SettingsPanel>(null);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [projectCreatorOpen, setProjectCreatorOpen] = useState(false);
  const [projectDraft, setProjectDraft] = useState("");
  const [editingItem, setEditingItem] = useState<VaultItem | null>(null);
  const [customProjects, setCustomProjects] = useState<string[]>([]);
  const [customTags, setCustomTags] = useState<string[]>([]);
  const [autoLockMs, setAutoLockMs] = useState(90_000);
  const [lockLeft, setLockLeft] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [toast, setToast] = useState("");
  const [remember, setRemember] = useState<RememberStatus>({ available: false, enabled: false });

  const lockVault = useCallback(async (options?: { forget?: boolean }) => {
    if (!api) return;
    const nextStatus = await api.lockVault(options);
    setStatus(nextStatus);
    setAllItems([]);
    setItems([]);
    setSelectedId(null);
    setWorkspaceView("home");
    api.rememberStatus().then(setRemember).catch(() => undefined);
  }, [api]);

  // Purposeful locks (button, shortcut) drop the remembered session; the idle
  // timer locks without forgetting so "Resume session" stays available.
  const lockAndForget = useCallback(() => lockVault({ forget: true }), [lockVault]);

  useEffect(() => {
    const cachette = window.cachette ?? createBrowserFallbackApi();
    setApi(cachette);
    const savedTheme = window.localStorage.getItem("cachette:theme");
    if (savedTheme === "light" || savedTheme === "dark") {
      setTheme(savedTheme);
    }
    const savedAutoLock = Number(window.localStorage.getItem("cachette:auto-lock-ms"));
    if (Number.isFinite(savedAutoLock) && savedAutoLock >= 0) {
      setAutoLockMs(savedAutoLock);
    }
    setCustomProjects(readStoredList("cachette:projects"));
    setCustomTags(readStoredList("cachette:tags"));
    cachette
      .vaultStatus()
      .then(async (bootStatus) => {
        if (bootStatus.initialized && !bootStatus.unlocked) {
          try {
            bootStatus = await cachette.autoUnlock();
          } catch {
            // Fall back to the lock screen; the remembered session may be gone.
          }
        }
        setStatus(bootStatus);
        cachette.rememberStatus().then(setRemember).catch(() => undefined);
      })
      .catch((error) => showError(error, setToast));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("cachette:theme", theme);
  }, [theme]);

  useEffect(() => {
    window.localStorage.setItem("cachette:auto-lock-ms", String(autoLockMs));
  }, [autoLockMs]);

  useEffect(() => {
    window.localStorage.setItem("cachette:projects", JSON.stringify(customProjects));
  }, [customProjects]);

  useEffect(() => {
    window.localStorage.setItem("cachette:tags", JSON.stringify(customTags));
  }, [customTags]);

  useEffect(() => {
    if (!status?.unlocked || autoLockMs <= 0) {
      setLockLeft(null);
      return;
    }

    let lastActivity = Date.now();
    let timeoutId = window.setTimeout(() => void lockVault(), autoLockMs);
    const updateCountdown = () => {
      const left = Math.ceil((autoLockMs - (Date.now() - lastActivity)) / 1000);
      setLockLeft(left > 0 && left <= 15 ? left : null);
    };
    const resetTimer = () => {
      lastActivity = Date.now();
      setLockLeft(null);
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => void lockVault(), autoLockMs);
    };
    const events = ["keydown", "mousedown", "mousemove", "wheel", "touchstart"];
    const intervalId = window.setInterval(updateCountdown, 500);

    events.forEach((eventName) => window.addEventListener(eventName, resetTimer, { passive: true }));
    return () => {
      window.clearTimeout(timeoutId);
      window.clearInterval(intervalId);
      events.forEach((eventName) => window.removeEventListener(eventName, resetTimer));
    };
  }, [autoLockMs, lockVault, status?.unlocked]);

  useEffect(() => {
    if (status?.unlocked) {
      setWorkspaceView("home");
      setSelectedId(null);
    }
  }, [status?.unlocked]);

  const filters: ItemFilters = useMemo(
    () => ({
      search,
      type,
      category: category === "All" ? undefined : category,
      tag
    }),
    [category, search, tag, type]
  );

  // Sequence counter drops responses that resolve after a newer load started,
  // so fast typing in search can't leave a stale list on screen.
  const loadSeq = useRef(0);
  const filtersRef = useRef(filters);
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  const refresh = useCallback(
    async (nextFilters?: ItemFilters) => {
      if (!api) return;
      const seq = ++loadSeq.current;
      const effectiveFilters = nextFilters ?? filtersRef.current;
      const [nextAllItems, nextItems] = await Promise.all([api.listItems(), api.listItems(effectiveFilters)]);
      if (seq !== loadSeq.current) return;
      setAllItems(nextAllItems);
      setItems(nextItems);
      setSelectedId((current) =>
        current && nextItems.some((item) => item.id === current) ? current : null
      );
    },
    [api]
  );

  useEffect(() => {
    if (!status?.unlocked) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        setEditingItem(null);
        setModalOpen(true);
      }
      if (event.ctrlKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        void lockAndForget();
      }
      if (event.key === "Escape") {
        setModalOpen(false);
        setSettingsOpen(false);
        setSettingsPanel(null);
        setTagsOpen(false);
        setEditingItem(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [lockAndForget, status?.unlocked]);

  useEffect(() => {
    if (!api || !status?.unlocked) {
      setDragOver(false);
      return;
    }

    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const handleDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setDragOver(true);
    };
    const handleDragLeave = (event: DragEvent) => {
      if (!event.relatedTarget) {
        setDragOver(false);
      }
    };
    const handleDrop = async (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setDragOver(false);
      const picked = extractDroppedFiles(event.dataTransfer?.files);

      if (!picked.length) {
        setToast("Drop files from your desktop into the Electron app.");
        window.setTimeout(() => setToast(""), 2600);
        return;
      }

      try {
        const firstFile = picked[0];
        const created = await api.createItem({
          type: "image",
          title: firstFile.name.replace(/\.[^.]+$/, "") || "Dropped image",
          category: category === "All" ? "General" : category,
          content: "",
          attachmentPaths: picked.map((file) => file.path)
        });
        await refresh();
        setWorkspaceView("vault");
        setType("image");
        setSelectedId(created.id);
        setToast(picked.length === 1 ? "Image added to vault" : `${picked.length} images added to vault`);
        window.setTimeout(() => setToast(""), 2600);
      } catch (error) {
        showError(error, setToast);
      }
    };

    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("drop", handleDrop);
    return () => {
      window.removeEventListener("dragover", handleDragOver);
      window.removeEventListener("dragleave", handleDragLeave);
      window.removeEventListener("drop", handleDrop);
    };
  }, [api, category, refresh, status?.unlocked]);

  useEffect(() => {
    if (!api || !status?.unlocked) {
      return;
    }

    refresh(filters).catch((error) => showError(error, setToast));
  }, [api, filters, refresh, status?.unlocked]);

  const categories = useMemo(() => {
    const names = new Set([...customProjects, ...allItems.map((item) => item.category)]);
    return ["General", ...Array.from(names).filter((name) => name !== "General").sort()];
  }, [allItems, customProjects]);

  const sidebarCategories = useMemo(() => ["All", ...categories], [categories]);
  const tags = useMemo(() => Array.from(new Set([...customTags, ...allItems.flatMap((item) => item.tags)])).sort(), [allItems, customTags]);
  const selected = selectedId ? items.find((item) => item.id === selectedId) : undefined;

  function openSettings(panel: SettingsPanel = null) {
    setSettingsPanel(panel);
    setSettingsOpen(true);
  }

  function showHome() {
    setWorkspaceView("home");
    setCategory("All");
    setTag(undefined);
    setSearch("");
    setType("all");
    setSelectedId(null);
  }

  function showCategory(name: string) {
    setWorkspaceView("vault");
    setCategory(name);
    setTag(undefined);
    setSelectedId(null);
  }

  function showTag(name: string) {
    setWorkspaceView("vault");
    setTag(name === tag ? undefined : name);
    setCategory("All");
    setSelectedId(null);
  }

  function showItem(id: string) {
    setWorkspaceView("vault");
    setSelectedId(id);
  }

  async function handleSave(draft: ItemDraft) {
    if (!api) return;
    const created = await api.createItem(draft);
    await refresh();
    setWorkspaceView("vault");
    setSelectedId(created.id);
    flash("Saved to vault");
  }

  async function handleUpdate(update: ItemUpdate) {
    if (!api) return;
    const updated = await api.updateItem(update);
    await refresh();
    setSelectedId(updated.id);
    setEditingItem(null);
    flash("Item updated");
  }

  function addProject(name: string) {
    name = name.trim();
    if (!name) return;
    setCustomProjects((current) => Array.from(new Set([...current, name])).sort());
    setWorkspaceView("vault");
    setCategory(name);
    setTag(undefined);
    setSelectedId(null);
    setProjectDraft("");
    setProjectCreatorOpen(false);
    flash("Folder added");
  }

  function submitProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    addProject(projectDraft);
  }

  function addCustomTag(name: string) {
    name = normalizeTagName(name);
    if (!name) return;
    setCustomTags((current) => Array.from(new Set([...current, name])).sort());
    setWorkspaceView("vault");
    setTag(name);
    setCategory("All");
  }

  if (!api || !status) {
    return (
      <AppFrame>
        <LoadingShell />
      </AppFrame>
    );
  }

  if (!status.initialized) {
    return (
      <AppFrame api={api}>
        <SetupScreen api={api} onStatus={setStatus} />
      </AppFrame>
    );
  }

  if (!status.unlocked) {
    return (
      <AppFrame api={api}>
        <UnlockScreen api={api} onStatus={setStatus} status={status} remember={remember} onRememberChange={setRemember} />
      </AppFrame>
    );
  }

  return (
    <AppFrame
      api={api}
      lockLeft={lockLeft}
      onLock={lockAndForget}
      onSettings={() => openSettings()}
      onTheme={() => setTheme(theme === "dark" ? "light" : "dark")}
      onToast={flash}
      theme={theme}
      unlocked
    >
      <section className="vault-layout">
        <aside className="sidebar">
          <nav className="nav-section home-nav" aria-label="Home">
            <button
              className={workspaceView === "home" ? "nav-row is-active" : "nav-row"}
              onClick={showHome}
              type="button"
            >
              <House size={15} />
              <span>Home</span>
            </button>
          </nav>

          <nav className="nav-section" aria-label="Categories">
            <div className="nav-section-head">
              <span className="eyebrow">Projects</span>
              <button className="nav-add-button" type="button" onClick={() => setProjectCreatorOpen((open) => !open)} aria-label="Add folder">
                <FolderPlus size={14} />
              </button>
            </div>
            {projectCreatorOpen && (
              <form className="project-create-row" onSubmit={submitProject}>
                <input
                  autoFocus
                  value={projectDraft}
                  onChange={(event) => setProjectDraft(event.target.value)}
                  placeholder="New folder name"
                />
                <button className="primary-button" type="submit">Add</button>
              </form>
            )}
            {sidebarCategories.map((name) => {
              const ProjectIcon = name === "All" ? Layers : Folder;
              const projectLabel = name === "All" ? "All items" : name;

              return (
                <button
                  key={name}
                  className={workspaceView === "vault" && name === category && !tag ? "nav-row is-active" : "nav-row"}
                  onClick={() => showCategory(name)}
                >
                  <ProjectIcon size={15} />
                  <span>{projectLabel}</span>
                  <em>{name === "All" ? allItems.length : allItems.filter((item) => item.category === name).length}</em>
                </button>
              );
            })}
          </nav>

          <nav className="nav-section" aria-label="Tags">
            <div className="nav-section-head">
              <span className="eyebrow">Tags</span>
              <button className="nav-add-button" type="button" onClick={() => setTagsOpen(true)} aria-label="Manage tags">
                <Settings size={14} />
              </button>
            </div>
            {tags.length === 0 && <p className="empty-copy compact">Tags appear here as you add items.</p>}
            {tags.map((name) => (
              <button
                key={name}
                className={workspaceView === "vault" && name === tag ? "nav-row tag-row is-active" : "nav-row tag-row"}
                onClick={() => showTag(name)}
              >
                <span className="tag-dot" style={{ background: tagColor(name) }} />
                <span>{name}</span>
                <em>{allItems.filter((item) => item.tags.includes(name)).length}</em>
              </button>
            ))}
          </nav>

          <div className="sidebar-summary">
              <Shield size={20} />
              <div>
                <strong>Local vault</strong>
                <span>{allItems.length} items - encrypted</span>
              </div>
            </div>
        </aside>

        {workspaceView === "home" ? (
          <VaultHomeDashboard
            allItems={allItems}
            category={category}
            categories={categories}
            items={allItems}
            onAdd={() => setModalOpen(true)}
            onImport={() => openSettings("import")}
            onLock={lockAndForget}
            onSelectCategory={showCategory}
            onSelectItem={showItem}
            onSelectTag={showTag}
            tag={tag}
            tags={tags}
          />
        ) : (
          <>
            <section className="list-pane">
              <div className="list-tools">
                <div className="search-row">
                  <Search size={17} />
                  <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search titles, tags, content..." />
                </div>
                <button className="primary-button new-button" onClick={() => setModalOpen(true)} title="Quick add">
                  <Plus size={15} />
                  New
                </button>
              </div>

              <div className="type-tabs">
                {(["all", "note", "link", "repo", "todo", "image", "password", "private"] as Array<ItemType | "all">).map((value) => (
                  <button key={value} className={value === type ? "chip is-active" : "chip"} onClick={() => setType(value)}>
                    {value === "all" ? "All" : TYPE_META[value].label}
                  </button>
                ))}
              </div>

              <div className="list-heading">
                <strong>{items.length} items - {tag ? `#${tag}` : category === "All" ? "All items" : category}</strong>
              </div>

              <div className="item-list">
                {items.length === 0 && <EmptyList onAdd={() => setModalOpen(true)} />}
                {items.map((item) => (
                  <ItemRow key={item.id} item={item} active={item.id === selected?.id} onClick={() => showItem(item.id)} />
                ))}
              </div>
            </section>

            <DetailPane
              api={api}
              item={selected}
              onEdit={setEditingItem}
              onChanged={async () => {
                await refresh();
                flash("Vault updated");
              }}
              onToast={flash}
            />
          </>
        )}
      </section>

      {modalOpen && <AddItemModal api={api} categories={categories} onClose={() => setModalOpen(false)} onSave={handleSave} />}
      {editingItem && (
        <EditItemModal
          api={api}
          categories={categories}
          item={editingItem}
          onClose={() => setEditingItem(null)}
          onSave={handleUpdate}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          api={api}
          autoLockMs={autoLockMs}
          initialPanel={settingsPanel}
          onAutoLockMs={setAutoLockMs}
          onClose={() => {
            setSettingsOpen(false);
            setSettingsPanel(null);
          }}
          onImported={async (nextStatus) => {
            setStatus(nextStatus);
            setSelectedId(null);
            if (nextStatus.unlocked) {
              await refresh();
            } else {
              setAllItems([]);
              setItems([]);
              setSettingsOpen(false);
              setSettingsPanel(null);
            }
          }}
          onStatus={setStatus}
          remember={remember}
          onRememberChange={setRemember}
          onResetForOnboarding={async () => {
            const nextStatus = await api.resetForOnboarding();
            setAllItems([]);
            setItems([]);
            setSelectedId(null);
            setCategory("All");
            setTag(undefined);
            setCustomProjects([]);
            setCustomTags([]);
            setSettingsOpen(false);
            setStatus(nextStatus);
          }}
          onTheme={setTheme}
          onToast={flash}
          theme={theme}
        />
      )}
      {tagsOpen && (
        <TagManagerModal
          customTags={customTags}
          items={allItems}
          onClose={() => setTagsOpen(false)}
          onCreate={addCustomTag}
          onRemove={(name) => {
            setCustomTags((current) => current.filter((item) => item !== name));
            if (tag === name) {
              setTag(undefined);
            }
          }}
        />
      )}
      {dragOver && <DropOverlay />}
      {toast && (
        <div className="toast">
          <Check size={14} />
          {toast}
        </div>
      )}
    </AppFrame>
  );

  function flash(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }
}

function AppFrame({
  api,
  children,
  lockLeft,
  onLock,
  onSettings,
  onTheme,
  onToast,
  theme,
  unlocked = false
}: {
  api?: CachetteApi | null;
  children: ReactNode;
  lockLeft?: number | null;
  onLock?: () => void | Promise<void>;
  onSettings?: () => void;
  onTheme?: () => void;
  onToast?: (message: string) => void;
  theme?: Theme;
  unlocked?: boolean;
}) {
  async function runWindowAction(action?: () => Promise<boolean>) {
    if (!action) {
      onToast?.("Window controls are available in the desktop app.");
      return;
    }

    try {
      const handled = await action();
      if (!handled) {
        onToast?.("Window controls are available in the desktop app.");
      }
    } catch (error) {
      onToast?.(getErrorMessage(error, "Window action failed."));
    }
  }

  return (
    <main className="app-shell">
      <header className="titlebar">
        <div className="titlebar-brand">
          <LogoMark className="brand-mark" />
          <strong>Cachette</strong>
          <span>local vault</span>
        </div>
        <div className="titlebar-spacer" />
        {unlocked && (
          <div className="titlebar-actions">
            {lockLeft !== null && lockLeft !== undefined && (
              <div className="lock-countdown" role="status">
                <Clock size={13} />
                Auto-lock in {lockLeft}s
              </div>
            )}
            <button className="icon-button" onClick={onTheme} title="Toggle theme" type="button" aria-label="Toggle theme">
              {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            </button>
            <button className="icon-button" onClick={onSettings} title="Settings" type="button" aria-label="Open settings">
              <Settings size={17} />
            </button>
            <button className="icon-button lock-action" onClick={onLock} title="Lock vault (Ctrl+L)" type="button" aria-label="Lock vault">
              <Lock size={17} />
            </button>
          </div>
        )}
        <div className="window-controls">
          <button
            className="window-minimize"
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => void runWindowAction(api?.windowMinimize)}
            aria-label="Minimize window"
          />
          <button
            className="window-maximize"
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => void runWindowAction(api?.windowToggleMaximize)}
            aria-label="Maximize window"
          />
          <button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => void runWindowAction(api?.windowClose)}
            aria-label="Close window"
          >
            <X size={15} />
          </button>
        </div>
      </header>
      <div className="app-content">{children}</div>
    </main>
  );
}

function TagManagerModal({
  customTags,
  items,
  onClose,
  onCreate,
  onRemove
}: {
  customTags: string[];
  items: VaultItem[];
  onClose: () => void;
  onCreate: (name: string) => void;
  onRemove: (name: string) => void;
}) {
  const [newTag, setNewTag] = useState("");
  const allTags = useMemo(() => Array.from(new Set([...customTags, ...items.flatMap((item) => item.tags)])).sort(), [customTags, items]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = normalizeTagName(newTag);
    if (!name) return;
    onCreate(name);
    setNewTag("");
  }

  return (
    <div className="modal-backdrop tags-backdrop" role="presentation">
      <section className="tags-sheet" role="dialog" aria-modal="true" aria-label="Manage tags">
        <div className="modal-head">
          <strong>Manage tags</strong>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close tags">
            <X size={17} />
          </button>
        </div>
        <div className="tags-body">
          {allTags.length === 0 && <p className="empty-copy compact">Tags appear here as you add items.</p>}
          {allTags.map((name) => {
            const isCustom = customTags.includes(name);
            return (
              <div className="tag-manager-row" key={name}>
                <span className="tag-dot" style={{ background: tagColor(name) }} />
                <span>{name}</span>
                <small>{items.filter((item) => item.tags.includes(name)).length} items</small>
                <button
                  className="tag-delete-button"
                  disabled={!isCustom}
                  onClick={() => onRemove(name)}
                  title={isCustom ? "Delete tag" : "Tags attached to items are kept with those items"}
                  type="button"
                  aria-label={`Delete ${name}`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
          <form className="tag-create-row" onSubmit={submit}>
            <input value={newTag} onChange={(event) => setNewTag(event.target.value)} placeholder="New tag name" />
            <button className="primary-button" type="submit">Add</button>
          </form>
        </div>
      </section>
    </div>
  );
}

function DropOverlay() {
  return (
    <div className="drop-overlay" aria-hidden="true">
      <div>
        <Upload size={32} />
        <strong>Drop to add to your vault</strong>
        <span>Images become items in the current project</span>
      </div>
    </div>
  );
}

function ItemRow({ item, active, onClick }: { item: VaultItem; active: boolean; onClick: () => void }) {
  const Icon = TYPE_META[item.type].icon;
  const meta = [
    TYPE_META[item.type].label,
    item.category,
    ...item.tags,
    formatRelativeTime(item.updatedAt)
  ];
  const locked = item.type === "password" || item.type === "private" || Boolean(item.encryptedData);

  return (
    <button className={active ? "item-row is-active" : "item-row"} onClick={onClick}>
      <span className="type-dot" style={{ color: TYPE_META[item.type].color }}>
        <Icon size={17} />
      </span>
      <span className="item-row-copy">
        <strong>{item.title}</strong>
        <small>{meta.join(" - ")}</small>
      </span>
      {locked && (
        <span className="item-row-lock" aria-label="Encrypted item">
          <Lock size={13} />
        </span>
      )}
    </button>
  );
}

function DetailPane({
  api,
  item,
  onEdit,
  onChanged,
  onToast
}: {
  api: CachetteApi;
  item?: VaultItem;
  onEdit: (item: VaultItem) => void;
  onChanged: () => Promise<void>;
  onToast: (message: string) => void;
}) {
  const { secret, load: loadSecret, clear: clearSecret } = useSecret(api, item?.id);
  const [revealed, setRevealed] = useState(false);
  const [previews, setPreviews] = useState<Record<string, AttachmentPreview>>({});
  const copy = useClipboard(api, onToast);

  useEffect(() => {
    setRevealed(false);
    setPreviews({});
  }, [item?.id]);

  useEffect(() => {
    if (!item) return;
    let cancelled = false;
    const imageAttachments = item.attachments.filter((attachment) => attachment.kind !== "file");

    Promise.all(
      imageAttachments.map((attachment) =>
        api
          .attachmentPreview(attachment.id)
          .then((preview) => [attachment.id, preview] as const)
          .catch(() => [attachment.id, null] as const)
      )
    ).then((results) => {
      if (cancelled) return;
      const nextPreviews: Record<string, AttachmentPreview> = {};
      for (const [id, preview] of results) {
        if (preview) nextPreviews[id] = preview;
      }
      setPreviews(nextPreviews);
    });

    return () => {
      cancelled = true;
    };
  }, [api, item]);

  if (!item) {
    return (
      <section className="detail-pane centered">
        <Shield size={34} />
        <h2>Select an item</h2>
        <p className="empty-copy">Choose something from the list to inspect or edit it.</p>
      </section>
    );
  }

  const Icon = TYPE_META[item.type].icon;

  async function reveal() {
    if (!item) return;
    if (revealed) {
      setRevealed(false);
      clearSecret();
      return;
    }

    try {
      await loadSecret();
      setRevealed(true);
    } catch (error) {
      onToast(getErrorMessage(error, "Could not reveal encrypted fields."));
    }
  }

  async function remove() {
    if (!item || !window.confirm(`Delete "${item.title}"?`)) return;
    try {
      await api.deleteItem(item.id);
      await onChanged();
    } catch (error) {
      onToast(getErrorMessage(error, "Could not delete this item."));
    }
  }

  async function openPrimaryTarget() {
    if (!item) return;
    if (item.url) {
      await openTarget(item.url);
      return;
    }
    if (item.repoPath) {
      await openTarget(item.repoPath);
    }
  }

  async function openTarget(target: string) {
    try {
      if (/^https?:\/\//i.test(target)) {
        await api.openExternal(target);
        return;
      }
      await api.openPath(target);
    } catch (error) {
      onToast(getErrorMessage(error, "Could not open this target."));
    }
  }

  function copyText(text: string, message = "Copied") {
    void copy(text, { message });
  }

  async function toggleTodo(todoId: string, done: boolean) {
    if (!item?.todos) return;
    const todos = item.todos.map((todo) => (todo.id === todoId ? { ...todo, done } : todo));
    await api.updateItem({ id: item.id, todos });
    await onChanged();
  }

  const primaryTarget = item.url ?? item.repoPath;
  const imageAttachments = item.attachments.filter((attachment) => attachment.kind !== "file");
  const heroAttachment = imageAttachments[0];
  const heroPreview = heroAttachment ? previews[heroAttachment.id] : undefined;
  const legacyRepoRemote = item.type === "repo" ? extractLegacyRepoRemote(item.content) : undefined;
  const repoTargets = item.type === "repo" ? uniqueStrings([item.repoPath, item.url, legacyRepoRemote]) : [];
  const detailContent = item.type === "repo" ? stripLegacyRepoRemote(item.content) : item.content;
  const showGenericAttachments = item.type !== "password";
  const todos = item.todos ?? [];

  return (
    <section className="detail-pane">
      <div className="detail-head">
        <span className="detail-icon" style={{ color: TYPE_META[item.type].color }}>
          <Icon size={22} />
        </span>
        <div className="detail-title-block">
          <span className="eyebrow" style={{ color: TYPE_META[item.type].color }}>{TYPE_META[item.type].label}</span>
          <h1>{item.title}</h1>
          <div className="detail-meta-row">
            <span>{item.category} - updated {formatRelativeTime(item.updatedAt)}</span>
            {item.tags.map((tag) => (
              <span className="header-tag" key={tag} style={{ color: tagColor(tag) }}>
                <span className="tag-dot" />
                {tag}
              </span>
            ))}
          </div>
        </div>
        <div className="detail-actions">
          <button className="icon-button detail-action-button" onClick={() => onEdit(item)} aria-label="Edit item">
            <Edit3 size={17} />
          </button>
          <button className="icon-button detail-action-button danger" onClick={remove} aria-label="Delete item">
            <Trash2 size={17} />
          </button>
        </div>
      </div>

      {item.type === "repo" && repoTargets.length > 0 && (
        <div className="repo-targets">
          {repoTargets.map((target) => (
            <div className="target-row" key={target}>
              <FolderGit2 size={16} />
              <span>{target}</span>
              <button className="mini-button" type="button" onClick={() => copyText(target, "Path copied")}>
                <Copy size={14} />
                Copy
              </button>
              <button className="mini-button" type="button" onClick={() => openTarget(target)}>
                <ExternalLink size={14} />
                Open
              </button>
            </div>
          ))}
        </div>
      )}

      {item.type === "password" && (
        <PasswordDetail api={api} item={item} onToast={onToast} />
      )}

      {item.type !== "repo" && item.type !== "password" && primaryTarget && (
        <div className="target-row">
          <ExternalLink size={16} />
          <span>{primaryTarget}</span>
          <button className="mini-button" type="button" onClick={() => copyText(primaryTarget, "Link copied")}>
            <Copy size={14} />
            Copy
          </button>
          <button className="mini-button" type="button" onClick={openPrimaryTarget}>
            <ExternalLink size={14} />
            Open
          </button>
        </div>
      )}

      {item.type === "image" && (
        <div className="image-preview-card">
          <div className="image-preview-stage">
            {heroPreview ? (
              <Image src={heroPreview.dataUrl} alt={heroAttachment.originalName} width={1200} height={720} unoptimized />
            ) : (
              <div className="image-preview-empty">
                <FileImage size={32} />
                <strong>{heroAttachment?.originalName ?? "No image attached"}</strong>
                <span>{heroAttachment ? "Preview loading..." : "Add an image to show a preview."}</span>
              </div>
            )}
          </div>
          {heroAttachment && (
            <div className="image-preview-meta">
              <span>File · {heroAttachment.originalName}</span>
              <span>Source · Local attachment</span>
            </div>
          )}
        </div>
      )}

      {item.encryptedData && item.type !== "password" && (
        <div className="secret-panel">
          <div>
            <strong>Encrypted fields</strong>
            <span>Decrypted in memory only after reveal.</span>
          </div>
          <button className="secondary-button" onClick={reveal}>
            {revealed ? <EyeOff size={15} /> : <Eye size={15} />}
            {revealed ? "Hide" : "Reveal"}
          </button>
          {revealed && secret && (
            <dl className="secret-grid">
              {Object.entries(secret).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{value || "-"}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}

      {item.type === "todo" && <TodoDetail todos={todos} onToggle={toggleTodo} />}

      {item.type !== "password" && item.type !== "todo" && (
        item.type === "note" ? (
          item.contentFormat === "richtext" ? <RichTextPreview html={item.content} /> : <MarkdownPreview markdown={item.content} />
        ) : (
          <PlainTextContent text={detailContent} />
        )
      )}

      {showGenericAttachments && item.attachments.length > 0 && (
        <div className="attachments">
          <span className="eyebrow">Attachments</span>
          {item.attachments.map((attachment) => (
            <div key={attachment.id} className="attachment-row">
              {previews[attachment.id] ? (
                <Image className="attachment-thumb" src={previews[attachment.id].dataUrl} alt="" width={36} height={28} unoptimized />
              ) : attachment.kind === "file" ? (
                <File size={16} />
              ) : (
                <FileImage size={16} />
              )}
              <span>{attachment.originalName}</span>
              <button className="mini-button" type="button" onClick={() => copyText(attachment.filePath, "Path copied")}>
                <Copy size={14} />
                Copy
              </button>
              <button className="mini-button" type="button" onClick={() => void openTarget(attachment.filePath)}>
                <ExternalLink size={14} />
                Open
              </button>
            </div>
          ))}
        </div>
      )}

    </section>
  );
}

function VaultHomeDashboard({
  allItems,
  category,
  categories,
  items,
  onAdd,
  onImport,
  onLock,
  onSelectCategory,
  onSelectItem,
  onSelectTag,
  tag,
  tags
}: {
  allItems: VaultItem[];
  category: string;
  categories: string[];
  items: VaultItem[];
  onAdd: () => void;
  onImport: () => void;
  onLock: () => void | Promise<void>;
  onSelectCategory: (name: string) => void;
  onSelectItem: (id: string) => void;
  onSelectTag: (name: string) => void;
  tag?: string;
  tags: string[];
}) {
  const recentItems = [...allItems]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 5);
  const sensitiveCount = allItems.filter(isSensitiveItem).length;
  const filteredLabel = tag ? `#${tag}` : category === "All" ? "all items" : category;
  const projectShortcuts = categories.slice(0, 6);
  const tagShortcuts = tags.slice(0, 8);

  return (
    <section className="detail-pane vault-home" aria-label="Vault home">
      <div className="home-hero">
        <div className="home-mascot-badge" aria-hidden="true">
          <MascotMark className="home-mascot" />
        </div>
        <div className="home-hero-copy">
          <span className="eyebrow">Vault home</span>
          <h1>Vault Home</h1>
          <p>{allItems.length} items sealed locally. Showing {items.length} from {filteredLabel}.</p>
          <div className="home-actions">
            <button className="primary-button" type="button" onClick={onAdd}>
              <Plus size={15} />
              New item
            </button>
            <button className="secondary-button" type="button" onClick={onImport}>
              <Upload size={15} />
              Import backup
            </button>
            <button className="secondary-button" type="button" onClick={() => void onLock()}>
              <Lock size={15} />
              Lock vault
            </button>
          </div>
        </div>
        <div className="home-hero-stats" aria-label="Vault quick stats">
          <div>
            <span>Total</span>
            <strong>{allItems.length}</strong>
          </div>
          <div>
            <span>Sensitive</span>
            <strong>{sensitiveCount}</strong>
          </div>
        </div>
      </div>

      <div className="home-metrics" aria-label="Vault summary">
        <div>
          <span>Total items</span>
          <strong>{allItems.length}</strong>
        </div>
        <div>
          <span>Current view</span>
          <strong>{items.length}</strong>
        </div>
        <div>
          <span>Sensitive</span>
          <strong>{sensitiveCount}</strong>
        </div>
      </div>

      <div className="home-grid">
        <section className="home-section home-section-wide">
          <div className="home-section-head">
            <span className="eyebrow">Recent</span>
            <button className="mini-button" type="button" onClick={onAdd}>
              <Plus size={14} />
              Add
            </button>
          </div>
          <div className="home-recent-list">
            {recentItems.length === 0 && (
              <div className="home-empty-state">
                <Shield size={24} />
                <strong>Nothing sealed yet</strong>
                <span>Add your first note, link, repo, todo, image, or password.</span>
              </div>
            )}
            {recentItems.map((recentItem) => {
              const Icon = TYPE_META[recentItem.type].icon;
              return (
                <button className="home-recent-item" key={recentItem.id} type="button" onClick={() => onSelectItem(recentItem.id)}>
                  <span className="type-dot" style={{ color: TYPE_META[recentItem.type].color }}>
                    <Icon size={16} />
                  </span>
                  <span>
                    <strong>{recentItem.title}</strong>
                    <small>{TYPE_META[recentItem.type].label} - {recentItem.category} - {formatRelativeTime(recentItem.updatedAt)}</small>
                  </span>
                  {isSensitiveItem(recentItem) && <Lock size={13} />}
                </button>
              );
            })}
          </div>
        </section>

        <section className="home-section">
          <div className="home-section-head">
            <span className="eyebrow">Types</span>
          </div>
          <div className="home-type-grid">
            {ITEM_TYPE_ORDER.map((itemType) => {
              const Icon = TYPE_META[itemType].icon;
              const count = allItems.filter((item) => item.type === itemType).length;
              return (
                <div className="home-type-tile" key={itemType} style={{ color: TYPE_META[itemType].color }}>
                  <Icon size={16} />
                  <span>{TYPE_META[itemType].label}</span>
                  <strong>{count}</strong>
                </div>
              );
            })}
          </div>
        </section>

        <section className="home-section">
          <div className="home-section-head">
            <span className="eyebrow">Security</span>
          </div>
          <div className="home-status-list">
            <div><Shield size={15} /><span>AES-256-GCM</span><strong>On disk</strong></div>
            <div><KeyRound size={15} /><span>PBKDF2</span><strong>600k</strong></div>
            <div><Lock size={15} /><span>Vault key</span><strong>Wrapped</strong></div>
          </div>
        </section>

        <section className="home-section">
          <div className="home-section-head">
            <span className="eyebrow">Projects</span>
          </div>
          <div className="home-shortcuts">
            <button className={category === "All" && !tag ? "is-active" : ""} type="button" onClick={() => onSelectCategory("All")}>
              All items
            </button>
            {projectShortcuts.map((name) => (
              <button key={name} className={category === name && !tag ? "is-active" : ""} type="button" onClick={() => onSelectCategory(name)}>
                {name}
              </button>
            ))}
          </div>
        </section>

        <section className="home-section">
          <div className="home-section-head">
            <span className="eyebrow">Tags</span>
          </div>
          <div className="home-shortcuts">
            {tagShortcuts.length === 0 && <span className="home-muted">No tags yet</span>}
            {tagShortcuts.map((name) => (
              <button key={name} className={tag === name ? "is-active" : ""} type="button" onClick={() => onSelectTag(name)}>
                <span className="tag-dot" style={{ background: tagColor(name) }} />
                {name}
              </button>
            ))}
          </div>
        </section>

        <section className="home-section home-backup-note">
          <div>
            <span className="eyebrow">Backup</span>
            <strong>Encrypted exports stay portable.</strong>
            <p>Create or import a sealed `.enc` backup whenever this vault needs to move machines.</p>
          </div>
          <button className="mini-button" type="button" onClick={onImport}>
            <Download size={14} />
            Open
          </button>
        </section>
      </div>
    </section>
  );
}

function TodoDetail({ todos, onToggle }: { todos: TodoEntry[]; onToggle: (todoId: string, done: boolean) => Promise<void> }) {
  const doneCount = todos.filter((todo) => todo.done).length;

  if (!todos.length) {
    return <p className="empty-copy">No tasks added yet.</p>;
  }

  return (
    <div className="todo-detail">
      <div className="todo-progress">
        <span>{doneCount} of {todos.length} done</span>
        <strong>{Math.round((doneCount / todos.length) * 100)}%</strong>
      </div>
      <div className="todo-detail-list">
        {todos.map((todo) => (
          <label className={todo.done ? "todo-detail-row is-done" : "todo-detail-row"} key={todo.id}>
            <input type="checkbox" checked={todo.done} onChange={(event) => void onToggle(todo.id, event.target.checked)} />
            <span>{todo.text}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function PasswordDetail({ api, item, onToast }: { api: CachetteApi; item: VaultItem; onToast: (message: string) => void }) {
  const { secret, load: loadSecret } = useSecret(api, item.id);
  const [visible, setVisible] = useState(false);
  const copy = useClipboard(api, onToast);

  useEffect(() => {
    loadSecret().catch((error) => onToast(getErrorMessage(error, "Could not load password.")));
  }, [loadSecret, onToast]);

  function copySecret(value: string, label: string) {
    void copy(value, { message: `${label} copied`, clearAfterMs: 15_000 });
  }

  function openWebsite() {
    if (!item.url) return;
    api.openExternal(item.url).catch((error) => onToast(getErrorMessage(error, "Could not open website.")));
  }

  const username = secret?.username ?? "";
  const password = secret?.password ?? "";
  const notes = secret?.notes || item.content;

  return (
    <div className="password-detail">
      <div className="credential-card">
        <div className="credential-row">
          <span>Username</span>
          <strong>{username || "-"}</strong>
          <button className="mini-button" type="button" onClick={() => copySecret(username, "Username")} disabled={!username}>
            <Copy size={14} />
            Copy
          </button>
        </div>
        <div className="credential-row">
          <span>Password</span>
          <strong className={visible ? "credential-password" : "credential-password is-hidden"}>{password || "-"}</strong>
          <button className="mini-button icon-only" type="button" onClick={() => setVisible((current) => !current)} aria-label={visible ? "Hide password" : "Show password"}>
            {visible ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
          <button className="mini-button" type="button" onClick={() => copySecret(password, "Password")} disabled={!password}>
            <Copy size={14} />
            Copy
          </button>
        </div>
        {item.url && (
          <div className="credential-row">
            <span>Website</span>
            <button className="credential-link" type="button" onClick={openWebsite}>{item.url}</button>
          </div>
        )}
      </div>

      <p className="encrypted-note">
        <Shield size={15} />
        <span>Encrypted at rest with AES-256-GCM · copied secrets clear from the clipboard after 15s</span>
      </p>

      {notes && (
        <div className="password-notes">
          <span className="eyebrow">Notes</span>
          <p className="multiline-copy">{notes}</p>
        </div>
      )}
    </div>
  );
}

function EditItemModal({
  api,
  categories,
  item,
  onClose,
  onSave
}: {
  api: CachetteApi;
  categories: string[];
  item: VaultItem;
  onClose: () => void;
  onSave: (update: ItemUpdate) => Promise<void>;
}) {
  const [title, setTitle] = useState(item.title);
  const [category, setCategory] = useState(item.category);
  const [tagsText, setTagsText] = useState(item.tags.join(", "));
  const [content, setContent] = useState(item.content);
  const [url, setUrl] = useState(item.url ?? "");
  const [repoPath, setRepoPath] = useState(item.repoPath ?? "");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [secretNotes, setSecretNotes] = useState("");
  const [noteMode, setNoteMode] = useState<"write" | "preview">("write");
  const [noteFormat, setNoteFormat] = useState<Extract<ItemContentFormat, "markdown" | "richtext">>(
    item.contentFormat === "richtext" ? "richtext" : "markdown"
  );
  const [todos, setTodos] = useState<TodoEntry[]>(item.todos?.length ? item.todos : [{ id: createTodoId(), text: "", done: false }]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const encryptedFieldsDirty = useRef(false);

  useEffect(() => {
    let cancelled = false;
    if (!item.encryptedData) return;
    api
      .revealSecret(item.id)
      .then((secret) => {
        if (cancelled || encryptedFieldsDirty.current) return;
        setUsername(secret.username ?? "");
        setPassword(secret.password ?? "");
        setSecretNotes(secret.notes ?? "");
      })
      .catch((revealError) => setError(getErrorMessage(revealError, "Could not load encrypted fields.")));
    return () => {
      cancelled = true;
    };
  }, [api, item.encryptedData, item.id]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const tags = parseTags(tagsText);
    const nextTitle = title.trim() || (item.type === "repo" ? deriveRepoTitle(repoPath || url) : "");

    if (!nextTitle) {
      setError("Add a title before saving.");
      return;
    }

    const update: ItemUpdate = {
      id: item.id,
      title: nextTitle,
      category,
      tags,
      content,
      contentFormat: item.type === "note" ? noteFormat : "plain",
      todos: item.type === "todo" ? todos.filter((todo) => todo.text.trim()).map((todo) => ({ ...todo, text: todo.text.trim() })) : undefined,
      url: item.type === "link" || item.type === "password" || item.type === "repo" ? url : undefined,
      repoPath: item.type === "repo" ? repoPath : undefined
    };

    if (item.encryptedData) {
      update.encryptedData = { username, password, notes: secretNotes };
    }

    setSaving(true);
    try {
      await onSave(update);
    } catch (saveError) {
      setError(getErrorMessage(saveError, "Could not update this item."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className={`modal-sheet${item.type === "note" ? " modal-sheet--wide" : ""}`} onSubmit={submit}>
        <div className="modal-head">
          <strong>Edit {TYPE_META[item.type].label.toLowerCase()}</strong>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close modal">
            <X size={18} />
          </button>
        </div>

        <div className="quick-form">
          <label>
            <span>Title</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Item title" />
          </label>

          {item.type === "note" && (
            <NoteContentField
              value={content}
              contentFormat={noteFormat}
              mode={noteMode}
              onChange={setContent}
              onContentFormatChange={setNoteFormat}
              onModeChange={setNoteMode}
              rows={7}
            />
          )}

          {item.type === "link" && (
            <>
              <label>
                <span>URL</span>
                <input className="mono-input" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" />
              </label>
              <label>
                <span>Description</span>
                <textarea value={content} onChange={(event) => setContent(event.target.value)} rows={4} placeholder="Why is this worth keeping?" />
              </label>
            </>
          )}

          {item.type === "repo" && (
            <>
              <label>
                <span>Local path</span>
                <input className="mono-input" value={repoPath} onChange={(event) => setRepoPath(event.target.value)} placeholder="C:\\dev\\my-project" />
              </label>
              <label>
                <span>Remote URL</span>
                <input className="mono-input" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://github.com/..." />
              </label>
              <label>
                <span>Notes</span>
                <textarea value={content} onChange={(event) => setContent(event.target.value)} rows={4} placeholder="Repo notes" />
              </label>
            </>
          )}

          {item.type === "todo" && <TodoListEditor value={todos} onChange={setTodos} />}

          {item.encryptedData && (
            <>
              <label>
                <span>Username</span>
                <input
                  className="mono-input"
                  value={username}
                  onChange={(event) => {
                    encryptedFieldsDirty.current = true;
                    setUsername(event.target.value);
                  }}
                />
              </label>
              <label>
                <span>Password</span>
                <input
                  className="mono-input"
                  type="password"
                  value={password}
                  onChange={(event) => {
                    encryptedFieldsDirty.current = true;
                    setPassword(event.target.value);
                  }}
                />
              </label>
              <label>
                <span>Secret notes</span>
                <textarea
                  value={secretNotes}
                  onChange={(event) => {
                    encryptedFieldsDirty.current = true;
                    setSecretNotes(event.target.value);
                  }}
                  rows={4}
                />
              </label>
              {item.type === "password" && (
                <label>
                  <span>Website</span>
                  <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" />
                </label>
              )}
            </>
          )}

          {item.type !== "note" && item.type !== "link" && item.type !== "repo" && item.type !== "todo" && !item.encryptedData && (
            <label>
              <span>Notes</span>
              <textarea value={content} onChange={(event) => setContent(event.target.value)} rows={5} />
            </label>
          )}

          <div className="quick-meta-grid">
            <label>
              <span>Project</span>
              <select value={category} onChange={(event) => setCategory(event.target.value)}>
                {categories.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Tags <em>comma-separated</em></span>
              <input value={tagsText} onChange={(event) => setTagsText(event.target.value)} placeholder="design, infra" />
            </label>
          </div>
        </div>

        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <div className="spacer" />
          <button className="primary-button" disabled={saving || !(title.trim() || (item.type === "repo" && (repoPath.trim() || url.trim())))} type="submit">
            {saving ? "Saving..." : "Save changes"}
          </button>
        </div>
        {error && <p className="form-error">{error}</p>}
      </form>
    </div>
  );
}

function SetupScreen({ api, onStatus }: { api: CachetteApi; onStatus: (status: VaultStatus) => void }) {
  const [step, setStep] = useState(0);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [recoveryKeys, setRecoveryKeys] = useState<string[]>([]);
  const [setupStatus, setSetupStatus] = useState<VaultStatus | null>(null);
  const [savedRecoveryKeys, setSavedRecoveryKeys] = useState(false);
  const [createShortcut, setCreateShortcut] = useState(true);
  const [runAtStartup, setRunAtStartup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const copy = useClipboard(api);

  const strength = password.length >= 18 ? 4 : password.length >= 14 ? 3 : password.length >= 10 ? 2 : password.length >= 8 ? 1 : 0;
  const mismatch = confirm && password !== confirm;
  const passwordBad = Boolean(validateConfirmedPassword(password, confirm));

  async function next() {
    setError("");
    if (step === 0) {
      setStep(1);
      return;
    }
    const validationError = validateConfirmedPassword(password, confirm);
    if (validationError) {
      setError(validationError);
      return;
    }
    setBusy(true);
    try {
      const result = await api.setupVault(password);
      setSetupStatus(result.status);
      setRecoveryKeys(result.recoveryKeys);
      setStep(2);
    } catch (setupError) {
      setError(getErrorMessage(setupError, "Could not create vault."));
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setError("");
    try {
      await api.setDesktopShortcut(createShortcut);
      await api.setRunAtStartup(runAtStartup);
      onStatus(setupStatus ?? (await api.vaultStatus()));
    } catch (setupError) {
      setError(getErrorMessage(setupError, "Could not create vault."));
    }
  }

  function copyRecoveryKey(value: string) {
    void copy(value, { clearAfterMs: 30_000 });
  }

  function copyAllRecoveryKeys() {
    void copy(recoveryKeys.map((key, index) => `Recovery key ${index + 1}: ${key}`).join("\n"), {
      clearAfterMs: 30_000
    });
  }

  return (
    <section className="auth-shell onboarding-shell">
      <section className="onboarding-panel">
        <div className="step-bars" aria-label={`Onboarding step ${step + 1} of 4`}>
          {[0, 1, 2, 3].map((index) => (
            <span key={index} className={index <= step ? "is-active" : ""} />
          ))}
        </div>

        {step === 0 && (
          <>
            <div className="onboarding-brand-row">
              <div className="onboarding-brand">
                <LogoMark className="onboarding-logo" />
                <div>
                  <strong>Cachette</strong>
                  <span>Keep it hidden</span>
                </div>
              </div>
              <MascotMark className="mascot-mark" />
            </div>
            <h1>Everything worth keeping,<br />kept under lock.</h1>
            <p>Cachette is a local, encrypted box for screenshots, links, repos, notes, todos and secrets. Nothing ever leaves this machine.</p>
            <div className="feature-stack">
              <FeatureLine icon={<Shield size={17} />} title="AES-256-GCM encryption" text="Secrets are sealed field-by-field before they touch disk." />
              <FeatureLine icon={<Layers size={17} />} title="One box, six shapes" text="Passwords, notes, todos, links, repo paths and images - organized by project and tag." />
              <FeatureLine icon={<Download size={17} />} title="Encrypted backups" text="Export the whole vault as a single .enc file. Import it anywhere." />
            </div>
            <button className="primary-button wide onboarding-primary" type="button" onClick={() => void next()}>Set up my vault</button>
          </>
        )}

        {step === 1 && (
          <>
            <h1 className="compact-title">Create your master password</h1>
            <p>This password unlocks your vault key. It is never stored, and recovery only works with one of the offline recovery keys generated next.</p>
            <div className="auth-form">
              <label>
                <span>Master password</span>
                <input className="mono-input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 8 characters" autoFocus />
              </label>
              <div className="strength-bars" aria-label="Password strength">
                {[1, 2, 3, 4].map((index) => (
                  <span key={index} className={strength >= index ? "is-active" : ""} />
                ))}
              </div>
              <div className="strength-label">{strengthLabel(strength)}</div>
              <label>
                <span>Confirm password</span>
                <input className="mono-input" type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} placeholder="Type it again" />
              </label>
              <div className="inline-error">{mismatch ? "Passwords do not match." : error}</div>
              <div className="crypto-note">
                <Shield size={17} />
                <span>Your password is stretched with <strong>PBKDF2 (600,000 iterations)</strong> and used only to unwrap a random vault key. We keep verifier metadata only - never the password.</span>
              </div>
              <div className="onboarding-actions">
                <button className="secondary-button" type="button" onClick={() => setStep(0)}>Back</button>
                <button className="primary-button" type="button" disabled={passwordBad || busy} onClick={() => void next()}>
                  {busy ? "Creating..." : "Generate recovery keys"}
                </button>
              </div>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h1 className="compact-title">Save these recovery keys</h1>
            <p>These are shown once. Store them somewhere offline, like a password manager printout or a safe note that is not on this unlocked computer.</p>
            <div className="recovery-key-list">
              {recoveryKeys.map((key, index) => (
                <div className="recovery-key-row" key={key}>
                  <span>Key {index + 1}</span>
                  <code>{key}</code>
                  <button className="icon-button" type="button" onClick={() => void copyRecoveryKey(key)} aria-label={`Copy recovery key ${index + 1}`}>
                    <Copy size={15} />
                  </button>
                </div>
              ))}
            </div>
            <button className="secondary-button wide" type="button" onClick={() => void copyAllRecoveryKeys()}>
              <Copy size={15} />
              Copy all recovery keys
            </button>
            <label className="check-row recovery-confirm">
              <input type="checkbox" checked={savedRecoveryKeys} onChange={(event) => setSavedRecoveryKeys(event.target.checked)} />
              <span>I saved these keys somewhere offline. I understand they cannot be shown again.</span>
            </label>
            <div className="onboarding-actions">
              <button className="primary-button" type="button" disabled={!savedRecoveryKeys} onClick={() => setStep(3)}>Continue</button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div className="check-orb"><Check size={28} /></div>
            <h1 className="compact-title">Your vault is sealed</h1>
            <p>Here is how Cachette will protect what you put inside.</p>
            <div className="security-table">
              <div><span>Cipher</span><strong>AES-256-GCM</strong></div>
              <div><span>Key derivation</span><strong>PBKDF2 - 600k</strong></div>
              <div><span>Vault key</span><strong>Wrapped, random</strong></div>
              <div><span>Storage</span><strong>SQLite - local only</strong></div>
              <div>
                <span>Create desktop shortcut</span>
                <button
                  className={createShortcut ? "toggle is-on" : "toggle"}
                  type="button"
                  onClick={() => setCreateShortcut((current) => !current)}
                  aria-pressed={createShortcut}
                >
                  <span />
                </button>
              </div>
              <div>
                <span>Run on Windows startup</span>
                <button
                  className={runAtStartup ? "toggle is-on" : "toggle"}
                  type="button"
                  onClick={() => setRunAtStartup((current) => !current)}
                  aria-pressed={runAtStartup}
                >
                  <span />
                </button>
              </div>
            </div>
            <div className="secure-storage-copy">Startup and shortcut options can be changed later in Settings. Unlocking always requires the master password or an unused recovery key.</div>
            {error && <p className="form-error">{error}</p>}
            <button className="primary-button wide onboarding-primary" type="button" onClick={finish}>Enter my vault</button>
          </>
        )}
      </section>
    </section>
  );
}

function FeatureLine({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <div className="feature-line">
      <span>{icon}</span>
      <div>
        <strong>{title}</strong>
        <p>{text}</p>
      </div>
    </div>
  );
}

function SettingsModal({
  api,
  autoLockMs,
  initialPanel,
  onAutoLockMs,
  onClose,
  onImported,
  onRememberChange,
  onResetForOnboarding,
  onStatus,
  onTheme,
  onToast,
  remember,
  theme
}: {
  api: CachetteApi;
  autoLockMs: number;
  initialPanel?: SettingsPanel;
  onAutoLockMs: (value: number) => void;
  onClose: () => void;
  onImported: (status: VaultStatus) => Promise<void>;
  onRememberChange: (status: RememberStatus) => void;
  onResetForOnboarding: () => Promise<void>;
  onStatus: (status: VaultStatus) => void;
  onTheme: (theme: Theme) => void;
  onToast: (message: string) => void;
  remember: RememberStatus;
  theme: Theme;
}) {
  const [settings, setSettings] = useState<VaultSettings>({
    desktopShortcutCreated: false,
    runAtStartup: false,
    trayShortcut: "",
    trayShortcutRegistered: true,
    developmentMode: false
  });
  const [busy, setBusy] = useState("");
  const [panel, setPanel] = useState<SettingsPanel>(initialPanel ?? null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [exportPassword, setExportPassword] = useState("");
  const [exportConfirm, setExportConfirm] = useState("");
  const [exportError, setExportError] = useState("");
  const [importFile, setImportFile] = useState<PickedFile | null>(null);
  const [importMode, setImportMode] = useState<BackupImportMode | "">("");
  const [importBackupPassword, setImportBackupPassword] = useState("");
  const [sourceMasterPassword, setSourceMasterPassword] = useState("");
  const [importError, setImportError] = useState("");
  const [trayShortcutDraft, setTrayShortcutDraft] = useState("");
  const [trayShortcutError, setTrayShortcutError] = useState("");

  useEffect(() => {
    api
      .settingsStatus()
      .then((nextSettings) => {
        setSettings(nextSettings);
        setTrayShortcutDraft(nextSettings.trayShortcut);
      })
      .catch((error) => showError(error, onToast));
  }, [api, onToast]);

  async function toggleDesktopShortcut() {
    if (busy) return;
    setBusy("shortcut");
    try {
      const nextSettings = await api.setDesktopShortcut(!settings.desktopShortcutCreated);
      setSettings(nextSettings);
      onToast(nextSettings.desktopShortcutCreated ? "Desktop shortcut created" : "Desktop shortcut removed");
    } catch (error) {
      showError(error, onToast);
    } finally {
      setBusy("");
    }
  }

  async function toggleRunAtStartup() {
    if (busy) return;
    setBusy("startup");
    try {
      const nextSettings = await api.setRunAtStartup(!settings.runAtStartup);
      setSettings(nextSettings);
      onToast(nextSettings.runAtStartup ? "Cachette will run on Windows startup" : "Windows startup disabled");
    } catch (error) {
      showError(error, onToast);
    } finally {
      setBusy("");
    }
  }

  async function saveTrayShortcut(nextShortcut = trayShortcutDraft) {
    if (busy) return;
    setBusy("tray-shortcut");
    setTrayShortcutError("");
    try {
      const nextSettings = await api.setTrayShortcut(nextShortcut);
      setSettings(nextSettings);
      setTrayShortcutDraft(nextSettings.trayShortcut);
      onToast(nextSettings.trayShortcut ? `Tray shortcut saved: ${formatShortcut(nextSettings.trayShortcut)}` : "Tray shortcut cleared");
    } catch (error) {
      showError(error, setTrayShortcutError);
    } finally {
      setBusy("");
    }
  }

  function captureTrayShortcut(event: ReactKeyboardEvent<HTMLInputElement>) {
    event.preventDefault();
    const shortcut = shortcutFromKeyboardEvent(event);
    if (!shortcut) return;
    setTrayShortcutDraft(shortcut);
    setTrayShortcutError("");
  }

  function togglePanel(nextPanel: SettingsPanel) {
    if (busy) return;
    setPanel((current) => (current === nextPanel ? null : nextPanel));
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordError("");
    if (currentPassword.length < 8) {
      setPasswordError("Current password must be at least 8 characters.");
      return;
    }
    const validationError = validateConfirmedPassword(nextPassword, confirmPassword);
    if (validationError) {
      setPasswordError(validationError);
      return;
    }

    setBusy("password");
    try {
      onStatus(await api.changeMasterPassword(currentPassword, nextPassword));
      setSettings(await api.settingsStatus());
      setCurrentPassword("");
      setNextPassword("");
      setConfirmPassword("");
      setPanel(null);
      onToast("Master password changed");
    } catch (error) {
      showError(error, setPasswordError);
    } finally {
      setBusy("");
    }
  }

  async function exportEncryptedBackup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setExportError("");
    const validationError = validateConfirmedPassword(exportPassword, exportConfirm);
    if (validationError) {
      setExportError(validationError);
      return;
    }

    setBusy("export");
    try {
      const result = await api.exportBackup(exportPassword);
      setExportPassword("");
      setExportConfirm("");
      setPanel(null);
      onToast(`Backup exported: ${result.filePath}`);
    } catch (error) {
      showError(error, setExportError);
    } finally {
      setBusy("");
    }
  }

  async function pickBackupFile() {
    if (busy) return;
    setBusy("pick-backup");
    setImportError("");
    try {
      const picked = await api.pickBackupFile();
      if (picked) setImportFile(picked);
    } catch (error) {
      showError(error, setImportError);
    } finally {
      setBusy("");
    }
  }

  async function importEncryptedBackup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setImportError("");
    if (!importFile) {
      setImportError("Choose a .enc backup file.");
      return;
    }
    if (!importMode) {
      setImportError("Choose Replace vault or Merge items.");
      return;
    }
    if (importBackupPassword.length < 8) {
      setImportError("Backup password must be at least 8 characters.");
      return;
    }
    if (importMode === "merge" && sourceMasterPassword.length < 8) {
      setImportError("Source vault master password must be at least 8 characters.");
      return;
    }

    setBusy("import");
    try {
      const result = await api.importBackup({
        backupPath: importFile.path,
        backupPassword: importBackupPassword,
        mode: importMode,
        sourceMasterPassword: importMode === "merge" ? sourceMasterPassword : undefined
      });
      setImportFile(null);
      setImportMode("");
      setImportBackupPassword("");
      setSourceMasterPassword("");
      setPanel(null);
      onStatus(result.status);
      await onImported(result.status);
      onToast(result.mode === "merge" ? `${result.itemCount} backup items merged` : "Backup restored. Unlock with the imported vault password.");
    } catch (error) {
      showError(error, setImportError);
    } finally {
      setBusy("");
    }
  }

  async function resetForOnboarding() {
    if (!settings.developmentMode || busy) return;
    const confirmed = window.confirm("Reset this development vault and return to onboarding? This deletes local dev vault data.");
    if (!confirmed) return;

    setBusy("reset");
    try {
      await onResetForOnboarding();
      onToast("Returned to onboarding");
    } catch (error) {
      showError(error, onToast);
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="modal-backdrop settings-backdrop" role="presentation">
      <section className="settings-sheet" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="settings-head">
          <strong>Settings</strong>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close settings">
            <X size={17} />
          </button>
        </div>

        <div className="settings-body">
          <span className="eyebrow">Security</span>
          <div className="settings-group">
            <label className="settings-row">
              <span>
                <strong>Auto-lock after idle</strong>
              </span>
              <select value={autoLockMs} onChange={(event) => onAutoLockMs(Number(event.target.value))}>
                <option value={30_000}>30 seconds</option>
                <option value={90_000}>90 seconds</option>
                <option value={300_000}>5 minutes</option>
                <option value={900_000}>15 minutes</option>
                <option value={0}>Never</option>
              </select>
            </label>
            {remember.available && (
              <div className="settings-row">
                <span>
                  <strong>Stay signed in</strong>
                  <small>
                    {remember.enabled
                      ? "Auto sign-in is on for this device"
                      : "Enable from the lock screen when unlocking"}
                  </small>
                </span>
                {remember.enabled && (
                  <button
                    className="mini-button"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      void api
                        .disableRemember()
                        .then((nextRemember) => {
                          onRememberChange(nextRemember);
                          onToast("Auto sign-in disabled");
                        })
                        .catch((error) => showError(error, onToast));
                    }}
                    type="button"
                  >
                    Sign out
                  </button>
                )}
              </div>
            )}
            <div className="settings-row">
              <span>
                <strong>Master password</strong>
                <small>Update the password used to unlock this vault</small>
              </span>
              <button className="mini-button" disabled={Boolean(busy)} onClick={() => togglePanel("password")} type="button">
                {panel === "password" ? "Close" : "Change"}
              </button>
            </div>
            {panel === "password" && (
              <form className="settings-inline-form" onSubmit={changePassword}>
                <label>
                  <span>Current password</span>
                  <input className="mono-input" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoFocus />
                </label>
                <label>
                  <span>New password</span>
                  <input className="mono-input" type="password" value={nextPassword} onChange={(event) => setNextPassword(event.target.value)} />
                </label>
                <label>
                  <span>Confirm new password</span>
                  <input className="mono-input" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
                </label>
                {passwordError && <p className="settings-error">{passwordError}</p>}
                <div className="settings-form-actions">
                  <button className="primary-button" disabled={busy === "password"} type="submit">
                    Save password
                  </button>
                </div>
              </form>
            )}
          </div>

          <span className="eyebrow">System</span>
          <div className="settings-group">
            <div className="settings-row">
              <span>
                <strong>Desktop shortcut</strong>
                <small>Create a Cachette shortcut on your desktop</small>
              </span>
              <button
                className={settings.desktopShortcutCreated ? "toggle is-on" : "toggle"}
                disabled={busy === "shortcut"}
                onClick={toggleDesktopShortcut}
                type="button"
                aria-pressed={settings.desktopShortcutCreated}
              >
                <span />
              </button>
            </div>
            <div className="settings-row">
              <span>
                <strong>Run on Windows startup</strong>
                <small>Start Cachette automatically when you sign in</small>
              </span>
              <button
                className={settings.runAtStartup ? "toggle is-on" : "toggle"}
                disabled={busy === "startup"}
                onClick={toggleRunAtStartup}
                type="button"
                aria-pressed={settings.runAtStartup}
              >
                <span />
              </button>
            </div>
            <div className="settings-row tray-shortcut-row">
              <span>
                <strong>Tray shortcut</strong>
                <small>Open or hide Cachette while it is in the system tray</small>
              </span>
              <div className="shortcut-config">
                <input
                  className="mono-input"
                  value={formatShortcut(trayShortcutDraft)}
                  onKeyDown={captureTrayShortcut}
                  onChange={() => undefined}
                  placeholder="Press a shortcut"
                  aria-label="Tray shortcut"
                  readOnly
                />
                <div className="shortcut-actions">
                  <button
                    className="mini-button"
                    disabled={busy === "tray-shortcut" || trayShortcutDraft === settings.trayShortcut}
                    onClick={() => void saveTrayShortcut()}
                    type="button"
                  >
                    Save
                  </button>
                  <button
                    className="mini-button"
                    disabled={busy === "tray-shortcut" || !settings.trayShortcut}
                    onClick={() => {
                      setTrayShortcutDraft("");
                      void saveTrayShortcut("");
                    }}
                    type="button"
                  >
                    Clear
                  </button>
                </div>
                {trayShortcutError && <p className="settings-error">{trayShortcutError}</p>}
                {!settings.trayShortcutRegistered && settings.trayShortcut && (
                  <p className="settings-warning">This shortcut is saved, but Windows did not register it. Choose another combination.</p>
                )}
              </div>
            </div>
          </div>

          <span className="eyebrow">Backup</span>
          <div className="settings-group">
            <div className="settings-row">
              <span>
                <strong>Export encrypted backup</strong>
                <small>Single .enc file, sealed with your backup password</small>
              </span>
              <button className="mini-button" disabled={Boolean(busy)} type="button" onClick={() => togglePanel("export")}>
                <Download size={14} />
                {panel === "export" ? "Close" : "Export"}
              </button>
            </div>
            {panel === "export" && (
              <form className="settings-inline-form" onSubmit={exportEncryptedBackup}>
                <label>
                  <span>Backup password</span>
                  <input className="mono-input" type="password" value={exportPassword} onChange={(event) => setExportPassword(event.target.value)} autoFocus />
                </label>
                <label>
                  <span>Confirm backup password</span>
                  <input className="mono-input" type="password" value={exportConfirm} onChange={(event) => setExportConfirm(event.target.value)} />
                </label>
                {exportError && <p className="settings-error">{exportError}</p>}
                <div className="settings-form-actions">
                  <button className="primary-button" disabled={busy === "export"} type="submit">
                    Export backup
                  </button>
                </div>
              </form>
            )}
            <div className="settings-row">
              <span>
                <strong>Import backup</strong>
                <small>Choose Replace vault or Merge items before importing</small>
              </span>
              <button className="mini-button" disabled={Boolean(busy)} type="button" onClick={() => togglePanel("import")}>
                <Upload size={14} />
                {panel === "import" ? "Close" : "Import"}
              </button>
            </div>
            {panel === "import" && (
              <form className="settings-inline-form" onSubmit={importEncryptedBackup}>
                <div className="file-picker-row">
                  <span>
                    <strong>{importFile?.name ?? "No backup selected"}</strong>
                    {importFile && <small>{importFile.path}</small>}
                  </span>
                  <button className="mini-button" disabled={busy === "pick-backup"} type="button" onClick={pickBackupFile}>
                    <File size={14} />
                    Choose
                  </button>
                </div>
                <div className="segmented-control" role="group" aria-label="Import mode">
                  <button className={importMode === "replace" ? "is-active" : ""} type="button" onClick={() => setImportMode("replace")}>
                    Replace vault
                  </button>
                  <button className={importMode === "merge" ? "is-active" : ""} type="button" onClick={() => setImportMode("merge")}>
                    Merge items
                  </button>
                </div>
                {importMode === "replace" && <p className="settings-warning">Replace deletes the current local vault data and locks the app after restore.</p>}
                {importMode === "merge" && <p className="settings-warning">Merge keeps this vault password and adds imported items with new IDs.</p>}
                <label>
                  <span>Backup password</span>
                  <input className="mono-input" type="password" value={importBackupPassword} onChange={(event) => setImportBackupPassword(event.target.value)} />
                </label>
                {importMode === "merge" && (
                  <label>
                    <span>Source vault master password</span>
                    <input className="mono-input" type="password" value={sourceMasterPassword} onChange={(event) => setSourceMasterPassword(event.target.value)} />
                  </label>
                )}
                {importError && <p className="settings-error">{importError}</p>}
                <div className="settings-form-actions">
                  <button className="primary-button" disabled={busy === "import"} type="submit">
                    Import backup
                  </button>
                </div>
              </form>
            )}
          </div>

          <span className="eyebrow">Appearance</span>
          <div className="theme-choices">
            <button className={theme === "dark" ? "theme-choice is-active" : "theme-choice"} onClick={() => onTheme("dark")} type="button">
              <span className="theme-swatch dark" />
              Dark
            </button>
            <button className={theme === "light" ? "theme-choice is-active" : "theme-choice"} onClick={() => onTheme("light")} type="button">
              <span className="theme-swatch light" />
              Light
            </button>
          </div>

          {settings.developmentMode && (
            <>
              <span className="eyebrow">Development</span>
              <div className="settings-group">
                <div className="settings-row">
                  <span>
                    <strong>Return to onboarding</strong>
                    <small>Reset the development vault and show setup again</small>
                  </span>
                  <button className="mini-button danger" disabled={busy === "reset"} onClick={resetForOnboarding} type="button">
                    Reset
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function strengthLabel(strength: number) {
  return ["Too short", "Starter strength", "Getting stronger", "Strong", "Very strong"][strength];
}

function extractLegacyRepoRemote(content: string) {
  return content.match(/^Remote:\s*(\S+)/i)?.[1];
}

function stripLegacyRepoRemote(content: string) {
  return content.replace(/^Remote:\s*\S+\s*/i, "").trim();
}

function uniqueStrings(values: Array<string | undefined>) {
  return Array.from(new Set(values.map((value) => value?.trim()).filter(Boolean))) as string[];
}

function isSensitiveItem(item: VaultItem) {
  return item.type === "password" || item.type === "private" || Boolean(item.encryptedData);
}

function shortcutFromKeyboardEvent(event: ReactKeyboardEvent<HTMLInputElement>) {
  const key = normalizeShortcutKey(event.key);
  if (!key) return "";

  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("CommandOrControl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");

  const isFunctionKey = /^F(?:[1-9]|1\d|2[0-4])$/.test(key);
  if (!parts.length && !isFunctionKey) {
    return "";
  }

  parts.push(key);
  return parts.join("+");
}

function normalizeShortcutKey(key: string) {
  if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase();
  if (/^F(?:[1-9]|1\d|2[0-4])$/i.test(key)) return key.toUpperCase();
  return {
    " ": "Space",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    ArrowUp: "Up",
    Backspace: "Backspace",
    Delete: "Delete",
    End: "End",
    Enter: "Enter",
    Escape: "Escape",
    Home: "Home",
    Insert: "Insert",
    PageDown: "PageDown",
    PageUp: "PageUp",
    Tab: "Tab",
    "-": "-",
    "=": "=",
    ",": ",",
    ".": ".",
    "/": "/",
    ";": ";",
    "'": "'",
    "[": "[",
    "]": "]",
    "\\": "\\"
  }[key] ?? "";
}

function formatShortcut(shortcut: string) {
  return shortcut
    .replace(/CommandOrControl/g, "Ctrl")
    .replace(/\+/g, " + ");
}

function formatRelativeTime(value: string) {
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return new Date(value).toLocaleDateString();

  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d ago`;

  return new Date(value).toLocaleDateString();
}

function tagColor(name: string) {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return TAG_COLORS[hash % TAG_COLORS.length];
}

function readStoredList(key: string) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  } catch {
    return [];
  }
}

function UnlockScreen({
  api,
  status,
  onStatus,
  remember,
  onRememberChange
}: {
  api: CachetteApi;
  status: VaultStatus;
  onStatus: (status: VaultStatus) => void;
  remember: RememberStatus;
  onRememberChange: (status: RememberStatus) => void;
}) {
  const [mode, setMode] = useState<"password" | "recovery">("password");
  const [password, setPassword] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [replacementRecoveryKey, setReplacementRecoveryKey] = useState("");
  const [recoveredStatus, setRecoveredStatus] = useState<VaultStatus | null>(null);
  const [error, setError] = useState("");
  const [keepSignedIn, setKeepSignedIn] = useState(false);
  const copy = useClipboard(api);

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    try {
      const nextStatus = await api.unlockVault(password);
      if (keepSignedIn && remember.available) {
        try {
          onRememberChange(await api.enableRemember());
        } catch {
          // Unlock still succeeded; remember-me just stays off.
        }
      }
      onStatus(nextStatus);
    } catch (unlockError) {
      setError(getErrorMessage(unlockError, "Could not unlock vault."));
    }
  }

  async function resumeSession() {
    setError("");
    try {
      const nextStatus = await api.autoUnlock();
      if (!nextStatus.unlocked) {
        onRememberChange(await api.rememberStatus());
        setError("Remembered session expired. Enter your master password.");
        return;
      }
      onStatus(nextStatus);
    } catch (resumeError) {
      setError(getErrorMessage(resumeError, "Could not resume session."));
    }
  }

  async function recover(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    const validationError = validateConfirmedPassword(nextPassword, confirmPassword);
    if (validationError) {
      setError(validationError);
      return;
    }

    try {
      const result = await api.recoverVault(recoveryKey, nextPassword);
      setReplacementRecoveryKey(result.replacementRecoveryKey);
      setRecoveredStatus(result.status);
      setRecoveryKey("");
      setNextPassword("");
      setConfirmPassword("");
    } catch (recoverError) {
      setError(getErrorMessage(recoverError, "Could not recover vault."));
    }
  }

  return (
    <section className="auth-shell lock-shell">
      {mode === "password" && (
      <form className="auth-form" onSubmit={unlock}>
        <div className="lock-badge">
          <MascotMark className="lock-mascot" />
        </div>
        <h1>Vault locked</h1>
        <p>{status.itemCount} items sealed with AES-256.</p>
        <input
          className="mono-input lock-input"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Master password"
          autoFocus
        />
        {error && <p className="form-error">{error}</p>}
        <button className="primary-button wide" type="submit">Unlock</button>
        {remember.enabled && (
          <button className="secondary-button wide" type="button" onClick={() => void resumeSession()}>
            Resume session
          </button>
        )}
        <div className="lock-options-row">
          <button className="secondary-button" type="button" onClick={() => { setMode("recovery"); setError(""); }}>
            Use a recovery key
          </button>
          {remember.available && (
            <label className="remember-row">
              <input
                type="checkbox"
                checked={keepSignedIn}
                onChange={(event) => setKeepSignedIn(event.target.checked)}
              />
              <span>Keep me signed in</span>
            </label>
          )}
        </div>
      </form>
      )}

      {mode === "recovery" && !replacementRecoveryKey && (
        <form className="auth-form recovery-form" onSubmit={recover}>
          <div className="lock-badge">
            <KeyRound size={28} />
          </div>
          <h1>Recover vault</h1>
          <p>Enter one unused recovery key, then choose a new master password. The key you use will be replaced.</p>
          <label>
            <span>Recovery key</span>
            <input
              className="mono-input lock-input"
              value={recoveryKey}
              onChange={(event) => setRecoveryKey(event.target.value)}
              placeholder="CV-...."
              autoFocus
            />
          </label>
          <label>
            <span>New master password</span>
            <input className="mono-input lock-input" type="password" value={nextPassword} onChange={(event) => setNextPassword(event.target.value)} />
          </label>
          <label>
            <span>Confirm new password</span>
            <input className="mono-input lock-input" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary-button wide" type="submit">Recover and reset password</button>
          <button className="secondary-button wide" type="button" onClick={() => { setMode("password"); setError(""); }}>
            Back to password unlock
          </button>
        </form>
      )}

      {mode === "recovery" && replacementRecoveryKey && recoveredStatus && (
        <section className="auth-form recovery-form">
          <div className="check-orb"><Check size={28} /></div>
          <h1>Recovery key rotated</h1>
          <p>The recovery key you used can no longer unlock this vault. Save this replacement key somewhere offline.</p>
          <div className="recovery-key-row single">
            <span>New key</span>
            <code>{replacementRecoveryKey}</code>
            <button className="icon-button" type="button" onClick={() => void copy(replacementRecoveryKey, { clearAfterMs: 30_000 })} aria-label="Copy replacement recovery key">
              <Copy size={15} />
            </button>
          </div>
          <button className="primary-button wide" type="button" onClick={() => onStatus(recoveredStatus)}>
            I saved it. Enter vault
          </button>
        </section>
      )}
    </section>
  );
}

function EmptyList({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="empty-list">
      <Shield size={28} />
      <strong>No matching items</strong>
      <p>Try a different filter or add something new.</p>
      <button className="secondary-button" onClick={onAdd}>
        <Plus size={15} />
        Add item
      </button>
    </div>
  );
}

function LoadingShell() {
  return (
    <section className="auth-shell">
      <section className="auth-panel">
        <LogoMark className="brand-lock pulse" />
        <h1>Opening vault</h1>
        <p>Preparing the local shell.</p>
      </section>
    </section>
  );
}

function LogoMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" aria-hidden="true">
      <defs>
        <linearGradient id="cachetteGloss" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f4cc72" />
          <stop offset="1" stopColor="#d1962a" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="46" height="46" rx="13" fill="url(#cachetteGloss)" />
      <circle cx="24" cy="19" r="7" fill="#231a05" />
      <path d="M24 22 L30.5 37 Q24 40 17.5 37 Z" fill="#231a05" />
    </svg>
  );
}

function MascotMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 140 140" aria-hidden="true">
      <path d="M84 114 C122 114 136 76 118 50 C102 27 68 27 63 48 C59 63 75 73 88 66 C79 79 75 98 84 114 Z" fill="#e6b34d" />
      <path d="M88 105 C113 101 122 75 109 57 C100 44 82 43 79 54 C77 63 87 68 93 63 C86 76 84 91 88 105 Z" fill="#f2cd7c" opacity="0.5" />
      <ellipse cx="60" cy="95" rx="28" ry="25" fill="#d99f2f" />
      <ellipse cx="52" cy="101" rx="16" ry="14" fill="#f5e3b8" />
      <circle cx="48" cy="56" r="20" fill="#d99f2f" />
      <path d="M37 42 C34 29 46 27 51 38 Z" fill="#d99f2f" />
      <path d="M40 39 C39 33 44 32 46 37 Z" fill="#b57d1c" />
      <circle cx="38" cy="63" r="9" fill="#f5e3b8" />
      <circle cx="31.5" cy="60" r="2.6" fill="#3a2a08" />
      <circle cx="45" cy="51" r="3.1" fill="#241a06" />
      <circle cx="46.2" cy="49.8" r="1" fill="#fff" />
      <path d="M22 86 Q32 76 42 86 L42 90 Q32 83 22 90 Z" fill="#6b4614" />
      <ellipse cx="32" cy="95" rx="9" ry="9" fill="#9a6a22" />
      <circle cx="32" cy="92.5" r="2.1" fill="#f5e3b8" />
      <path d="M32 94 L34.2 99.5 Q32 100.6 29.8 99.5 Z" fill="#f5e3b8" />
      <circle cx="23" cy="87" r="4" fill="#b57d1c" />
      <circle cx="41" cy="87" r="4" fill="#b57d1c" />
      <ellipse cx="46" cy="119" rx="11" ry="5" fill="#b57d1c" />
    </svg>
  );
}

function showError(error: unknown, setMessage: (message: string) => void) {
  setMessage(getErrorMessage(error));
}

function createBrowserFallbackApi(): CachetteApi {
  let initialized = false;
  let unlocked = false;
  let desktopShortcutCreated = false;
  let runAtStartup = false;
  let trayShortcut = "CommandOrControl+Shift+L";
  let items: VaultItem[] = [];
  let recoveryCounter = 0;

  return {
    vaultStatus: async () => ({ initialized, unlocked, itemCount: items.length }),
    setupVault: async () => {
      initialized = true;
      unlocked = true;
      recoveryCounter += 1;
      return {
        status: { initialized, unlocked, itemCount: items.length },
        recoveryKeys: [1, 2, 3].map((index) => `CV-BROWSER-PREVIEW-${recoveryCounter}-${index}`)
      };
    },
    unlockVault: async () => {
      unlocked = true;
      return { initialized, unlocked, itemCount: items.length };
    },
    recoverVault: async () => {
      initialized = true;
      unlocked = true;
      recoveryCounter += 1;
      return {
        status: { initialized, unlocked, itemCount: items.length },
        replacementRecoveryKey: `CV-BROWSER-PREVIEW-ROTATED-${recoveryCounter}`
      };
    },
    lockVault: async () => {
      unlocked = false;
      return { initialized, unlocked, itemCount: items.length };
    },
    autoUnlock: async () => ({ initialized, unlocked, itemCount: items.length }),
    rememberStatus: async () => ({ available: false, enabled: false }),
    enableRemember: async () => ({ available: false, enabled: false }),
    disableRemember: async () => ({ available: false, enabled: false }),
    listItems: async (filters) => {
      const search = filters?.search?.toLowerCase();
      return items.filter((item) => {
        if (filters?.type && filters.type !== "all" && item.type !== filters.type) return false;
        if (filters?.category && item.category !== filters.category) return false;
        if (filters?.tag && !item.tags.includes(filters.tag)) return false;
        return !search || `${item.title} ${item.content} ${item.todos?.map((todo) => todo.text).join(" ") ?? ""} ${item.tags.join(" ")}`.toLowerCase().includes(search);
      });
    },
    createItem: async (draft) => {
      const now = new Date().toISOString();
      const item: VaultItem = {
        id: crypto.randomUUID(),
        type: draft.type,
        title: draft.title,
        content: draft.content ?? "",
        contentFormat: draft.contentFormat ?? (draft.type === "note" ? "markdown" : "plain"),
        todos: draft.type === "todo" ? draft.todos ?? [] : undefined,
        url: draft.url,
        repoPath: draft.repoPath,
        category: draft.category ?? "General",
        tags: draft.tags ?? [],
        encryptedData: draft.encryptedData ? { sealed: "browser-preview" } : undefined,
        attachments: [],
        createdAt: now,
        updatedAt: now
      };
      items = [item, ...items];
      return item;
    },
    updateItem: async (update) => {
      const existing = items.find((item) => item.id === update.id);
      if (!existing) {
        throw new Error("Item not found.");
      }
      const next = { ...existing, ...update, updatedAt: new Date().toISOString() };
      items = items.map((item) => (item.id === update.id ? next : item));
      return next;
    },
    deleteItem: async (id) => {
      items = items.filter((item) => item.id !== id);
    },
    pickAttachments: async () => [],
    addAttachments: async () => [],
    attachmentPreview: async () => null,
    revealSecret: async () => ({ password: "Browser preview does not decrypt secrets." }),
    exportBackup: async () => ({ filePath: "browser-preview.enc" }),
    pickBackupFile: async () => ({ path: "browser-preview.enc", name: "browser-preview.enc" }),
    importBackup: async (request) => ({
      mode: request.mode,
      itemCount: items.length,
      status: { initialized, unlocked: request.mode === "merge" ? unlocked : false, itemCount: items.length }
    }),
    settingsStatus: async () => ({ desktopShortcutCreated, runAtStartup, trayShortcut, trayShortcutRegistered: true, developmentMode: true }),
    setDesktopShortcut: async (enabled) => {
      desktopShortcutCreated = enabled;
      return { desktopShortcutCreated, runAtStartup, trayShortcut, trayShortcutRegistered: true, developmentMode: true };
    },
    setRunAtStartup: async (enabled) => {
      runAtStartup = enabled;
      return { desktopShortcutCreated, runAtStartup, trayShortcut, trayShortcutRegistered: true, developmentMode: true };
    },
    setTrayShortcut: async (shortcut) => {
      trayShortcut = shortcut;
      return { desktopShortcutCreated, runAtStartup, trayShortcut, trayShortcutRegistered: true, developmentMode: true };
    },
    resetForOnboarding: async () => {
      initialized = false;
      unlocked = false;
      items = [];
      return { initialized, unlocked, itemCount: items.length };
    },
    changeMasterPassword: async () => ({ initialized, unlocked, itemCount: items.length }),
    openPath: async () => undefined,
    openExternal: async (url) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    copyText: async (text) => navigator.clipboard?.writeText(text),
    windowMinimize: async () => false,
    windowToggleMaximize: async () => false,
    windowClose: async () => false
  };
}
