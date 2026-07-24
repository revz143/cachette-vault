"use client";

import { FileImage, FolderGit2, KeyRound, Link2, NotebookPen, Upload, X } from "lucide-react";
import type { ComponentType, DragEvent, FormEvent } from "react";
import { useMemo, useState } from "react";
import type { CachetteApi, ItemDraft, ItemType, PickedFile } from "@/shared/types";
import { MarkdownPreview } from "./MarkdownPreview";

type QuickAddType = Exclude<ItemType, "private">;

const TYPES: Array<{ type: QuickAddType; label: string; desc: string; icon: ComponentType<{ size?: number }> }> = [
  { type: "password", label: "Password", desc: "Logins, API keys, secrets", icon: KeyRound },
  { type: "note", label: "Note", desc: "Markdown notes and snippets", icon: NotebookPen },
  { type: "link", label: "Link", desc: "Websites worth keeping", icon: Link2 },
  { type: "repo", label: "Repo", desc: "Local paths and remotes", icon: FolderGit2 },
  { type: "image", label: "Image", desc: "Screenshots and references", icon: FileImage }
];

type AddItemModalProps = {
  api: CachetteApi;
  categories: string[];
  onClose: () => void;
  onSave: (draft: ItemDraft) => Promise<void>;
};

export function AddItemModal({ api, categories, onClose, onSave }: AddItemModalProps) {
  const [step, setStep] = useState<"pick" | "form">("pick");
  const [type, setType] = useState<QuickAddType | null>(null);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState(categories[0] ?? "General");
  const [tagsText, setTagsText] = useState("");
  const [body, setBody] = useState("");
  const [noteMode, setNoteMode] = useState<"write" | "preview">("write");
  const [notes, setNotes] = useState("");
  const [url, setUrl] = useState("");
  const [repoPath, setRepoPath] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [attachments, setAttachments] = useState<PickedFile[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const selectedType = useMemo(() => TYPES.find((item) => item.type === type), [type]);
  const tags = tagsText
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);

  function pickType(nextType: QuickAddType) {
    setType(nextType);
    setStep("form");
    setError("");
  }

  function back() {
    if (step === "form") {
      setStep("pick");
      setError("");
      return;
    }
    onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    if (!type) {
      setError("Choose what you want to add first.");
      return;
    }

    const resolvedTitle = title.trim() || (type === "repo" ? deriveRepoTitle(repoPath || remoteUrl) : "");

    if (!resolvedTitle) {
      setError("Add a title before saving.");
      return;
    }

    const encryptedData: ItemDraft["encryptedData"] =
      type === "password"
        ? { username, password, notes }
        : undefined;

    const content =
      type === "note"
        ? body
        : type === "link"
          ? notes
          : notes;

    const draft: ItemDraft = {
      type,
      title: resolvedTitle,
      category,
      tags,
      content,
      url: type === "link" || type === "password" ? url : undefined,
      ...(type === "repo" ? { url: remoteUrl || undefined } : {}),
      repoPath: type === "repo" ? repoPath : undefined,
      encryptedData,
      attachmentPaths: attachments.map((file) => file.path)
    };

    setSaving(true);
    try {
      await onSave(draft);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save this item.");
    } finally {
      setSaving(false);
    }
  }

  async function pickFiles() {
    const picked = await api.pickAttachments();
    setAttachments((current) => mergePickedFiles(current, picked));
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    const picked = Array.from(event.dataTransfer.files)
      .map((file) => {
        const fileWithPath = file as File & { path?: string };
        return fileWithPath.path ? { path: fileWithPath.path, name: file.name } : undefined;
      })
      .filter(Boolean) as PickedFile[];

    if (!picked.length) {
      setError("Drag files from your desktop into the Electron app, or use Browse.");
      return;
    }

    setAttachments((current) => mergePickedFiles(current, picked));
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal-sheet" onSubmit={submit}>
        <div className="modal-head">
          <strong>{selectedType ? `New ${selectedType.label.toLowerCase()}` : "Add to vault"}</strong>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close modal">
            <X size={18} />
          </button>
        </div>

        {step === "pick" && (
          <div className="quick-type-grid" role="list" aria-label="Item type">
            {TYPES.map((item) => {
              const Icon = item.icon;
              return (
                <button className="quick-type-tile" key={item.type} type="button" onClick={() => pickType(item.type)}>
                  <span className="quick-type-icon" style={{ color: typeColor(item.type) }}>
                    <Icon size={18} />
                  </span>
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.desc}</small>
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {step === "form" && type && (
          <>
            <div className="quick-form">
              <label>
                <span>Title</span>
                <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={titlePlaceholder(type)} />
              </label>

              {type === "password" && (
                <>
                  <label>
                    <span>Username</span>
                    <input className="mono-input" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="you@example.com" />
                  </label>
                  <label>
                    <span>Password <em>will be encrypted</em></span>
                    <input
                      className="mono-input"
                      type="password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      placeholder="********"
                    />
                  </label>
                  <label>
                    <span>Website (optional)</span>
                    <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" />
                  </label>
                </>
              )}

              {type === "note" && (
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
                    <textarea
                      className="mono-input"
                      value={body}
                      onChange={(event) => setBody(event.target.value)}
                      rows={6}
                      placeholder={"# Heading\n\n- bullet\n\n**bold** and `code`"}
                    />
                  ) : (
                    <div className="markdown-preview-box">
                      <MarkdownPreview markdown={body} />
                    </div>
                  )}
                </div>
              )}

              {type === "link" && (
                <>
                  <label>
                    <span>URL</span>
                    <input className="mono-input" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" />
                  </label>
                  <label>
                    <span>Description (optional)</span>
                    <input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Why is this worth keeping?" />
                  </label>
                </>
              )}

              {type === "repo" && (
                <>
                  <label>
                    <span>Local path</span>
                    <input className="mono-input" value={repoPath} onChange={(event) => setRepoPath(event.target.value)} placeholder="C:\\dev\\my-project" />
                  </label>
                  <label>
                    <span>Remote URL (optional)</span>
                    <input className="mono-input" value={remoteUrl} onChange={(event) => setRemoteUrl(event.target.value)} placeholder="https://github.com/..." />
                  </label>
                </>
              )}

              {type === "image" && (
                <button type="button" className="quick-drop" onClick={pickFiles} onDrop={handleDrop} onDragOver={(event) => event.preventDefault()}>
                  <Upload size={22} />
                  <strong>{attachments.length ? attachments.map((file) => file.name).join(", ") : "Browse or drop image"}</strong>
                  <span>PNG, JPG, GIF or WebP - or drop anywhere in the window</span>
                </button>
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
              <button type="button" className="secondary-button" onClick={back}>
                Back
              </button>
              <div className="spacer" />
              <button className="primary-button" disabled={saving || !(title.trim() || (type === "repo" && (repoPath.trim() || remoteUrl.trim())))} type="submit">
                {saving ? "Saving..." : "Save to vault"}
              </button>
            </div>
          </>
        )}

        {error && <p className="form-error">{error}</p>}
      </form>
    </div>
  );
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

function titlePlaceholder(type: QuickAddType) {
  return {
    password: "e.g. GitHub - work",
    note: "e.g. Meeting notes",
    link: "e.g. CSS grid guide",
    repo: "e.g. aurora-app",
    image: "e.g. Dashboard screenshot"
  }[type];
}

function typeColor(type: QuickAddType) {
  return {
    password: "var(--tpass)",
    note: "var(--tnote)",
    link: "var(--tlink)",
    repo: "var(--trepo)",
    image: "var(--timg)"
  }[type];
}

function mergePickedFiles(current: PickedFile[], picked: PickedFile[]) {
  const known = new Set(current.map((file) => file.path));
  return [...current, ...picked.filter((file) => !known.has(file.path))];
}
