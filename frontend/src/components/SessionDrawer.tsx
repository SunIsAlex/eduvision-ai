import { SquarePen, Trash2, X } from "lucide-react";
import { cn } from "../lib/utils";
import type { SessionMeta } from "../lib/sessionList";

interface Props {
  open: boolean;
  sessions: SessionMeta[];
  currentId: string;
  onClose: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onNewChat: () => void;
}

/**
 * Left slide-over session list, like the Claude/ChatGPT apps: overlay on top
 * of everything, opened from the header button or a rightward edge swipe.
 */
export function SessionDrawer({
  open,
  sessions,
  currentId,
  onClose,
  onSelect,
  onDelete,
  onNewChat,
}: Props) {
  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/25 transition-opacity duration-200",
          open ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-line bg-[#f7f5ee] transition-transform duration-200 ease-out",
          open ? "translate-x-0" : "-translate-x-full"
        )}
        aria-label="会话列表"
        aria-hidden={!open}
      >
        <div className="flex items-center gap-1.5 p-2.5">
          <button
            type="button"
            onClick={onNewChat}
            className="flex h-9 flex-1 items-center gap-2 rounded-xl border border-line bg-white px-3 text-sm font-medium text-ink transition hover:border-brand-500/60 hover:text-brand-600"
          >
            <SquarePen className="h-4 w-4" />
            新对话
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭会话列表"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-mute transition hover:bg-black/5 hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="scrollbar-thin flex-1 overflow-y-auto px-2.5 pb-3">
          {sessions.length === 0 ? (
            <p className="px-2 py-8 text-center text-xs text-faint">还没有历史会话</p>
          ) : (
            <ul className="space-y-0.5">
              {sessions.map((session) => (
                <li key={session.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => onSelect(session.id)}
                    className={cn(
                      "flex w-full items-center rounded-lg px-3 py-2.5 text-left text-sm transition",
                      session.id === currentId
                        ? "bg-black/[0.07] font-medium text-ink"
                        : "text-mute hover:bg-black/5 hover:text-ink"
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate pr-5">
                      {session.title || "新对话"}
                    </span>
                  </button>
                  <button
                    type="button"
                    title="删除会话"
                    aria-label={`删除会话 ${session.title || "新对话"}`}
                    onClick={() => {
                      if (
                        window.confirm(
                          `删除会话「${session.title || "新对话"}」？此操作不可恢复。`
                        )
                      ) {
                        onDelete(session.id);
                      }
                    }}
                    className="absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-faint transition hover:bg-black/5 hover:text-red-600 sm:opacity-0 sm:group-hover:opacity-100"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </>
  );
}
