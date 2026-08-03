import { useCallback, useEffect, useRef, useState } from "react";
import { streamChat } from "../lib/api";
import { loadMessages, removeSavedMessages, saveMessages } from "../lib/persist";
import {
  createSessionId,
  getOrCreateSessionId,
  loadRemoteSession,
  replaceSessionUrl,
  saveRemoteSession,
} from "../lib/session";
import { uid } from "../lib/utils";
import type { ChatMessage, ThinkingStep } from "../lib/types";

export function useChat() {
  const [sessionId, setSessionId] = useState(getOrCreateSessionId);
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadMessages(sessionId));
  const [input, setInput] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [thinking, setThinking] = useState<ThinkingStep[]>([]);
  const [thinkingEnabled, setThinkingEnabled] = useState(() => {
    try {
      return window.localStorage.getItem("eduvision-thinking-enabled") === "true";
    } catch {
      return false;
    }
  });
  // 上下文断点是 messages 数组下标。点击“结束上下文”后，下一次请求
  // 只发送断点之后的完整 user/assistant 对话（包括历史图片）。
  const [contextBreak, setContextBreak] = useState(0);
  const [sessionReady, setSessionReady] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // URL 会话先用本地副本快速恢复，再用服务端快照校准，方便跨设备恢复和调试。
  useEffect(() => {
    let active = true;
    setSessionReady(false);
    setMessages(loadMessages(sessionId));
    setContextBreak(0);
    void loadRemoteSession(sessionId)
      .then((snapshot) => {
        if (!active || !snapshot) return;
        setMessages(snapshot.messages);
        setContextBreak(Math.min(snapshot.contextBreak, snapshot.messages.length));
        saveMessages(sessionId, snapshot.messages);
      })
      .catch((error) => console.warn("[session] restore failed:", error))
      .finally(() => {
        if (active) setSessionReady(true);
      });
    return () => {
      active = false;
    };
  }, [sessionId]);

  // 只保存完整回合，避免 URL 恢复出半截回答。
  useEffect(() => {
    if (!sessionReady) return;
    const streaming = messages.some(
      (m) => m.role === "assistant" && m.status === "streaming"
    );
    if (streaming) return;
    saveMessages(sessionId, messages);
    void saveRemoteSession(sessionId, { messages, contextBreak }).catch((error) =>
      console.warn("[session] save failed:", error)
    );
  }, [messages, contextBreak, sessionId, sessionReady]);

  useEffect(() => {
    try {
      window.localStorage.setItem("eduvision-thinking-enabled", String(thinkingEnabled));
    } catch {
      // Storage may be unavailable in private or restricted browser contexts.
    }
  }, [thinkingEnabled]);

  const send = useCallback(async () => {
    const question = input.trim();
    if ((!question && !image) || loading) return;

    const userMessage: ChatMessage = {
      id: uid(),
      role: "user",
      content: question,
      image: image ?? undefined,
    };
    const assistantMessage: ChatMessage = {
      id: uid(),
      role: "assistant",
      content: "",
      reasoning: "",
      tools: [],
      status: "streaming",
    };

    const history = messages
      .slice(contextBreak)
      .filter(
        (m) =>
          m.status !== "streaming" &&
          (m.content.trim().length > 0 || typeof m.image === "string")
      )
      .map((m) => ({ role: m.role, content: m.content, image: m.image }));

    setMessages((prev) => [...prev, userMessage, assistantMessage]);
    setInput("");
    setImage(null);
    setLoading(true);
    setThinking([]);

    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = uid();

    const patch = (fn: (m: ChatMessage) => ChatMessage) =>
      setMessages((prev) =>
        prev.map((m) => (m.id === assistantMessage.id ? fn(m) : m))
      );

    try {
      await streamChat(
        { requestId, image: image ?? undefined, question, history, thinking: thinkingEnabled },
        {
          onDebug: (event, data) =>
            patch((m) => {
              const events = m.debugEvents ?? [];
              const previous = events[events.length - 1];
              // Token streams arrive as many tiny events. Merge adjacent text
              // deltas so the debug panel remains readable and lightweight.
              if (
                previous?.event === event &&
                typeof previous.data.text === "string" &&
                typeof data.text === "string"
              ) {
                return {
                  ...m,
                  debugEvents: [
                    ...events.slice(0, -1),
                    {
                      ...previous,
                      data: { ...previous.data, text: previous.data.text + data.text },
                    },
                  ],
                };
              }
              return {
                ...m,
                debugEvents: [
                  ...events,
                  { event, data, at: new Date().toISOString() },
                ],
              };
            }),
          onThinking: (text) => setThinking((prev) => [...prev, { text }]),
          onOcr: (delta) => {
            setThinking([]);
            patch((m) => ({ ...m, ocr: (m.ocr ?? "") + delta }));
          },
          onReasoning: (delta) => {
            setThinking([]);
            patch((m) => ({ ...m, reasoning: (m.reasoning ?? "") + delta }));
          },
          onAnswer: (delta) => {
            setThinking([]);
            patch((m) => ({ ...m, content: m.content + delta }));
          },
          onToolCall: (tool) => {
            setThinking([]);
            patch((m) => ({
              ...m,
              tools: [
                ...(m.tools ?? []),
                {
                  toolCallId: tool.toolCallId,
                  name: tool.name,
                  args: tool.args,
                  executor: tool.executor,
                  status: "running",
                },
              ],
            }));
          },
          onToolResult: (result) => {
            setThinking([]);
            patch((m) => ({
              ...m,
              tools: (m.tools ?? []).map((t) =>
                t.toolCallId === result.toolCallId
                  ? { ...t, status: result.ok ? "done" : "error", output: result.output }
                  : t
              ),
            }));
          },
          onDone: ({ pipeline, model }) =>
            patch((m) => ({ ...m, pipeline, model, status: "done" })),
          onError: (text) =>
            patch((m) =>
              // Never clobber an already-streamed answer with a late error.
              m.content
                ? m
                : { ...m, content: text, error: true, status: "error" }
            ),
        },
        controller.signal
      );
    } catch {
      patch((m) => ({
        ...m,
        content: "网络错误，请重试。",
        error: true,
        status: "error",
      }));
    } finally {
      abortRef.current = null;
      setLoading(false);
      setThinking([]);
    }
  }, [input, image, loading, messages, contextBreak, thinkingEnabled]);

  /** 结束当前上下文：断点设在现有对话末尾，下一道题不带前面的上下文。 */
  const endContext = useCallback(() => {
    setContextBreak(messages.length);
    setThinking([]);
  }, [messages]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    stop();
    removeSavedMessages(sessionId);
    const nextSessionId = createSessionId();
    replaceSessionUrl(nextSessionId);
    setSessionId(nextSessionId);
    setMessages([]);
    setInput("");
    setImage(null);
    setThinking([]);
    setLoading(false);
    setContextBreak(0);
  }, [sessionId, stop]);

  return {
    messages,
    sessionId,
    input,
    setInput,
    image,
    setImage,
    loading,
    thinking,
    thinkingEnabled,
    setThinkingEnabled,
    contextEnded: contextBreak > 0,
    endContext,
    send,
    stop,
    reset,
  };
}
