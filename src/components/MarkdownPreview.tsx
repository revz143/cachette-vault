"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownPreview({ markdown }: { markdown: string }) {
  const normalizedMarkdown = normalizeMarkdown(markdown);

  if (!normalizedMarkdown.trim()) {
    return <p className="empty-copy">No markdown content yet.</p>;
  }

  return (
    <div className="markdown-preview">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{normalizedMarkdown}</ReactMarkdown>
    </div>
  );
}

function normalizeMarkdown(markdown: string) {
  return markdown.replace(/(^|\n)(#{1,6})(?=\S)/g, "$1$2 ");
}
