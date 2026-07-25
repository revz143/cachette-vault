"use client";

import DOMPurify from "dompurify";
import { Bold, Eraser, Italic, Link2, List, ListOrdered, Underline } from "lucide-react";
import { useEffect, useRef } from "react";

type RichTextEditorProps = {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
};

const ALLOWED_FORMATS = new Set(["A", "B", "BR", "DIV", "EM", "I", "LI", "OL", "P", "SPAN", "STRONG", "U", "UL"]);

export function RichTextEditor({ value, onChange, rows = 7 }: RichTextEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || document.activeElement === editor) return;
    editor.innerHTML = sanitizeRichTextHtml(value);
  }, [value]);

  function runCommand(command: string, commandValue?: string) {
    editorRef.current?.focus();
    document.execCommand(command, false, commandValue);
    emitChange();
  }

  function createLink() {
    const href = window.prompt("Paste a link");
    if (!href) return;
    if (!/^(https?:|mailto:)/i.test(href)) return;
    runCommand("createLink", href);
  }

  function emitChange() {
    onChange(sanitizeRichTextHtml(editorRef.current?.innerHTML ?? ""));
  }

  function normalizeEditorHtml() {
    const sanitized = sanitizeRichTextHtml(editorRef.current?.innerHTML ?? "");
    if (editorRef.current) {
      editorRef.current.innerHTML = sanitized;
    }
    onChange(sanitized);
  }

  return (
    <div className="rich-text-field">
      <div className="rich-text-toolbar" aria-label="Rich text tools">
        <button type="button" onClick={() => runCommand("bold")} title="Bold" aria-label="Bold">
          <Bold size={14} />
        </button>
        <button type="button" onClick={() => runCommand("italic")} title="Italic" aria-label="Italic">
          <Italic size={14} />
        </button>
        <button type="button" onClick={() => runCommand("underline")} title="Underline" aria-label="Underline">
          <Underline size={14} />
        </button>
        <button type="button" onClick={() => runCommand("insertUnorderedList")} title="Bullet list" aria-label="Bullet list">
          <List size={14} />
        </button>
        <button type="button" onClick={() => runCommand("insertOrderedList")} title="Numbered list" aria-label="Numbered list">
          <ListOrdered size={14} />
        </button>
        <button type="button" onClick={createLink} title="Link" aria-label="Link">
          <Link2 size={14} />
        </button>
        <button type="button" onClick={() => runCommand("removeFormat")} title="Clear formatting" aria-label="Clear formatting">
          <Eraser size={14} />
        </button>
      </div>
      <div
        ref={editorRef}
        className="rich-text-editor"
        contentEditable
        onBlur={normalizeEditorHtml}
        onInput={emitChange}
        role="textbox"
        aria-multiline="true"
        style={{ minHeight: `${Math.max(rows, 3) * 24}px` }}
        suppressContentEditableWarning
      />
    </div>
  );
}

export function RichTextPreview({ html }: { html: string }) {
  const sanitized = sanitizeRichTextHtml(html);

  if (!sanitized.trim()) {
    return <p className="empty-copy">No note content yet.</p>;
  }

  return <div className="rich-text-preview" dangerouslySetInnerHTML={{ __html: sanitized }} />;
}

export function PlainTextContent({ text }: { text: string }) {
  if (!text.trim()) {
    return null;
  }

  return <p className="detail-copy multiline-copy">{text}</p>;
}

export function sanitizeRichTextHtml(html: string) {
  if (!html.trim() || typeof DOMParser === "undefined") {
    return "";
  }

  // DOMPurify provides the vetted security pass; the walker below then
  // normalizes markup (b -> strong, div -> p, unwrap span) and re-validates
  // link schemes.
  const purified = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ["a", "b", "br", "div", "em", "i", "li", "ol", "p", "span", "strong", "u", "ul"],
    ALLOWED_ATTR: ["href"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i
  });

  const documentNode = new DOMParser().parseFromString(purified, "text/html");
  return Array.from(documentNode.body.childNodes).map(sanitizeNode).join("");
}

function sanitizeNode(node: ChildNode): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeHtml(node.textContent ?? "");
  }

  if (!(node instanceof HTMLElement) || !ALLOWED_FORMATS.has(node.tagName)) {
    return Array.from(node.childNodes).map(sanitizeNode).join("");
  }

  const children = Array.from(node.childNodes).map(sanitizeNode).join("");
  const tagName = normalizedTagName(node.tagName);

  if (tagName === "br") {
    return "<br>";
  }

  if (tagName === "span") {
    return children;
  }

  if (tagName === "a") {
    const href = node.getAttribute("href") ?? "";
    if (!/^(https?:|mailto:)/i.test(href)) {
      return children;
    }

    return `<a href="${escapeAttribute(href)}" target="_blank" rel="noreferrer">${children}</a>`;
  }

  return `<${tagName}>${children}</${tagName}>`;
}

function normalizedTagName(tagName: string) {
  return {
    B: "strong",
    DIV: "p",
    I: "em"
  }[tagName] ?? tagName.toLowerCase();
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
