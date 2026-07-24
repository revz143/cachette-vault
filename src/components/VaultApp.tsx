"use client";

import {
  Check,
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
  KeyRound,
  Link2,
  Lock,
  Layers,
  Moon,
  NotebookPen,
  Plus,
  Search,
  Settings,
  Shield,
  Sun,
  Tag,
  Trash2,
  Upload,
  X
} from "lucide-react";
import Image from "next/image";
import type { ComponentType, FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AttachmentPreview,
  CachetteApi,
  ItemDraft,
  ItemFilters,
  ItemType,
  ItemUpdate,
  VaultItem,
  VaultSettings,
  VaultStatus
} from "@/shared/types";
import { AddItemModal } from "./AddItemModal";
import { MarkdownPreview } from "./MarkdownPreview";

type Theme = "dark" | "light";

const TYPE_META: Record<ItemType, { label: string; icon: ComponentType<{ size?: number }>; color: string }> = {
  note: { label: "Note", icon: NotebookPen, color: "var(--tnote)" },
  link: { label: "Website", icon: Link2, color: "var(--tlink)" },
  repo: { label: "Repo", icon: FolderGit2, color: "var(--trepo)" },
  image: { label: "Image", icon: FileImage, color: "var(--timg)" },
  password: { label: "Password", icon: KeyRound, color: "var(--tpass)" },
  private: { label: "Private", icon: Shield, color: "var(--tpass)" }
};

const TAG_COLORS = ["#f3bf4f", "#f286a8", "#4fd1c5", "#7aa7ff", "#b48cf2", "#4ade80"];

