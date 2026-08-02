import { useCallback, useRef, useState } from "react";
import { ImagePlus, Loader2, X } from "lucide-react";
import { compressImage, readAsDataURL } from "../lib/image";
import { cn } from "../lib/utils";

interface Props {
  value: string | null;
  onChange: (dataUrl: string | null) => void;
  disabled?: boolean;
}

export function ImageUpload({ value, onChange, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleFile = useCallback(
    async (file: File | undefined | null) => {
      if (!file || !file.type.startsWith("image/") || disabled) return;
      setBusy(true);
      try {
        const compressed = await compressImage(file);
        const dataUrl = await readAsDataURL(compressed);
        onChange(dataUrl);
      } finally {
        setBusy(false);
      }
    },
    [disabled, onChange]
  );

  if (value) {
    return (
      <div className="relative inline-block">
        <img
          src={value}
          alt="已选择题目"
          className="h-20 w-20 rounded-lg border border-slate-600 object-cover"
        />
        <button
          type="button"
          onClick={() => onChange(null)}
          disabled={disabled}
          className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-slate-700 text-slate-200 hover:bg-red-500 disabled:opacity-50"
          aria-label="移除图片"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <>
      {/* Hidden native file picker — must be a real <input> for Android/iOS
          Chrome; programmatic input.click() without a rendered input is a no-op. */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        disabled={disabled || busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset so picking the same file again still fires onChange.
          e.target.value = "";
          void handleFile(file);
        }}
      />
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void handleFile(e.dataTransfer.files?.[0]);
        }}
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-600 text-slate-400 transition hover:border-brand-500 hover:text-brand-400",
          dragging && "border-brand-500 bg-brand-500/10 text-brand-400",
          disabled && "cursor-not-allowed opacity-50",
          busy && "pointer-events-none"
        )}
        aria-label="上传题目图片"
        title="上传题目图片（支持拖拽）"
      >
        {busy ? (
          <Loader2 className="h-[18px] w-[18px] animate-spin" />
        ) : (
          <ImagePlus className="h-[18px] w-[18px]" />
        )}
      </button>
    </>
  );
}
