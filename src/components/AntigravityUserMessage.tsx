"use client";

import { extractInlineAttachmentsFromText, formatFileSize } from "@/lib/acp/attachments";
import type { UserMessageAttachmentMeta } from "@/lib/acp/types";
import type { UserMessage } from "@openuidev/react-headless";
import { parseMessage } from "@openuidev/react-lang";
import {
  ChevronDown,
  FileSpreadsheet,
  FileText,
  Image as ImageIcon,
} from "lucide-react";
import { useState } from "react";

type UserMessageWithAttachments = UserMessage & {
  attachments?: UserMessageAttachmentMeta[];
};

function parseContextForDisplay(context: unknown): Record<string, unknown> {
  if (Array.isArray(context)) {
    const stateObj = context.find(
      (item) => item !== null && typeof item === "object" && !Array.isArray(item),
    ) as Record<string, unknown> | undefined;
    return stateObj ?? {};
  }
  if (typeof context === "object" && context !== null) {
    return context as Record<string, unknown>;
  }
  return {};
}

function getEntries(state: Record<string, unknown>): Array<{ label: string; value: string }> {
  const isNested = Object.values(state).some(
    (v) =>
      v !== null &&
      typeof v === "object" &&
      !("value" in v) &&
      Object.values(v as Record<string, unknown>).some(
        (f) => f !== null && typeof f === "object" && "value" in f,
      ),
  );
  const entries: Array<{ label: string; value: string }> = [];
  if (isNested) {
    for (const [, fields] of Object.entries(state)) {
      if (typeof fields !== "object" || fields === null) continue;
      for (const [fieldName, field] of Object.entries(fields as Record<string, unknown>)) {
        if (field && typeof field === "object" && "value" in field) {
          const val = (field as { value?: unknown }).value;
          if (val !== undefined && val !== null && val !== "") {
            entries.push({ label: fieldName, value: String(val) });
          }
        }
      }
    }
  } else {
    for (const [fieldName, field] of Object.entries(state)) {
      if (field && typeof field === "object" && "value" in field) {
        const val = (field as { value?: unknown }).value;
        if (val !== undefined && val !== null && val !== "") {
          entries.push({ label: fieldName, value: String(val) });
        }
      }
    }
  }
  return entries;
}

function FormDataAccordion({ state }: { state: Record<string, unknown> }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const entries = getEntries(state);
  if (entries.length === 0) return null;

  return (
    <div className="openui-genui-user-message__form-state">
      <button
        className="openui-genui-user-message__form-state-header"
        onClick={() => setIsExpanded((v) => !v)}
        type="button"
      >
        <span className="openui-genui-user-message__form-state-label">
          Form data ({entries.length} {entries.length === 1 ? "field" : "fields"})
        </span>
        <ChevronDown
          size={14}
          className={`openui-genui-user-message__form-state-chevron${
            isExpanded ? " openui-genui-user-message__form-state-chevron--expanded" : ""
          }`}
        />
      </button>
      {isExpanded && (
        <div className="openui-genui-user-message__form-state-content">
          {entries.map(({ label, value }) => (
            <div key={label} className="openui-genui-user-message__form-field">
              <span className="openui-genui-user-message__form-field-label">{label}:</span>
              <span className="openui-genui-user-message__form-field-value">{value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function isSpreadsheetFile(name: string, mimeType: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.endsWith(".csv") ||
    lower.endsWith(".tsv") ||
    lower.endsWith(".xlsx") ||
    lower.endsWith(".xls") ||
    mimeType.includes("csv") ||
    mimeType.includes("spreadsheet")
  );
}

/**
 * Renders user messages in the chat canvas, displaying any attached files or images
 * alongside the message text and form submission payloads.
 */
export function AntigravityUserMessage({ message }: { message: UserMessage }) {
  const msg = message as UserMessageWithAttachments;
  const rawContent = typeof msg.content === "string" ? msg.content : "";
  const { content: humanText, context } = parseMessage(rawContent);
  const { cleanText: displayText, attachments: inlineAttachments } =
    extractInlineAttachmentsFromText(humanText);
  const formState = parseContextForDisplay(context);
  const hasFormData = Object.keys(formState).length > 0;
  const explicitAttachments = msg.attachments ?? [];
  const seenNames = new Set(explicitAttachments.map((a) => a.name));
  const attachments = [
    ...explicitAttachments,
    ...inlineAttachments.filter((a) => !seenNames.has(a.name)),
  ];

  return (
    <div className="openui-shell-thread-message-user">
      <div className="openui-genui-user-message">
        {attachments.length > 0 && (
          <div
            className="flex flex-wrap justify-end gap-1.5"
            aria-label="Attached files"
          >
            {attachments.map((att) => {
              const sizeText = formatFileSize(att.size);
              const isSheet = isSpreadsheetFile(att.name, att.mimeType);

              if (att.kind === "image" && "data" in att && att.data) {
                return (
                  <div
                    key={att.id}
                    className="flex flex-col items-end gap-1 rounded-xl border border-black/10 dark:border-white/15 bg-black/[0.02] dark:bg-white/[0.04] p-1.5"
                  >
                    <img
                      src={`data:${att.mimeType};base64,${att.data}`}
                      alt={att.name}
                      className="max-h-36 max-w-[220px] rounded-lg object-cover"
                    />
                    <span className="max-w-[200px] truncate px-1 text-[11px] opacity-75">
                      {att.name}
                    </span>
                  </div>
                );
              }

              return (
                <span
                  key={att.id}
                  title={`${att.name}${sizeText ? ` (${sizeText})` : ""}`}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-black/12 dark:border-white/15 bg-black/[0.03] dark:bg-white/[0.06] px-2.5 py-1 text-xs"
                >
                  {att.kind === "image" ? (
                    <ImageIcon className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden="true" />
                  ) : isSheet ? (
                    <FileSpreadsheet
                      className="h-3.5 w-3.5 shrink-0 opacity-70"
                      aria-hidden="true"
                    />
                  ) : (
                    <FileText className="h-3.5 w-3.5 shrink-0 opacity-70" aria-hidden="true" />
                  )}
                  <span className="max-w-[200px] truncate font-medium">{att.name}</span>
                  {sizeText && (
                    <span className="text-[10px] opacity-60 tabular-nums">{sizeText}</span>
                  )}
                </span>
              );
            })}
          </div>
        )}

        {hasFormData && <FormDataAccordion state={formState} />}

        {displayText && (
          <div className="openui-shell-thread-message-user__content">
            <div className="whitespace-pre-wrap break-words">{displayText}</div>
          </div>
        )}
      </div>
    </div>
  );
}