export function VaultApp() {
  const [api, setApi] = useState<CachetteApi | null>(null);
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [items, setItems] = useState<VaultItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [type, setType] = useState<ItemType | "all">("all");
  const [category, setCategory] = useState("All");
  const [tag, setTag] = useState<string | undefined>();
  const [theme, setTheme] = useState<Theme>("dark");
  const [modalOpen, setModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<VaultItem | null>(null);
  const [customProjects, setCustomProjects] = useState<string[]>([]);
  const [customTags, setCustomTags] = useState<string[]>([]);
  const [autoLockMs, setAutoLockMs] = useState(90_000);
  const [toast, setToast] = useState("");

  const lockVault = useCallback(async () => {
    if (!api) return;
    const nextStatus = await api.lockVault();
    setStatus(nextStatus);
    setItems([]);
    setSelectedId(null);
  }, [api]);

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
    cachette.vaultStatus().then(setStatus).catch((error) => showError(error, setToast));
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
      return;
    }

    let timeoutId = window.setTimeout(lockVault, autoLockMs);
    const resetTimer = () => {
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(lockVault, autoLockMs);
    };
    const events = ["keydown", "mousedown", "mousemove", "wheel", "touchstart"];

    events.forEach((eventName) => window.addEventListener(eventName, resetTimer, { passive: true }));
    return () => {
      window.clearTimeout(timeoutId);
      events.forEach((eventName) => window.removeEventListener(eventName, resetTimer));
    };
  }, [autoLockMs, lockVault, status?.unlocked]);

  const filters: ItemFilters = useMemo(
    () => ({
      search,
      type,
      category: category === "All" ? undefined : category,
      tag
    }),
    [category, search, tag, type]
  );

  useEffect(() => {
    if (!api || !status?.unlocked) {
      return;
    }

    api
      .listItems(filters)
      .then((nextItems) => {
        setItems(nextItems);
        setSelectedId((current) => current ?? nextItems[0]?.id ?? null);
      })
      .catch((error) => showError(error, setToast));
  }, [api, filters, status?.unlocked]);

  const categories = useMemo(() => {
    const names = new Set([...customProjects, ...items.map((item) => item.category)]);
    return ["General", ...Array.from(names).filter((name) => name !== "General").sort()];
  }, [customProjects, items]);

  const sidebarCategories = useMemo(() => ["All", ...categories], [categories]);
  const tags = useMemo(() => Array.from(new Set([...customTags, ...items.flatMap((item) => item.tags)])).sort(), [customTags, items]);
  const selected = items.find((item) => item.id === selectedId) ?? items[0];

  async function refresh(nextFilters = filters) {
    if (!api) return;
    const nextItems = await api.listItems(nextFilters);
    setItems(nextItems);
    setSelectedId((current) => current ?? nextItems[0]?.id ?? null);
  }

  async function handleSave(draft: ItemDraft) {
    if (!api) return;
    const created = await api.createItem(draft);
    await refresh();
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

  function addProject() {
    const name = window.prompt("Project name")?.trim();
    if (!name) return;
    setCustomProjects((current) => Array.from(new Set([...current, name])).sort());
    setCategory(name);
    setTag(undefined);
  }

  function addTag() {
    const name = window.prompt("Tag name")?.trim().replace(/^#/, "").toLowerCase();
    if (!name) return;
    setCustomTags((current) => Array.from(new Set([...current, name])).sort());
    setTag(name);
    setCategory("All");
  }

  async function runWindowAction(action: () => Promise<boolean>) {
    try {
      const handled = await action();
      if (!handled) {
        flash("Window controls are available in the desktop app.");
      }
    } catch (error) {
      showError(error, setToast);
    }
  }

  if (!api || !status) {
    return <LoadingShell />;
  }

  if (!status.initialized) {
    return <SetupScreen api={api} onStatus={setStatus} status={status} />;
  }

  if (!status.unlocked) {
    return <UnlockScreen api={api} onStatus={setStatus} status={status} />;
  }

  return (
    <main className="app-shell">
      <header className="titlebar">
        <LogoMark className="brand-mark" />
        <strong>Cachette</strong>
        <span>local vault</span>
        <div className="titlebar-actions">
          <button className="icon-button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="Toggle theme">
            {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          <button className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Open settings">
            <Settings size={17} />
          </button>
          <button className="icon-button" onClick={lockVault} aria-label="Lock vault">
            <Lock size={17} />
          </button>
        </div>
        <div className="window-controls">
          <button
            className="window-minimize"
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => runWindowAction(api.windowMinimize)}
            aria-label="Minimize window"
          />
          <button
            className="window-maximize"
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => runWindowAction(api.windowToggleMaximize)}
            aria-label="Maximize window"
          />
          <button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => runWindowAction(api.windowClose)}
            aria-label="Close window"
          >
            x
          </button>
        </div>
      </header>

      <section className="vault-layout">
        <aside className="sidebar">
          <nav className="nav-section" aria-label="Categories">
            <div className="nav-section-head">
              <span className="eyebrow">Projects</span>
              <button className="nav-add-button" type="button" onClick={addProject} aria-label="Add project">
                <FolderPlus size={14} />
              </button>
            </div>
            {sidebarCategories.map((name) => (
              <button
                key={name}
                className={name === category ? "nav-row is-active" : "nav-row"}
                onClick={() => {
                  setCategory(name);
                  setTag(undefined);
                  setSelectedId(null);
                }}
              >
                <Folder size={15} />
                <span>{name}</span>
                <em>{name === "All" ? items.length : items.filter((item) => item.category === name).length}</em>
              </button>
            ))}
          </nav>

          <nav className="nav-section" aria-label="Tags">
            <div className="nav-section-head">
              <span className="eyebrow">Tags</span>
              <button className="nav-add-button" type="button" onClick={addTag} aria-label="Add tag">
                <Tag size={14} />
              </button>
            </div>
            {tags.length === 0 && <p className="empty-copy compact">Tags appear here as you add items.</p>}
            {tags.map((name) => (
              <button
                key={name}
                className={name === tag ? "nav-row tag-row is-active" : "nav-row tag-row"}
                onClick={() => {
                  setTag(name === tag ? undefined : name);
                  setSelectedId(null);
                }}
              >
                <span className="tag-dot" style={{ background: tagColor(name) }} />
                <span>{name}</span>
                <em>{items.filter((item) => item.tags.includes(name)).length}</em>
              </button>
            ))}
          </nav>

          <div className="sidebar-summary">
            <Shield size={20} />
            <div>
              <strong>Local vault</strong>
              <span>{items.length} items - encrypted</span>
            </div>
          </div>
        </aside>

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
            {(["all", "note", "link", "repo", "image", "password", "private"] as Array<ItemType | "all">).map((value) => (
              <button key={value} className={value === type ? "chip is-active" : "chip"} onClick={() => setType(value)}>
                {value === "all" ? "All" : TYPE_META[value].label}
              </button>
            ))}
          </div>

          <div className="list-heading">
            <strong>{items.length} items</strong>
            <span>{tag ? `#${tag}` : category}</span>
          </div>

          <div className="item-list">
            {items.length === 0 && <EmptyList onAdd={() => setModalOpen(true)} />}
            {items.map((item) => (
              <ItemRow key={item.id} item={item} active={item.id === selected?.id} onClick={() => setSelectedId(item.id)} />
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
          onAutoLockMs={setAutoLockMs}
          onClose={() => setSettingsOpen(false)}
          onImported={async () => {
            setStatus(await api.vaultStatus());
            setItems([]);
            setSelectedId(null);
          }}
          onStatus={setStatus}
          onTheme={setTheme}
          onToast={flash}
          status={status}
          theme={theme}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </main>
  );

  function flash(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }
}

function ItemRow({ item, active, onClick }: { item: VaultItem; active: boolean; onClick: () => void }) {
  const Icon = TYPE_META[item.type].icon;

  return (
    <button className={active ? "item-row is-active" : "item-row"} onClick={onClick}>
      <span className="type-dot" style={{ color: TYPE_META[item.type].color }}>
        <Icon size={17} />
      </span>
      <span>
        <strong>{item.title}</strong>
        <small>{item.category} {item.tags.map((tag) => `#${tag}`).join(" ")}</small>
      </span>
      <time>{new Date(item.updatedAt).toLocaleDateString()}</time>
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
  const [secret, setSecret] = useState<Record<string, string> | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [previews, setPreviews] = useState<Record<string, AttachmentPreview>>({});

  useEffect(() => {
    setSecret(null);
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
        <h2>No item selected</h2>
        <p className="empty-copy">Add a note, link, repo, image, or password to start filling the vault.</p>
      </section>
    );
  }

  const Icon = TYPE_META[item.type].icon;

  async function reveal() {
    if (!item) return;
    if (revealed) {
      setRevealed(false);
      return;
    }

    const nextSecret = await api.revealSecret(item.id);
    setSecret(nextSecret);
    setRevealed(true);
  }

  async function remove() {
    if (!item || !window.confirm(`Delete "${item.title}"?`)) return;
    await api.deleteItem(item.id);
    await onChanged();
  }

  async function openPrimaryTarget() {
    if (!item) return;
    if (item.url) {
      await api.openExternal(item.url);
      return;
    }
    if (item.repoPath?.startsWith("http")) {
      await api.openExternal(item.repoPath);
      return;
    }
    if (item.repoPath) {
      await api.openPath(item.repoPath);
    }
  }

  async function openTarget(target: string) {
    if (/^https?:\/\//i.test(target)) {
      await api.openExternal(target);
      return;
    }
    await api.openPath(target);
  }

  async function copyText(text: string, message = "Copied") {
    try {
      await api.copyText(text);
    } catch {
      await navigator.clipboard?.writeText(text);
    }
    onToast(message);
  }

  const primaryTarget = item.url ?? item.repoPath;
  const imageAttachments = item.attachments.filter((attachment) => attachment.kind !== "file");
  const heroAttachment = imageAttachments[0];
  const heroPreview = heroAttachment ? previews[heroAttachment.id] : undefined;
  const legacyRepoRemote = item.type === "repo" ? extractLegacyRepoRemote(item.content) : undefined;
  const repoTargets = item.type === "repo" ? uniqueStrings([item.repoPath, item.url, legacyRepoRemote]) : [];
  const detailContent = item.type === "repo" ? stripLegacyRepoRemote(item.content) : item.content;
  const showGenericAttachments = item.type !== "password";

  return (
    <section className="detail-pane">
      <div className="detail-head">
        <span className="detail-icon" style={{ color: TYPE_META[item.type].color }}>
          <Icon size={22} />
        </span>
        <div>
          <span className="eyebrow" style={{ color: TYPE_META[item.type].color }}>{TYPE_META[item.type].label}</span>
          <h1>{item.title}</h1>
          <p>{item.category} {item.tags.map((tag) => `#${tag}`).join(" ")}</p>
        </div>
        <div className="detail-actions">
          <button className="icon-button" onClick={() => onEdit(item)} aria-label="Edit item">
            <Edit3 size={17} />
          </button>
          <button className="icon-button danger" onClick={remove} aria-label="Delete item">
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

      {item.type !== "password" && (item.type === "note" ? <MarkdownPreview markdown={item.content} /> : detailContent && <p className="detail-copy">{detailContent}</p>)}

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
              <button className="mini-button" type="button" onClick={() => api.openPath(attachment.filePath)}>
                <ExternalLink size={14} />
                Open
              </button>
            </div>
          ))}
        </div>
      )}

      {showGenericAttachments && item.attachments.length === 0 && <p className="empty-copy">No attachments for this item yet.</p>}
    </section>
  );
}

