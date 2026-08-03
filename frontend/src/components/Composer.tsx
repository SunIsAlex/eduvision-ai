import { useEffect, useRef } from "react";
import { Brain, Send, Square } from "lucide-react";
import { ImageUpload } from "./ImageUpload";
import { cn } from "../lib/utils";

interface Props {
  value: string;
  onChange: (v: string) => void;
  image: string | null;
  onImageChange: (v: string | null) => void;
  onSubmit: () => void;
  onStop: () => void;
  loading: boolean;
  disabled?: boolean;
  thinkingEnabled: boolean;
  onThinkingEnabledChange: (enabled: boolean) => void;
}

export function Composer(props: Props) {
  const { value, onChange, onSubmit, onStop, loading, disabled } = props;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow the textarea up to ~6 lines.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  const canSend = (value.trim().length > 0 || Boolean(props.image)) && !loading;

  return (
    <div className="border-t border-[#303030] bg-[#212121]/95 px-3 pb-4 pt-3 backdrop-blur sm:px-6 sm:pb-5">
      <div className="mx-auto flex max-w-4xl items-end gap-2 rounded-[26px] border border-[#424242] bg-[#2f2f2f] p-2.5 shadow-2xl shadow-black/20 transition focus-within:border-[#5a5a5a]">
        <div className="flex items-end gap-2 pb-0.5 pl-1">
          <ImageUpload
            value={props.image}
            onChange={props.onImageChange}
            disabled={loading}
          />
        </div>

        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          disabled={loading}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (canSend) onSubmit();
            }
          }}
          placeholder="输入题目，或上传图片后提问…（Enter 发送，Shift+Enter 换行）"
          className="max-h-40 flex-1 resize-none bg-transparent px-2 py-2.5 text-[15px] leading-6 text-[#ececec] outline-none placeholder:text-[#8e8e8e] disabled:opacity-60"
        />

        <button
          type="button"
          onClick={loading ? onStop : onSubmit}
          disabled={!canSend && !loading}
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition",
            loading
              ? "bg-[#4a4a4a] text-[#ececec] hover:bg-red-600 hover:text-white"
              : canSend
                ? "bg-white text-[#212121] hover:bg-[#d9d9d9]"
                : "cursor-not-allowed bg-[#424242] text-[#777]"
          )}
          aria-label={loading ? "停止生成" : "发送"}
          title={loading ? "停止生成" : "发送"}
        >
          {loading ? <Square className="h-4 w-4 fill-current" /> : <Send className="h-4 w-4" />}
        </button>
      </div>
      <div className="mx-auto mt-3 flex max-w-4xl items-center px-1">
        <button
          type="button"
          role="switch"
          aria-checked={props.thinkingEnabled}
          disabled={loading || disabled}
          onClick={() => props.onThinkingEnabledChange(!props.thinkingEnabled)}
          className={cn(
            "flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[13px] font-medium leading-5 transition disabled:opacity-50",
            props.thinkingEnabled
              ? "border-brand-500/70 bg-brand-500/15 text-brand-300"
              : "border-[#424242] bg-[#2f2f2f] text-[#a0a0a0] hover:bg-[#363636] hover:text-[#ececec]"
          )}
          title="开启后 Claude 会花更多时间推理，并显示思考过程"
        >
          <Brain className="h-3.5 w-3.5" />
          深度思考 {props.thinkingEnabled ? "开" : "关"}
        </button>
      </div>
    </div>
  );
}
