import { useEffect, useRef } from "react";
import { ArrowUp, BookOpen, Brain, Sparkles, Square, X } from "lucide-react";
import { ImageUpload } from "./ImageUpload";
import { cn } from "../lib/utils";
import type { SkillId } from "../lib/types";

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
  ultraEnabled: boolean;
  onUltraEnabledChange: (enabled: boolean) => void;
  selectedSkill: SkillId;
  onSelectedSkillChange: (skill: SkillId) => void;
}

// Ghost chips live inside the composer card, Claude-style: no boxes, just
// icon + label that tint on hover, so the controls barely take visual space.
const chip =
  "flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-mute transition hover:bg-black/5 hover:text-ink";

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
    <div className="px-3 pb-3 pt-2 sm:px-6 sm:pb-5">
      <div className="mx-auto max-w-4xl rounded-3xl border border-line bg-white shadow-[0_2px_16px_rgba(38,37,31,0.06)] transition focus-within:border-brand-500/60">
        {props.image && (
          <div className="flex px-4 pt-3">
            <div className="relative inline-block">
              <img
                src={props.image}
                alt="已选择题目"
                className="h-16 w-16 rounded-xl border border-line object-cover"
              />
              <button
                type="button"
                onClick={() => props.onImageChange(null)}
                disabled={loading}
                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink text-white transition hover:bg-red-600 disabled:opacity-50"
                aria-label="移除图片"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </div>
        )}

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
          placeholder="输入题目，或上传图片后提问…（Enter 发送）"
          className="max-h-40 w-full resize-none bg-transparent px-4 pb-1 pt-3 text-[15px] leading-6 text-ink outline-none placeholder:text-faint disabled:opacity-60"
        />

        <div className="flex items-center gap-1 px-2 pb-2">
          <div className="scrollbar-none flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            <ImageUpload onChange={props.onImageChange} disabled={loading} />

            <button
              type="button"
              role="switch"
              aria-checked={props.thinkingEnabled}
              disabled={loading || disabled}
              onClick={() => props.onThinkingEnabledChange(!props.thinkingEnabled)}
              className={cn(
                chip,
                "disabled:opacity-50",
                props.thinkingEnabled &&
                  "bg-brand-500/10 text-brand-600 hover:bg-brand-500/15 hover:text-brand-600"
              )}
              title="开启后模型会花更多时间推理，并在可用时显示思考摘要"
            >
              <Brain className="h-3.5 w-3.5" />
              深度思考
            </button>

            <button
              type="button"
              role="switch"
              aria-checked={props.ultraEnabled}
              disabled={loading || disabled}
              onClick={() => props.onUltraEnabledChange(!props.ultraEnabled)}
              className={cn(
                chip,
                "disabled:opacity-50",
                props.ultraEnabled &&
                  "bg-violet-500/10 text-violet-600 hover:bg-violet-500/15 hover:text-violet-600"
              )}
              title="Ultra 模式：由高智力模型规划解题思路，子代理用工具自动校验数值后再作答（更慢、更消耗额度）"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Ultra
            </button>

            <label className={cn(chip, "cursor-pointer focus-within:bg-black/5")}>
              <BookOpen className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
              <span className="sr-only">选择解题 SKILL</span>
              <select
                value={props.selectedSkill}
                disabled={loading || disabled}
                onChange={(event) => props.onSelectedSkillChange(event.target.value as SkillId)}
                className="cursor-pointer bg-transparent text-xs outline-none disabled:opacity-50"
                title="由你选择本轮及后续对话使用的学科规范"
              >
                <option value="general" className="bg-white text-ink">无 SKILL</option>
                <option value="math" className="bg-white text-ink">数学 SKILL</option>
                <option value="english" className="bg-white text-ink">英语 SKILL</option>
                <option value="chemistry" className="bg-white text-ink">化学 SKILL</option>
                <option value="biology" className="bg-white text-ink">生物 SKILL</option>
                <option value="physics" className="bg-white text-ink">物理 SKILL</option>
              </select>
            </label>
          </div>

          <button
            type="button"
            onClick={loading ? onStop : onSubmit}
            disabled={!canSend && !loading}
            className={cn(
              "ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition",
              loading
                ? "bg-ink text-white hover:bg-red-600"
                : canSend
                  ? "bg-brand-500 text-white hover:bg-brand-600"
                  : "cursor-not-allowed bg-[#e8e4d9] text-faint"
            )}
            aria-label={loading ? "停止生成" : "发送"}
            title={loading ? "停止生成" : "发送"}
          >
            {loading ? (
              <Square className="h-3.5 w-3.5 fill-current" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
