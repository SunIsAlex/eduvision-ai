import { useCallback, useEffect, useRef, useState } from "react";
import { streamChat } from "../lib/api";
import { loadMessages, removeSavedMessages, saveMessages } from "../lib/persist";
import { uid } from "../lib/utils";
import type { ChatMessage, ThinkingStep } from "../lib/types";

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>(loadMessages);
  const [input, setInput] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [thinking, setThinking] = useState<ThinkingStep[]>([]);
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  // 上下文断点：之前的 user 消息条数。点击“结束上下文”后，之后的提问
  // 只把断点之后的对话作为历史发送，不再带上前面的题目。
  const [contextBreak, setContextBreak] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  // 持久化：只在没有消息正在流式输出时写入，避免存下半截回答；
  // 刷新页面后从 localStorage 恢复完整会话。
  useEffect(() => {
    const streaming = messages.some(
      (m) => m.role === "assistant" && m.status === "streaming"
    );
    if (!streaming) saveMessages(messages);
  }, [messages]);

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
      .filter((m) => m.role === "user")
      .slice(contextBreak)
      .slice(-4)
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
    const userCount = messages.filter((m) => m.role === "user").length;
    setContextBreak(userCount);
    setThinking([]);
  }, [messages]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    stop();
    setMessages([]);
    setInput("");
    setImage(null);
    setThinking([]);
    setLoading(false);
    setContextBreak(0);
    removeSavedMessages();
  }, [stop]);

  return {
    messages,
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
