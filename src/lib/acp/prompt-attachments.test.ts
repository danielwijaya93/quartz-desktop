import { describe, expect, it } from "vitest";
import { buildPromptBlocksFromAttachments } from "./prompt-attachments";

describe("buildPromptBlocksFromAttachments", () => {
  it("encodes images, text/csv resources, and binary blobs into ACP ContentBlocks", () => {
    const { blocks, hasBinaryBlobs } = buildPromptBlocksFromAttachments([
      {
        name: "chart.png",
        mimeType: "image/png",
        kind: "image",
        data: "iVBORw0KGgo=",
      },
      {
        name: "sales report.csv",
        mimeType: "text/csv",
        kind: "text",
        text: "month,revenue\nJan,100\n",
      },
      {
        name: "brief.pdf",
        mimeType: "application/pdf",
        kind: "binary",
        data: "JVBERi0xLjQK",
      },
    ]);

    expect(hasBinaryBlobs).toBe(true);
    expect(blocks).toEqual([
      { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
      {
        type: "resource",
        resource: {
          uri: "attachment:///sales%20report.csv",
          mimeType: "text/csv",
          text: "month,revenue\nJan,100\n",
        },
      },
      {
        type: "resource",
        resource: {
          uri: "attachment:///brief.pdf",
          mimeType: "application/pdf",
          blob: "JVBERi0xLjQK",
        },
      },
    ]);
  });

  it("reports hasBinaryBlobs=false when only text and image attachments are provided", () => {
    const { blocks, hasBinaryBlobs } = buildPromptBlocksFromAttachments([
      {
        name: "notes.md",
        mimeType: "text/markdown",
        text: "# Hello\n",
      },
    ]);

    expect(hasBinaryBlobs).toBe(false);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: "resource",
      resource: {
        uri: "attachment:///notes.md",
        mimeType: "text/markdown",
        text: "# Hello\n",
      },
    });
  });
});
