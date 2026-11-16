import {
  classifyAttachmentKind,
  inferMimeType,
  type ComposerAttachmentPayload,
} from "@/lib/acp/attachments";
import type * as acp from "@agentclientprotocol/sdk";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

function safeAttachmentName(rawName: string, fallbackIndex: number): string {
  const base = path.basename(rawName || `attachment-${fallbackIndex}`);
  return base.replace(/[^\w.-]+/g, "_") || `attachment-${fallbackIndex}`;
}

function resolveAttachmentText(att: ComposerAttachmentPayload): string | null {
  if (typeof att.text === "string") return att.text;
  if (typeof att.data === "string" && att.data.length > 0) {
    return Buffer.from(att.data, "base64").toString("utf8");
  }
  return null;
}

/** Converts composer attachments into ACP `ContentBlock` entries (image, embedded text, or embedded binary blob). */
export function buildPromptBlocksFromAttachments(
  attachments: ComposerAttachmentPayload[],
): { blocks: acp.ContentBlock[]; hasBinaryBlobs: boolean } {
  const blocks: acp.ContentBlock[] = [];
  let hasBinaryBlobs = false;

  for (let i = 0; i < attachments.length; i += 1) {
    const att = attachments[i];
    if (!att) continue;
    const name = att.name?.trim() || `attachment-${i + 1}`;
    const mimeType = inferMimeType(name, att.mimeType);
    const kind = att.kind ?? classifyAttachmentKind(name, mimeType);
    const uri = `attachment:///${encodeURIComponent(name)}`;

    if (kind === "image" && att.data) {
      blocks.push({
        type: "image",
        mimeType,
        data: att.data,
      });
      continue;
    }

    if (kind === "text") {
      const text = resolveAttachmentText(att);
      if (text !== null) {
        blocks.push({
          type: "resource",
          resource: {
            uri,
            mimeType,
            text,
          },
        });
      }
      continue;
    }

    if (att.data) {
      hasBinaryBlobs = true;
      blocks.push({
        type: "resource",
        resource: {
          uri,
          mimeType,
          blob: att.data,
        },
      });
    }
  }

  return { blocks, hasBinaryBlobs };
}

/**
 * Fallback encoder for binary attachments: writes binary payloads to an isolated OS temp folder
 * and emits ACP `resource_link` blocks if the agent rejects inline `BlobResourceContents`.
 */
export async function buildFallbackBlocksWithTempFiles(
  attachments: ComposerAttachmentPayload[],
): Promise<{ blocks: acp.ContentBlock[]; tempDir: string | null }> {
  const blocks: acp.ContentBlock[] = [];
  let tempDir: string | null = null;

  for (let i = 0; i < attachments.length; i += 1) {
    const att = attachments[i];
    if (!att) continue;
    const name = att.name?.trim() || `attachment-${i + 1}`;
    const mimeType = inferMimeType(name, att.mimeType);
    const kind = att.kind ?? classifyAttachmentKind(name, mimeType);

    if (kind === "image" && att.data) {
      blocks.push({ type: "image", mimeType, data: att.data });
      continue;
    }

    if (kind === "text") {
      const text = resolveAttachmentText(att);
      if (text !== null) {
        blocks.push({
          type: "resource",
          resource: {
            uri: `attachment:///${encodeURIComponent(name)}`,
            mimeType,
            text,
          },
        });
      }
      continue;
    }

    if (att.data) {
      if (!tempDir) {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-attachments-"));
      }
      const safeName = safeAttachmentName(name, i + 1);
      const filePath = path.join(tempDir, safeName);
      await fs.writeFile(filePath, Buffer.from(att.data, "base64"));
      blocks.push({
        type: "resource_link",
        uri: `file://${filePath}`,
        name,
        mimeType,
        size: att.size ?? null,
      });
      blocks.push({
        type: "text",
        text: `[Attached file saved for inspection: ${filePath} (${name}, ${mimeType})]`,
      });
    }
  }

  return { blocks, tempDir };
}
