import math from "../../../worker/prompts/math/SKILL.md?raw";
import english from "../../../worker/prompts/english/SKILL.md?raw";
import chemistry from "../../../worker/prompts/chemistry/SKILL.md?raw";
import biology from "../../../worker/prompts/biology/SKILL.md?raw";
import physics from "../../../worker/prompts/physics/SKILL.md?raw";
import type { SkillId } from "./types";

const prompts: Partial<Record<SkillId, string>> = {
  math,
  english,
  chemistry,
  biology,
  physics,
};

export function getSkillPrompt(skill: SkillId | undefined): string {
  const content = skill ? prompts[skill] : undefined;
  if (!content) return "";
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}
