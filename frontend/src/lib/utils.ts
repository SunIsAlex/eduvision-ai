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

/** Append one streamed answer delta without creating a `$$$$` boundary. */
export function appendMarkdownDelta(content: string, delta: string): string {
  const separator = /\$\$\s*$/.test(content) && /^\s*\$\$/.test(delta) ? "\n\n" : "";
  return content + separator + delta;
}
