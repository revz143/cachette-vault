"use client";

import type { ItemContentFormat } from "@/shared/types";
import { MarkdownPreview } from "./MarkdownPreview";
import { RichTextEditor } from "./RichText";

type NoteContentFieldProps = {
  value: string;
  contentFormat: Extract<ItemContentFormat, "markdown" | "richtext">;
  mode: "write" | "preview";
  onChange: (value: string) => void;
  onContentFormatChange: (format: Extract<ItemContentFormat, "markdown" | "richtext">) => void;
  onModeChange: (mode: "write" | "preview") => void;
  rows?: number;
};

export function NoteContentField({
  value,
  contentFormat,
  mode,
  onChange,
  onContentFormatChange,
  onModeChange,
  rows = 7
}: NoteContentFieldProps) {
  return (
    <div className="markdown-field">
      <div className="field-label-row">
        <span>Note</span>
        <div className="segmented-control">
          <button
            type="button"
            className={contentFormat === "markdown" ? "is-active" : ""}
            onClick={() => onContentFormatChange("markdown")}
          >
            Markdown
          </button>
          <button
            type="button"
            className={contentFormat === "richtext" ? "is-active" : ""}
            onClick={() => onContentFormatChange("richtext")}
          >
            Rich text
          </button>
        </div>
      </div>
      {contentFormat === "markdown" && (
        <>
          <div className="field-label-row compact-row">
            <span><em>Markdown supported</em></span>
            <div className="segmented-control">
              <button type="button" className={mode === "write" ? "is-active" : ""} onClick={() => onModeChange("write")}>
                Write
              </button>
              <button type="button" className={mode === "preview" ? "is-active" : ""} onClick={() => onModeChange("preview")}>
                Preview
              </button>
            </div>
          </div>
          {mode === "write" ? (
            <textarea
              className="mono-input"
              value={value}
              onChange={(event) => onChange(event.target.value)}
              rows={rows}
              placeholder={"# Heading\n\n- bullet\n\n**bold** and `code`"}
            />
          ) : (
            <div className="markdown-preview-box">
              <MarkdownPreview markdown={value} />
            </div>
          )}
        </>
      )}
      {contentFormat === "richtext" && (
        <RichTextEditor value={value} onChange={onChange} rows={rows} />
      )}
    </div>
  );
}