function PasswordDetail({ api, item, onToast }: { api: CachetteApi; item: VaultItem; onToast: (message: string) => void }) {
  const [secret, setSecret] = useState<Record<string, string>>({});
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .revealSecret(item.id)
      .then((nextSecret) => {
        if (!cancelled) setSecret(nextSecret);
      })
      .catch((error) => onToast(error instanceof Error ? error.message : "Could not load password."));
    return () => {
      cancelled = true;
    };
  }, [api, item.id, onToast]);

  async function copySecret(value: string, label: string) {
    if (!value) return;
    try {
      await api.copyText(value);
      window.setTimeout(() => {
        void api.copyText("");
      }, 15_000);
      onToast(`${label} copied`);
    } catch (error) {
      onToast(error instanceof Error ? error.message : "Could not copy secret.");
    }
  }

  async function openWebsite() {
    if (!item.url) return;
    await api.openExternal(item.url);
  }

  const username = secret.username ?? "";
  const password = secret.password ?? "";
  const notes = secret.notes || item.content;

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
          <p>{notes}</p>
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
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!item.encryptedData) return;
    api
      .revealSecret(item.id)
      .then((secret) => {
        if (cancelled) return;
        setUsername(secret.username ?? "");
        setPassword(secret.password ?? "");
        setSecretNotes(secret.notes ?? "");
      })
      .catch((revealError) => setError(revealError instanceof Error ? revealError.message : "Could not load encrypted fields."));
    return () => {
      cancelled = true;
    };
  }, [api, item.encryptedData, item.id]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const tags = tagsText
      .split(",")
      .map((tag) => tag.trim().replace(/^#/, "").toLowerCase())
      .filter(Boolean);
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
      setError(saveError instanceof Error ? saveError.message : "Could not update this item.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal-sheet" onSubmit={submit}>
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
            <div className="markdown-field">
              <div className="field-label-row">
                <span>Note <em>Markdown supported</em></span>
                <div className="segmented-control">
                  <button type="button" className={noteMode === "write" ? "is-active" : ""} onClick={() => setNoteMode("write")}>
                    Write
                  </button>
                  <button type="button" className={noteMode === "preview" ? "is-active" : ""} onClick={() => setNoteMode("preview")}>
                    Preview
                  </button>
                </div>
              </div>
              {noteMode === "write" ? (
                <textarea className="mono-input" value={content} onChange={(event) => setContent(event.target.value)} rows={7} />
              ) : (
                <div className="markdown-preview-box">
                  <MarkdownPreview markdown={content} />
                </div>
              )}
            </div>
          )}

          {item.type === "link" && (
            <>
              <label>
                <span>URL</span>
                <input className="mono-input" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" />
              </label>
              <label>
                <span>Description</span>
                <input value={content} onChange={(event) => setContent(event.target.value)} placeholder="Why is this worth keeping?" />
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
                <input value={content} onChange={(event) => setContent(event.target.value)} placeholder="Repo notes" />
              </label>
            </>
          )}

          {item.encryptedData && (
            <>
              <label>
                <span>Username</span>
                <input className="mono-input" value={username} onChange={(event) => setUsername(event.target.value)} />
              </label>
              <label>
                <span>Password</span>
                <input className="mono-input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
              </label>
              <label>
                <span>Secret notes</span>
                <input value={secretNotes} onChange={(event) => setSecretNotes(event.target.value)} />
              </label>
              {item.type === "password" && (
                <label>
                  <span>Website</span>
                  <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" />
                </label>
              )}
            </>
          )}

          {item.type !== "note" && item.type !== "link" && item.type !== "repo" && !item.encryptedData && (
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

function SetupScreen({ api, status, onStatus }: { api: CachetteApi; status: VaultStatus; onStatus: (status: VaultStatus) => void }) {
  const [step, setStep] = useState(0);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState("");

  const strength = password.length >= 18 ? 4 : password.length >= 14 ? 3 : password.length >= 10 ? 2 : password.length >= 8 ? 1 : 0;
  const mismatch = confirm && password !== confirm;
  const passwordBad = password.length < 8 || password !== confirm;

  function next() {
    setError("");
    if (step === 0) {
      setStep(1);
      return;
    }
    if (passwordBad) {
      setError(password.length < 8 ? "Use at least 8 characters." : "Passwords do not match.");
      return;
    }
    setStep(2);
  }

  async function finish() {
    setError("");
    try {
      onStatus(await api.setupVault(password, remember && status.secureStorageAvailable));
    } catch (setupError) {
      setError(setupError instanceof Error ? setupError.message : "Could not create vault.");
    }
  }

  return (
    <main className="auth-shell onboarding-shell">
      <section className="onboarding-panel">
        <div className="step-bars" aria-label={`Onboarding step ${step + 1} of 3`}>
          {[0, 1, 2].map((index) => (
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
            <p>Cachette is a local, encrypted box for screenshots, links, repos, notes and secrets. Nothing ever leaves this machine.</p>
            <div className="feature-stack">
              <FeatureLine icon={<Shield size={17} />} title="AES-256-GCM encryption" text="Secrets are sealed field-by-field before they touch disk." />
              <FeatureLine icon={<Layers size={17} />} title="One box, five shapes" text="Passwords, notes, links, repo paths and images - organized by project and tag." />
              <FeatureLine icon={<Download size={17} />} title="Encrypted backups" text="Export the whole vault as a single .enc file. Import it anywhere." />
            </div>
            <button className="primary-button wide onboarding-primary" type="button" onClick={next}>Set up my vault</button>
          </>
        )}

        {step === 1 && (
          <>
            <h1 className="compact-title">Create your master password</h1>
            <p>This is the only key to your vault. It is never stored and cannot be recovered - choose something long and memorable.</p>
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
                <span>Your password is stretched with <strong>PBKDF2 (600,000 iterations)</strong> into an AES-256 key on this device. We keep a verifier hash only - never the password.</span>
              </div>
              <div className="onboarding-actions">
                <button className="secondary-button" type="button" onClick={() => setStep(0)}>Back</button>
                <button className="primary-button" type="button" disabled={passwordBad} onClick={next}>Continue</button>
              </div>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className="check-orb"><Check size={28} /></div>
            <h1 className="compact-title">Your vault is sealed</h1>
            <p>Here is how Cachette will protect what you put inside.</p>
            <div className="security-table">
              <div><span>Cipher</span><strong>AES-256-GCM</strong></div>
              <div><span>Key derivation</span><strong>PBKDF2 - 600k</strong></div>
              <div><span>Storage</span><strong>SQLite - local only</strong></div>
              <div>
                <span>Also unlock with Windows Hello</span>
                <button
                  className={remember ? "toggle is-on" : "toggle"}
                  type="button"
                  disabled={!status.secureStorageAvailable}
                  onClick={() => setRemember((current) => !current)}
                  aria-pressed={remember}
                >
                  <span />
                </button>
              </div>
            </div>
            <div className="secure-storage-copy">Windows Hello stores the vault key in the Windows Credential Locker, gated by your face, fingerprint or PIN.</div>
            {error && <p className="form-error">{error}</p>}
            <button className="primary-button wide onboarding-primary" type="button" onClick={finish}>Enter my vault</button>
          </>
        )}
      </section>
    </main>
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
  onAutoLockMs,
  onClose,
  onImported,
  onStatus,
  onTheme,
  onToast,
  status,
  theme
}: {
  api: CachetteApi;
  autoLockMs: number;
  onAutoLockMs: (value: number) => void;
  onClose: () => void;
  onImported: () => Promise<void>;
  onStatus: (status: VaultStatus) => void;
  onTheme: (theme: Theme) => void;
  onToast: (message: string) => void;
  status: VaultStatus;
  theme: Theme;
}) {
  const [settings, setSettings] = useState<VaultSettings>({ osCredentialStored: false });
  const [busy, setBusy] = useState("");

  useEffect(() => {
    api.settingsStatus().then(setSettings).catch((error) => showError(error, onToast));
  }, [api, onToast]);

  async function toggleOsCredential() {
    if (!status.secureStorageAvailable || busy) return;
    setBusy("os");
    try {
      const nextSettings = settings.osCredentialStored ? await api.forgetOsStorage() : await api.rememberWithOsStorage();
      setSettings(nextSettings);
      onToast(nextSettings.osCredentialStored ? "Windows Hello unlock enabled" : "Windows Hello unlock disabled");
    } catch (error) {
      showError(error, onToast);
    } finally {
      setBusy("");
    }
  }

  async function changePassword() {
    const currentPassword = window.prompt("Current master password");
    const nextPassword = currentPassword ? window.prompt("New master password") : null;
    if (!currentPassword || !nextPassword) return;

    setBusy("password");
    try {
      onStatus(await api.changeMasterPassword(currentPassword, nextPassword));
      setSettings(await api.settingsStatus());
      onToast("Master password changed");
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
            <div className="settings-row">
              <span>
                <strong>Windows Hello unlock</strong>
                <small>Key held in Windows Credential Locker</small>
              </span>
              <button
                className={settings.osCredentialStored ? "toggle is-on" : "toggle"}
                disabled={!status.secureStorageAvailable || busy === "os"}
                onClick={toggleOsCredential}
                type="button"
                aria-pressed={settings.osCredentialStored}
              >
                <span />
              </button>
            </div>
            <div className="settings-row">
              <span>
                <strong>Master password</strong>
              </span>
              <button className="mini-button" disabled={busy === "password"} onClick={changePassword} type="button">
                Change...
              </button>
            </div>
          </div>

          <span className="eyebrow">Backup</span>
          <div className="settings-group">
            <div className="settings-row">
              <span>
                <strong>Export encrypted backup</strong>
                <small>Single .enc file, sealed with your backup password</small>
              </span>
              <button className="mini-button" type="button" onClick={() => exportBackup(api, onToast)}>
                <Download size={14} />
                Export
              </button>
            </div>
            <div className="settings-row">
              <span>
                <strong>Import backup</strong>
                <small>Merges items after checking that backup password</small>
              </span>
              <button className="mini-button" type="button" onClick={() => importBackup(api, onImported, onToast)}>
                <Upload size={14} />
                Import...
              </button>
            </div>
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
        </div>
      </section>
    </div>
  );
}

function strengthLabel(strength: number) {
  return ["Too short", "Starter strength", "Getting stronger", "Strong", "Very strong"][strength];
}

function deriveRepoTitle(value: string) {
  const trimmed = value.trim().replace(/[\\\/]+$/, "");
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    return url.pathname.split("/").filter(Boolean).pop()?.replace(/\.git$/i, "") ?? url.hostname;
  } catch {
    return trimmed.split(/[\\\/]/).filter(Boolean).pop() ?? trimmed;
  }
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

function UnlockScreen({ api, status, onStatus }: { api: CachetteApi; status: VaultStatus; onStatus: (status: VaultStatus) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    try {
      onStatus(await api.unlockVault(password));
    } catch (unlockError) {
      setError(unlockError instanceof Error ? unlockError.message : "Could not unlock vault.");
    }
  }

  return (
    <main className="auth-shell lock-shell">
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
        {status.secureStorageAvailable && (
          <button className="secondary-button wide" type="button" onClick={() => api.unlockWithOsStorage().then(onStatus).catch((err) => showError(err, setError))}>
            Unlock with Windows Hello
          </button>
        )}
      </form>
    </main>
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
    <main className="auth-shell">
      <section className="auth-panel">
        <LogoMark className="brand-lock pulse" />
        <h1>Opening vault</h1>
        <p>Preparing the local shell.</p>
      </section>
    </main>
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

async function exportBackup(api: CachetteApi, toast: (message: string) => void) {
  const password = window.prompt("Choose a password for this encrypted backup.");
  if (!password) return;
  const result = await api.exportBackup(password);
  toast(`Backup exported: ${result.filePath}`);
}

async function importBackup(api: CachetteApi, onImported: () => Promise<void>, toast: (message: string) => void) {
  const backupPath = window.prompt("Paste the .enc backup file path to import.");
  const password = backupPath ? window.prompt("Backup password") : null;
  if (!backupPath || !password) return;
  await api.importBackup(backupPath, password);
  toast("Backup imported. Unlock again with the imported vault password.");
  await onImported();
}

function showError(error: unknown, setMessage: (message: string) => void) {
  setMessage(error instanceof Error ? error.message : "Something went wrong.");
}

function createBrowserFallbackApi(): CachetteApi {
  let initialized = false;
  let unlocked = false;
  let items: VaultItem[] = [];

  return {
    vaultStatus: async () => ({ initialized, unlocked, secureStorageAvailable: false, itemCount: items.length }),
    setupVault: async () => {
      initialized = true;
      unlocked = true;
      return { initialized, unlocked, secureStorageAvailable: false, itemCount: items.length };
    },
    unlockVault: async () => {
      unlocked = true;
      return { initialized, unlocked, secureStorageAvailable: false, itemCount: items.length };
    },
    unlockWithOsStorage: async () => ({ initialized, unlocked, secureStorageAvailable: false, itemCount: items.length }),
    lockVault: async () => {
      unlocked = false;
      return { initialized, unlocked, secureStorageAvailable: false, itemCount: items.length };
    },
    listItems: async (filters) => {
      const search = filters?.search?.toLowerCase();
      return items.filter((item) => {
        if (filters?.type && filters.type !== "all" && item.type !== filters.type) return false;
        if (filters?.category && item.category !== filters.category) return false;
        if (filters?.tag && !item.tags.includes(filters.tag)) return false;
        return !search || `${item.title} ${item.content} ${item.tags.join(" ")}`.toLowerCase().includes(search);
      });
    },
    createItem: async (draft) => {
      const now = new Date().toISOString();
      const item: VaultItem = {
        id: crypto.randomUUID(),
        type: draft.type,
        title: draft.title,
        content: draft.content ?? "",
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
      items = items.map((item) => (item.id === update.id ? { ...item, ...update, updatedAt: new Date().toISOString() } : item));
      return items.find((item) => item.id === update.id)!;
    },
    deleteItem: async (id) => {
      items = items.filter((item) => item.id !== id);
    },
    pickAttachments: async () => [],
    addAttachments: async () => [],
    attachmentPreview: async () => null,
    revealSecret: async () => ({ password: "Browser preview does not decrypt secrets." }),
    exportBackup: async () => ({ filePath: "browser-preview.enc" }),
    importBackup: async () => undefined,
    settingsStatus: async () => ({ osCredentialStored: false }),
    rememberWithOsStorage: async () => ({ osCredentialStored: false }),
    forgetOsStorage: async () => ({ osCredentialStored: false }),
    changeMasterPassword: async () => ({ initialized, unlocked, secureStorageAvailable: false, itemCount: items.length }),
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
