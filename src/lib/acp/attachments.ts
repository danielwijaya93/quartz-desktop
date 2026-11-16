export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB

export type AttachmentKind = "image" | "text" | "binary";

export interface ComposerAttachmentPayload {
  name: string;
  mimeType: string;
  size?: number;
  kind?: AttachmentKind;
  data?: string;
  text?: string;
}

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "xml",
  "html",
  "htm",
  "css",
  "scss",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "sh",
  "bash",
  "zsh",
  "sql",
  "toml",
  "ini",
  "cfg",
  "conf",
  "log",
  "env",
  "svg",
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  jsonl: "application/x-ndjson",
  yaml: "application/yaml",
  yml: "application/yaml",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  ts: "text/typescript",
  py: "text/x-python",
  sql: "application/sql",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  zip: "application/zip",
};

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/ld+json",
  "application/x-ndjson",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/yaml",
  "application/x-yaml",
  "application/sql",
  "application/csv",
  "image/svg+xml",
]);

function getExtension(fileName: string): string {
  const base = fileName.trim().toLowerCase();
  const idx = base.lastIndexOf(".");
  return idx >= 0 && idx < base.length - 1 ? base.slice(idx + 1) : "";
}

/** Infers a sensible MIME type when the browser omits it or reports `application/octet-stream`. */
export function inferMimeType(fileName: string, rawMimeType?: string): string {
  const trimmed = rawMimeType?.trim() ?? "";
  const ext = getExtension(fileName);
  if (trimmed && trimmed !== "application/octet-stream") {
    return trimmed;
  }
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

/** Classifies an attached file as `image`, `text`, or `binary` for ACP prompt encoding. */
export function classifyAttachmentKind(fileName: string, rawMimeType?: string): AttachmentKind {
  const mime = inferMimeType(fileName, rawMimeType).toLowerCase();
  const ext = getExtension(fileName);

  if (mime.startsWith("image/") && mime !== "image/svg+xml") {
    return "image";
  }
  if (mime.startsWith("text/") || TEXT_MIME_TYPES.has(mime) || TEXT_EXTENSIONS.has(ext)) {
    return "text";
  }
  return "binary";
}

/** Formats byte size into a compact human-readable string (e.g. `42 KB`, `1.4 MB`). */
export function formatFileSize(bytes?: number): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface ExtractedInlineAttachment {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  kind: AttachmentKind;
}

const CONTENT_MARKER_RE = /Content of attachment:\/\/\/([^\r\n:]+):(?:\r?\n)?/g;
const SAVED_MARKER_RE =
  /\[Attached file saved for inspection:\s*[^\n()[\]]+\s*\(([^,()]+),\s*([^()]+)\)\]/g;

function safeDecodeName(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Extracts inline ACP-replayed attachment blocks (`Content of attachment:///...:\n...`
 * or `[Attached file saved for inspection: ...]`) from user message text so the UI renders
 * compact file chips instead of raw file contents.
 */
export function extractInlineAttachmentsFromText(rawText: string): {
  cleanText: string;
  attachments: ExtractedInlineAttachment[];
} {
  if (
    !rawText ||
    (!rawText.includes("Content of attachment:///") &&
      !rawText.includes("[Attached file saved for inspection:"))
  ) {
    return { cleanText: rawText, attachments: [] };
  }

  type Marker =
    | { kind: "content"; index: number; end: number; rawName: string }
    | { kind: "saved"; index: number; end: number; name: string; mimeType: string };

  const markers: Marker[] = [];
  for (const m of rawText.matchAll(CONTENT_MARKER_RE)) {
    if (m.index !== undefined) {
      markers.push({
        kind: "content",
        index: m.index,
        end: m.index + m[0].length,
        rawName: m[1] ?? "attachment",
      });
    }
  }
  for (const m of rawText.matchAll(SAVED_MARKER_RE)) {
    if (m.index !== undefined) {
      markers.push({
        kind: "saved",
        index: m.index,
        end: m.index + m[0].length,
        name: (m[1] ?? "attachment").trim(),
        mimeType: (m[2] ?? "").trim(),
      });
    }
  }

  if (markers.length === 0) {
    return { cleanText: rawText, attachments: [] };
  }

  markers.sort((a, b) => a.index - b.index);
  const cleanText = rawText.slice(0, markers[0]!.index).trimEnd();
  const encoder = new TextEncoder();
  const attachments: ExtractedInlineAttachment[] = [];

  for (let i = 0; i < markers.length; i += 1) {
    const marker = markers[i]!;
    if (marker.kind === "content") {
      const nextIndex = markers[i + 1]?.index ?? rawText.length;
      const body = rawText.slice(marker.end, nextIndex);
      const name = safeDecodeName(marker.rawName);
      const mimeType = inferMimeType(name);
      attachments.push({
        id: `inline-${i}-${name}`,
        name,
        mimeType,
        size: encoder.encode(body).length,
        kind: classifyAttachmentKind(name, mimeType),
      });
    } else {
      const mimeType = inferMimeType(marker.name, marker.mimeType);
      attachments.push({
        id: `saved-${i}-${marker.name}`,
        name: marker.name,
        mimeType,
        kind: classifyAttachmentKind(marker.name, mimeType),
      });
    }
  }

  return { cleanText, attachments };
}
