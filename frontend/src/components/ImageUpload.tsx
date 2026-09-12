import { useCallback, useRef, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { compressImage, readAsDataURL } from "../lib/image";
import { cn } from "../lib/utils";

interface Props {
  onChange: (dataUrl: string | null) => void;
  onPdfChange: (pdf: { data: string; name: string } | null) => void;
  disabled?: boolean;
}

/**
 * The "+" picker button inside the composer. The selected-image preview is
 * rendered by the Composer itself, so this component only handles picking.
 */
export function ImageUpload({ onChange, onPdfChange, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleFile = useCallback(
    async (file: File | undefined | null) => {
      if (!file || disabled) return;
      setBusy(true);
      try {
        if (file.type === "application/pdf") {
          if (file.size > 20 * 1024 * 1024) throw new Error("PDF 不能超过 20 MB");
          onChange(null);
          onPdfChange({ data: await readAsDataURL(file), name: file.name });
          return;
        }
        if (!file.type.startsWith("image/")) return;
        const compressed = await compressImage(file);
        const dataUrl = await readAsDataURL(compressed);
        onPdfChange(null);
        onChange(dataUrl);
      } finally {
        setBusy(false);
      }
    },
    [disabled, onChange, onPdfChange]
  );

  return (
    <>
      {/* Hidden native file picker — must be a real <input> for Android/iOS
          Chrome; programmatic input.click() without a rendered input is a no-op. */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*,application/pdf,.pdf"
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
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-mute transition hover:bg-black/5 hover:text-ink",
          dragging && "bg-brand-500/10 text-brand-600",
          disabled && "cursor-not-allowed opacity-50",
          busy && "pointer-events-none"
        )}
        aria-label="上传题目图片或 PDF"
        title="上传题目图片或 PDF 试卷（支持拖拽）"
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Plus className="h-4 w-4" />
        )}
      </button>
    </>
  );
}
