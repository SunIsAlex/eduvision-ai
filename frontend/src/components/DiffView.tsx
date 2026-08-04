import { diffLines } from "diff";

interface DiffViewProps {
  previous: string;
  current: string;
}

/**
 * git diff 风格的修改对比：删除行红色（-）、新增行绿色（+）。
 * 基于 jsdiff 按行 diff，长内容可滚动查看。
 */
export function DiffView({ previous, current }: DiffViewProps) {
  const parts = diffLines(previous, current);
  return (
    <div className="scrollbar-thin mt-2 max-h-72 overflow-auto rounded-lg border border-line bg-white/70 px-2 py-1.5 font-mono text-[11px] leading-5">
      {parts.map((part, partIndex) => {
        const lines = part.value.replace(/\n$/, "").split("\n");
        const prefix = part.added ? "+" : part.removed ? "-" : " ";
        const tone = part.added
          ? "bg-emerald-50 text-emerald-800"
          : part.removed
            ? "bg-red-50 text-red-700"
            : "text-mute";
        return lines.map((line, lineIndex) => (
          <div
            key={`${partIndex}-${lineIndex}`}
            className={`whitespace-pre-wrap break-words ${tone}`}
          >
            <span className="inline-block w-4 select-none text-faint">{prefix}</span>
            {line}
          </div>
        ));
      })}
    </div>
  );
}
