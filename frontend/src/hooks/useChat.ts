import { useCallback, useEffect, useRef, useState } from "react";
import { fetchLocalModels, fetchModels, fetchTitle, streamChat, type StreamCallbacks } from "../lib/api";
import { loadMessages, removeSavedMessages, saveMessages } from "../lib/persist";
import {
  createSessionId,
  deleteRemoteSession,
  getOrCreateSessionId,
  loadRemoteSession,
  replaceSessionUrl,
  saveRemoteSession,
} from "../lib/session";
import {
  loadSessionIndex,
  persistSessionIndex,
  removeSession,
  renameSession,
  upsertSession,
  type SessionMeta,
} from "../lib/sessionList";
import { appendMarkdownDelta, uid } from "../lib/utils";
import { prepareImageForVision } from "../lib/image";
import { loadLocalApiConfig, saveLocalApiConfig, type LocalApiConfig } from "../lib/localConfig";
import type { ApiMessage, ChatMessage, ModelOption, SkillId, ThinkingStep } from "../lib/types";

export function useChat({ guestMode = false }: { guestMode?: boolean } = {}) {
  const [sessionId, setSessionId] = useState(getOrCreateSessionId);
  const [messages, setMessages] = useState<ChatMessage[]>(() => loadMessages(sessionId));
  const [sessions, setSessions] = useState<SessionMeta[]>(loadSessionIndex);
  const [input, setInput] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [localApiConfig, setLocalApiConfigState] = useState<LocalApiConfig>(loadLocalApiConfig);
  const [loading, setLoading] = useState(false);
  const [thinking, setThinking] = useState<ThinkingStep[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [modelsLoading, setModelsLoading] = useState(true);
  const [selectedSkill, setSelectedSkill] = useState<SkillId>(() => {
    try {
      const saved = window.localStorage.getItem("eduvision-selected-skill");
      return saved === "math" || saved === "chemistry" ? saved : "general";
    } catch {
      return "general";
    }
  });
  const [thinkingEnabled, setThinkingEnabled] = useState(() => {
    try {
      return window.localStorage.getItem("eduvision-thinking-enabled") === "true";
    } catch {
      return false;
    }
  });
  const [ultraEnabled, setUltraEnabled] = useState(() => {
    try {
      return window.localStorage.getItem("eduvision-ultra-enabled") === "true";
    } catch {
      return false;
    }
  });
  // 上下文断点是 messages 数组下标。点击“结束上下文”后，下一次请求
  // 只发送断点之后的完整 user/assistant 对话（包括历史图片）。
  const [contextBreak, setContextBreak] = useState(0);
  const [sessionReady, setSessionReady] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Sessions whose title was already requested this page load (guard against
  // the effect re-firing while the title request is still in flight).
  const titleRequestedRef = useRef(new Set<string>());

  useEffect(() => {
    let active = true;
    const local = localApiConfig.apiKey.trim() && localApiConfig.apiUrl.trim() ? localApiConfig : null;
    if (guestMode && !local) {
      setModels([]);
      setSelectedModel("");
      setModelsLoading(false);
      return () => {
        active = false;
      };
    }
    setModelsLoading(true);
    void (local ? fetchLocalModels(local) : fetchModels())
      .then((catalog) => {
        if (!active) return;
        setModels(catalog.models);
        setSelectedModel(catalog.defaultModel);
      })
      .catch((error) => console.warn("[models] load failed:", error))
      .finally(() => {
        if (active) setModelsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [localApiConfig, guestMode]);

  // URL 会话先用本地副本快速恢复，再用服务端快照校准，方便跨设备恢复和调试。
  useEffect(() => {
    let active = true;
    setSessionReady(false);
    setMessages(loadMessages(sessionId));
    setContextBreak(0);
    if (guestMode) {
      setSessionReady(true);
      return () => {
        active = false;
      };
    }
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
  }, [sessionId, guestMode]);

  // 只保存完整回合，避免 URL 恢复出半截回答。
  useEffect(() => {
    if (!sessionReady) return;
    const streaming = messages.some(
      (m) => m.role === "assistant" && m.status === "streaming"
    );
    if (streaming) return;
    saveMessages(sessionId, messages);
    // Sessions only enter the drawer index once they hold real content.
    if (messages.length > 0) {
      setSessions((prev) => persistSessionIndex(upsertSession(prev, sessionId)));
    }
    if (!guestMode) {
      void saveRemoteSession(sessionId, { messages, contextBreak }).catch((error) =>
        console.warn("[session] save failed:", error)
      );
    }
  }, [messages, contextBreak, sessionId, sessionReady, guestMode]);

  // 首个完整回答落盘后，让模型为会话生成一个简短标题；失败时回退到首条问题截断。
  useEffect(() => {
    if (!sessionReady) return;
    if (titleRequestedRef.current.has(sessionId)) return;
    const meta = sessions.find((item) => item.id === sessionId);
    if (meta?.titleGenerated) return;
    const firstUser = messages.find((m) => m.role === "user");
    const firstAnswer = messages.find(
      (m) => m.role === "assistant" && m.status === "done" && !m.error && m.content.trim()
    );
    if (!firstUser || !firstAnswer) return;
    titleRequestedRef.current.add(sessionId);
    const question = firstUser.content.trim();
    const fallback = question.replace(/\s+/g, " ").slice(0, 18) || "图片题目";
    const apply = (title: string) =>
      setSessions((prev) =>
        persistSessionIndex(renameSession(prev, sessionId, title || fallback))
      );
    if (guestMode) {
      apply("");
      return;
    }
    void fetchTitle({
      question,
      answer: firstAnswer.content.slice(0, 800),
      model: firstAnswer.model || selectedModel || undefined,
    })
      .then(apply)
      .catch((error: unknown) => {
        console.warn("[session] title generation failed:", error);
        apply("");
      });
  }, [messages, sessionId, sessionReady, sessions, selectedModel, guestMode]);

  useEffect(() => {
    try {
      window.localStorage.setItem("eduvision-thinking-enabled", String(thinkingEnabled));
    } catch {
      // Storage may be unavailable in private or restricted browser contexts.
    }
  }, [thinkingEnabled]);

  useEffect(() => {
    try {
      window.localStorage.setItem("eduvision-selected-skill", selectedSkill);
    } catch {
      // Storage may be unavailable in private or restricted browser contexts.
    }
  }, [selectedSkill]);

  useEffect(() => {
    try {
      window.localStorage.setItem("eduvision-ultra-enabled", String(ultraEnabled));
    } catch {
      // Storage may be unavailable in private or restricted browser contexts.
    }
  }, [ultraEnabled]);

  /**
   * 普通发送与“继续生成”共用的 SSE 回调。onError 在已有内容时把消息置为
   * stopped（保留部分回答），避免像旧逻辑那样永远停在 streaming。
   */
  const makeStreamCallbacks = useCallback(
    (patch: (fn: (m: ChatMessage) => ChatMessage) => void): StreamCallbacks => ({
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
      onPlan: (delta) => {
        setThinking([]);
        patch((m) => ({ ...m, plan: (m.plan ?? "") + delta }));
      },
      onVerify: (delta) => {
        setThinking([]);
        patch((m) => ({ ...m, verify: (m.verify ?? "") + delta }));
      },
      onLineCheck: (check) => {
        patch((m) => {
          const checks = m.lineChecks ?? [];
          const existing = checks.findIndex((item) => item.blockId === check.blockId);
          return {
            ...m,
            lineChecks:
              existing < 0
                ? [...checks, check]
                : checks.map((item, index) => (index === existing ? check : item)),
          };
        });
      },
      onReasoning: (delta) => {
        setThinking([]);
        patch((m) => ({ ...m, reasoning: (m.reasoning ?? "") + delta }));
      },
      onAnswer: (delta) => {
        setThinking([]);
        patch((m) => ({ ...m, content: appendMarkdownDelta(m.content, delta) }));
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
          // Keep already-streamed content; end the turn like a manual stop
          // instead of leaving the message stuck in "streaming".
          m.content
            ? { ...m, status: "stopped" }
            : { ...m, content: text, error: true, status: "error" }
        ),
    }),
    []
  );

  /** 发起一次 SSE 流式请求，把事件写入指定的 assistant 消息。 */
  const runStream = useCallback(
    async (opts: {
      requestId: string;
      question: string;
      image?: string;
      history: ApiMessage[];
      patch: (fn: (m: ChatMessage) => ChatMessage) => void;
      onOcrResult?: (text: string) => void;
      signal?: AbortSignal;
      /** 非中止的网络错误：true 时显示错误消息，false 时保留已有内容回到暂停态。 */
      failAsError: boolean;
    }) => {
      try {
        if (
          guestMode &&
          (!localApiConfig.apiKey.trim() || !localApiConfig.apiUrl.trim())
        ) {
          opts.patch((message) => ({
            ...message,
            content: "访客模式需要先完成手动 API 配置。",
            error: true,
            status: "error",
          }));
          return;
        }
        const requestImage = opts.image
          ? await prepareImageForVision(opts.image).catch(() => opts.image)
          : undefined;
        const callbacks = makeStreamCallbacks(opts.patch);
        callbacks.onOcrResult = opts.onOcrResult;
        await streamChat(
          {
            requestId: opts.requestId,
            image: requestImage,
            question: opts.question,
            history: opts.history,
            thinking: thinkingEnabled,
            model: selectedModel || undefined,
            skill: selectedSkill,
            ultra: ultraEnabled,
            localConfig: localApiConfig.apiKey.trim() && localApiConfig.apiUrl.trim() ? localApiConfig : undefined,
            availableModels: models,
          },
          callbacks,
          opts.signal
        );
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          // 用户主动停止：把消息置为终态，避免卡在 streaming 导致会话无法保存。
          opts.patch((m) => ({ ...m, status: "stopped" }));
        } else if (opts.failAsError) {
          opts.patch((m) => ({
            ...m,
            content: "网络错误，请重试。",
            error: true,
            status: "error",
          }));
        } else {
          // 继续生成场景：保留已生成内容，回到暂停态，可再次编辑/继续。
          opts.patch((m) => ({ ...m, status: "stopped" }));
        }
      }
    },
    [thinkingEnabled, selectedModel, selectedSkill, ultraEnabled, localApiConfig, models, guestMode, makeStreamCallbacks]
  );

  const setLocalApiConfig = useCallback((config: LocalApiConfig) => {
    setLocalApiConfigState(config);
    saveLocalApiConfig(config);
  }, []);

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
          m.status !== "stopped" &&
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
      await runStream({
        requestId,
        question,
        image: image ?? undefined,
        history,
        patch,
        onOcrResult: (text) =>
          setMessages((prev) =>
            prev.map((message) =>
              message.id === userMessage.id
                ? { ...message, content: text, ocrGenerated: true }
                : message
            )
          ),
        signal: controller.signal,
        failAsError: true,
      });
    } finally {
      abortRef.current = null;
      setLoading(false);
      setThinking([]);
    }
  }, [input, image, loading, messages, contextBreak, thinkingEnabled, selectedModel, selectedSkill, runStream]);

  /** 结束当前上下文：断点设在现有对话末尾，下一道题不带前面的上下文。 */
  const endContext = useCallback(() => {
    setContextBreak(messages.length);
    setThinking([]);
  }, [messages]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /**
   * 新对话：保留旧会话（它已留在会话列表里），只切换到全新的空白会话。
   * sessionReady 与 id 变更同步置 false，避免自动保存把旧消息写进新 id。
   */
  const reset = useCallback(() => {
    stop();
    const nextSessionId = createSessionId();
    setSessionReady(false);
    replaceSessionUrl(nextSessionId);
    setSessionId(nextSessionId);
    setMessages([]);
    setInput("");
    setImage(null);
    setThinking([]);
    setLoading(false);
    setContextBreak(0);
  }, [stop]);

  /** 切换到会话列表中的某个历史会话。 */
  const switchSession = useCallback(
    (nextSessionId: string) => {
      if (nextSessionId === sessionId) return;
      stop();
      setSessionReady(false);
      replaceSessionUrl(nextSessionId);
      setSessionId(nextSessionId);
      setMessages(loadMessages(nextSessionId));
      setInput("");
      setImage(null);
      setThinking([]);
      setLoading(false);
      setContextBreak(0);
    },
    [sessionId, stop]
  );

  /** 删除会话：清掉本地索引、本地消息和服务端快照；删除当前会话则另起新会话。 */
  const deleteSession = useCallback(
    (targetId: string) => {
      setSessions((prev) => persistSessionIndex(removeSession(prev, targetId)));
      removeSavedMessages(targetId);
      if (!guestMode) {
        void deleteRemoteSession(targetId).catch((error) =>
          console.warn("[session] remote delete failed:", error)
        );
      }
      if (targetId === sessionId) reset();
    },
    [sessionId, reset, guestMode]
  );

  /** 修改模型输出（所有回答都可编辑，用于纠正笔误）。仅改本地内容。 */
  const editMessage = useCallback((messageId: string, content: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === messageId
          ? {
              ...m,
              content,
              error: false,
              edited: true,
              edits: [
                ...(m.edits ?? []),
                { previous: m.content, at: new Date().toISOString() },
              ],
            }
          : m
      )
    );
  }, []);

  /**
   * 编辑最近一条用户提问：更新内容、删除其后的回答，并按新提问重新生成。
   * 如果该消息不在当前上下文内（contextBreak 之前），只做本地修改。
   */
  const editUserMessage = useCallback(
    async (messageId: string, content: string) => {
      if (loading) return;
      const index = messages.findIndex((m) => m.id === messageId);
      const target = index >= 0 ? messages[index] : undefined;
      if (!target || target.role !== "user") return;

      let lastUserIndex = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === "user") {
          lastUserIndex = i;
          break;
        }
      }
      if (index !== lastUserIndex) return;

      const edited: ChatMessage = {
        ...target,
        content,
        error: false,
        edited: true,
        edits: [
          ...(target.edits ?? []),
          { previous: target.content, at: new Date().toISOString() },
        ],
      };
      const before = messages.slice(0, index);

      if (index < contextBreak) {
        // 该消息不在当前上下文内：只改文本，不影响后续消息。
        setMessages([...before, edited, ...messages.slice(index + 1)]);
        return;
      }
      if (!content.trim() && !target.image) {
        // 清空提问：删除其后的回答，但不触发生成。
        setMessages([...before, edited]);
        return;
      }

      const history = before
        .slice(contextBreak)
        .filter(
          (m) =>
            m.status !== "streaming" &&
            m.status !== "stopped" &&
            (m.content.trim().length > 0 || typeof m.image === "string")
        )
        .map((m) => ({ role: m.role, content: m.content, image: m.image }));

      const assistantMessage: ChatMessage = {
        id: uid(),
        role: "assistant",
        content: "",
        reasoning: "",
        tools: [],
        status: "streaming",
      };
      setMessages([...before, edited, assistantMessage]);
      setInput("");
      setImage(null);
      setLoading(true);
      setThinking([]);

      const controller = new AbortController();
      abortRef.current = controller;
      const requestId = uid();

      const patch = (fn: (m: ChatMessage) => ChatMessage) =>
        setMessages((prev) => prev.map((m) => (m.id === assistantMessage.id ? fn(m) : m)));

      try {
        await runStream({
          requestId,
          question: content,
          // Once OCR text is visible and editable, a corrected transcription
          // is the source of truth. Keep displaying the original image, but do
          // not OCR it again and overwrite the user's corrections.
          image: target.ocrGenerated ? undefined : target.image,
          history,
          patch,
          signal: controller.signal,
          failAsError: true,
        });
      } finally {
        abortRef.current = null;
        setLoading(false);
        setThinking([]);
      }
    },
    [loading, messages, contextBreak, runStream]
  );

  /**
   * 从暂停处继续生成：把（可能已编辑的）部分回答作为历史发给模型，
   * 新内容追加到同一条消息而不是新建一条。仅对最后一条 stopped 消息可用。
   */
  const resumeMessage = useCallback(
    async (messageId: string) => {
      if (loading) return;
      const index = messages.findIndex((m) => m.id === messageId);
      const target = index >= 0 ? messages[index] : undefined;
      if (!target || target.role !== "assistant" || target.status !== "stopped") return;
      if (index !== messages.length - 1) return;
      if (!target.content.trim()) return;

      // 从断点重建历史：跳过空消息，合并连续的同角色消息（例如被跳过的空
      // 回答留下的相邻 user 消息），保证发给上游的角色是交替的。
      const history: ApiMessage[] = [];
      for (const m of messages.slice(contextBreak, index + 1)) {
        if (m.status === "streaming") continue;
        if (!m.content.trim() && !m.image) continue;
        const previous = history[history.length - 1];
        if (previous && previous.role === m.role && !previous.image && !m.image) {
          previous.content = `${previous.content}

${m.content}`.trim();
          continue;
        }
        history.push({ role: m.role, content: m.content, image: m.image });
      }

      const controller = new AbortController();
      abortRef.current = controller;
      const requestId = uid();
      setLoading(true);
      setThinking([]);

      const patch = (fn: (m: ChatMessage) => ChatMessage) =>
        setMessages((prev) => prev.map((m) => (m.id === messageId ? fn(m) : m)));

      try {
        await runStream({
          requestId,
          question:
            "请直接从刚才中断的地方继续完成上面的回答：不要重复、不要复述、不要总结已经输出的内容，接着最后一句话往后继续写。",
          history,
          patch,
          signal: controller.signal,
          failAsError: false,
        });
      } finally {
        abortRef.current = null;
        setLoading(false);
        setThinking([]);
      }
    },
    [loading, messages, contextBreak, thinkingEnabled, selectedModel, selectedSkill, runStream]
  );

  return {
    messages,
    sessionId,
    sessions,
    input,
    setInput,
    image,
    setImage,
    loading,
    thinking,
    thinkingEnabled,
    setThinkingEnabled,
    ultraEnabled,
    setUltraEnabled,
    localApiConfig,
    setLocalApiConfig,
    models,
    selectedModel,
    setSelectedModel,
    modelsLoading,
    selectedSkill,
    setSelectedSkill,
    contextEnded: contextBreak > 0,
    endContext,
    editMessage,
    editUserMessage,
    resumeMessage,
    send,
    stop,
    reset,
    switchSession,
    deleteSession,
  };
}
