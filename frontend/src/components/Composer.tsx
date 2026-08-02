import { useEffect, useRef } from "react";
import { Send, Square } from "lucide-react";
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
    <div className="border-t border-slate-800 bg-slate-950/90 px-3 pb-4 pt-3 backdrop-blur sm:px-6">
      <div className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-slate-700 bg-slate-900 p-2 shadow-xl focus-within:border-brand-500">
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
          className="max-h-40 flex-1 resize-none bg-transparent px-1 py-2 text-[15px] text-slate-100 outline-none placeholder:text-slate-500 disabled:opacity-60"
        />

        <button
          type="button"
          onClick={loading ? onStop : onSubmit}
          disabled={!canSend && !loading}
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition",
            loading
              ? "bg-slate-700 text-slate-200 hover:bg-red-600 hover:text-white"
              : canSend
                ? "bg-brand-600 text-white hover:bg-brand-500"
                : "cursor-not-allowed bg-slate-800 text-slate-600"
          )}
          aria-label={loading ? "停止生成" : "发送"}
          title={loading ? "停止生成" : "发送"}
        >
          {loading ? <Square className="h-4 w-4 fill-current" /> : <Send className="h-4 w-4" />}
        </button>
      </div>
      <p className="mx-auto mt-2 max-w-3xl text-center text-[11px] text-slate-600">
        答案由 AI 生成，请核对后再用于作业。支持数学公式（LaTeX）。
      </p>
    </div>
  );
}
