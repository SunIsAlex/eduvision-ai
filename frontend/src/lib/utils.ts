import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function uid(): string {
  return crypto.randomUUID();
}

/** Separate adjacent display-math blocks produced by different model rounds. */
export function repairAdjacentDisplayMath(content: string): string {
  return content.replace(/\$\$[ \t]*\$\$/g, () => "$$\n\n$$");
}

/**
 * remark-math recognizes dollar delimiters but not TeX's \[...\] / \(...\).
 * Normalize those forms outside Markdown code spans and fenced code blocks.
 * This also gives display-only commands such as \tag a real display-math node.
 */
export function normalizeLatexDelimiters(content: string): string {
  let output = "";
  let index = 0;
  let lineStart = true;
  let inlineTicks = 0;
  let fence: { marker: "`" | "~"; length: number } | null = null;

  while (index < content.length) {
    const character = content[index]!;

    if (lineStart && inlineTicks === 0) {
      const line = content.slice(index).match(/^[ \t]{0,3}(`{3,}|~{3,})/);
      if (line) {
        const run = line[1]!;
        const marker = run[0] as "`" | "~";
        if (!fence) fence = { marker, length: run.length };
        else if (fence.marker === marker && run.length >= fence.length) fence = null;
        output += line[0];
        index += line[0].length;
        lineStart = false;
        continue;
      }
    }

    if (!fence && character === "`") {
      let end = index;
      while (content[end] === "`") end += 1;
      const runLength = end - index;
      if (inlineTicks === 0) inlineTicks = runLength;
      else if (inlineTicks === runLength) inlineTicks = 0;
      output += content.slice(index, end);
      index = end;
      lineStart = false;
      continue;
    }

    if (!fence && inlineTicks === 0 && character === "\\" && content[index - 1] !== "\\") {
      const next = content[index + 1];
      if (next === "[") {
        output += "\n\n$$\n";
        index += 2;
        lineStart = true;
        continue;
      }
      if (next === "]") {
        output += "\n$$\n\n";
        index += 2;
        lineStart = true;
        continue;
      }
      if (next === "(" || next === ")") {
        output += "$";
        index += 2;
        lineStart = false;
        continue;
      }
    }

    output += character;
    index += 1;
    lineStart = character === "\n";
  }
  return output;
}

/** Repair adjacent GPT-generated bold labels without changing Claude output. */
export function normalizeGptReasoningMarkdown(content: string): string {
  return content.replace(/\*\*\s*\*\*/g, "**\n\n**");
}

/** Append one streamed answer delta without creating a `$$$$` boundary. */
export function appendMarkdownDelta(content: string, delta: string): string {
  const separator = /\$\$\s*$/.test(content) && /^\s*\$\$/.test(delta) ? "\n\n" : "";
  return content + separator + delta;
}
