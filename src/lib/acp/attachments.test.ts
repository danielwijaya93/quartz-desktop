import { describe, expect, it } from "vitest";
import { classifyAttachmentKind, formatFileSize, inferMimeType } from "./attachments";

describe("attachments helpers", () => {
  it("classifies images, text/data files, and binary documents", () => {
    expect(classifyAttachmentKind("photo.png", "image/png")).toBe("image");
    expect(classifyAttachmentKind("report.csv", "")).toBe("text");
    expect(classifyAttachmentKind("data.csv", "application/vnd.ms-excel")).toBe("text");
    expect(classifyAttachmentKind("notes.md", "text/markdown")).toBe("text");
    expect(classifyAttachmentKind("config.json", "application/json")).toBe("text");
    expect(classifyAttachmentKind("icon.svg", "image/svg+xml")).toBe("text");
    expect(classifyAttachmentKind("deck.pdf", "application/pdf")).toBe("binary");
    expect(classifyAttachmentKind("sheet.xlsx", "")).toBe("binary");
  });

  it("infers MIME types when browser leaves them blank or generic", () => {
    expect(inferMimeType("sales.csv", "")).toBe("text/csv");
    expect(inferMimeType("paper.pdf", "application/octet-stream")).toBe("application/pdf");
    expect(inferMimeType("photo.webp", "image/webp")).toBe("image/webp");
    expect(inferMimeType("unknown.bin", "")).toBe("application/octet-stream");
  });

  it("formats byte sizes cleanly", () => {
    expect(formatFileSize(undefined)).toBe("");
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2 KB");
    expect(formatFileSize(1_572_864)).toBe("1.5 MB");
  });
});
