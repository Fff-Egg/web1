import { marked } from "marked";

/**
 * Marked treats two *single* tildes as a strike-through pair, so ordinary Korean
 * numeric ranges such as `2026~27년 ... 15~17%` become one giant `<del>` span.
 * Escape only standalone tildes before parsing; deliberate `~~취소선~~` syntax
 * remains untouched.
 */
export function escapeSingleTildes(markdown: string): string {
  return markdown.replace(/(^|[^~])~(?!~)/g, "$1\\~");
}

/** Shared Markdown renderer for user/LLM prose containing numeric ranges. */
export function renderMarkdown(markdown: string): string {
  return marked.parse(escapeSingleTildes(markdown)) as string;
}
