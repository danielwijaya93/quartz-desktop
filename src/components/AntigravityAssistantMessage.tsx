"use client";

import type { AskQuestionEntry } from "@/lib/acp/types";
import {
  hasOpenUILangSyntax,
  questionsToOpenUILang,
  stripOpenUIFences,
} from "@/lib/openui/lang-helpers";
import {
  useThread,
  type AssistantMessage,
  type Message,
} from "@openuidev/react-headless";
import {
  BuiltinActionType,
  buildMessage,
  parseMessage,
  Renderer,
  type ActionEvent,
} from "@openuidev/react-lang";
import { MarkDownRenderer } from "@openuidev/react-ui";
import { openuiLibrary } from "@openuidev/react-ui/genui-lib";
import { useCallback, useMemo } from "react";

function buildActionUserMessage(event: ActionEvent): string {
  const messageCtx: unknown[] = [`User clicked: ${event.humanFriendlyMessage}`];
  const actionContext = event.params?.["context"];
  if (event.formState || actionContext !== undefined) {
    messageCtx.push(event.formState ?? {});
  }
  if (actionContext !== undefined) {
    messageCtx.push(actionContext);
  }
  const built = buildMessage({ content: event.humanFriendlyMessage, context: messageCtx });
  return event.humanFriendlyMessage ? built : built.slice(built.indexOf("\n") + 1);
}

function findAskQuestionsInTurn(messages: Message[], currentMsgId: string): AskQuestionEntry[] | null {
  const idx = messages.findIndex((m) => m.id === currentMsgId);
  if (idx === -1) return null;

  // Walk backwards in the same turn until the preceding user message
  for (let i = idx; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === "user") break;
    if (m.role === "assistant" && m.toolCalls?.length) {
      for (const tc of [...m.toolCalls].reverse()) {
        if (tc.function.name === "ask_question") {
          try {
            const parsed = JSON.parse(tc.function.arguments || "{}") as {
              questions?: AskQuestionEntry[];
            };
            if (Array.isArray(parsed.questions) && parsed.questions.length > 0) {
              return parsed.questions;
            }
          } catch {
            // ignore malformed JSON
          }
        }
      }
    }
  }
  return null;
}

export function AntigravityAssistantMessage({
  message,
  isStreaming = false,
}: {
  message: AssistantMessage;
  isStreaming?: boolean;
}) {
  const messages = useThread((s) => s.messages);
  const processMessage = useThread((s) => s.processMessage);
  const updateMessage = useThread((s) => s.updateMessage);

  const parsed = useMemo(() => {
    if (!message.content) return { content: "", context: null, attributes: {} };
    return parseMessage(message.content, { streaming: isStreaming });
  }, [message.content, isStreaming]);

  const cleanedContent = useMemo(
    () => stripOpenUIFences(parsed.content ?? "", isStreaming),
    [parsed.content, isStreaming],
  );

  const initialState = useMemo(() => {
    if (Array.isArray(parsed.context) && typeof parsed.context[0] === "object") {
      return parsed.context[0] as Record<string, unknown>;
    }
    if (parsed.context && typeof parsed.context === "object" && !Array.isArray(parsed.context)) {
      return parsed.context as Record<string, unknown>;
    }
    return undefined;
  }, [parsed.context]);

  const handleStateUpdate = useCallback(
    (state: Record<string, unknown>) => {
      const hasState = Object.keys(state).length > 0;
      const fullMessage = buildMessage({
        content: cleanedContent,
        attributes: parsed.attributes,
        context: hasState ? [state] : undefined,
      });
      updateMessage({ ...message, content: fullMessage });
    },
    [updateMessage, message, cleanedContent, parsed.attributes],
  );

  const handleAction = useCallback(
    (event: ActionEvent) => {
      if (event.type === BuiltinActionType.ContinueConversation) {
        void processMessage({ role: "user", content: buildActionUserMessage(event) });
      } else if (event.type === BuiltinActionType.OpenUrl) {
        const url = event.params?.["url"];
        if (typeof window !== "undefined" && typeof url === "string" && url) {
          window.open(url, "_blank", "noopener,noreferrer");
        }
      }
    },
    [processMessage],
  );

  const isOpenUILang = hasOpenUILangSyntax(cleanedContent);

  const synthesizedQuestionForm = useMemo(() => {
    if (isStreaming || isOpenUILang) return null;
    const questions = findAskQuestionsInTurn(messages, message.id);
    if (!questions) return null;
    return questionsToOpenUILang(questions);
  }, [isStreaming, isOpenUILang, messages, message.id]);

  if (!cleanedContent && !synthesizedQuestionForm) {
    return null;
  }

  return (
    <div className="openui-shell-thread-message-assistant openui-shell-thread-message-assistant--without-logo">
      <div className="openui-shell-thread-message-assistant__content">
        {isOpenUILang ? (
          <Renderer
            response={cleanedContent}
            library={openuiLibrary}
            isStreaming={isStreaming}
            onAction={handleAction}
            onStateUpdate={handleStateUpdate}
            initialState={initialState}
          />
        ) : synthesizedQuestionForm ? (
          <Renderer
            response={synthesizedQuestionForm}
            library={openuiLibrary}
            isStreaming={false}
            onAction={handleAction}
            onStateUpdate={handleStateUpdate}
            initialState={initialState}
          />
        ) : (
          <MarkDownRenderer textMarkdown={cleanedContent} variant="card" />
        )}
      </div>
    </div>
  );
}
