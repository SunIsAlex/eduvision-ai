import { Component, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { repairAdjacentDisplayMath } from "../lib/utils";

/**
 * Streaming text is often mid-syntax (unclosed $$ or code fences). If a
 * partial chunk ever makes the markdown/KaTeX renderer throw, this boundary
 * keeps the chat alive and falls back to plain text instead of freezing.
 */
class MarkdownErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render() {
    if (this.state.failed) {
      return (
        <div className="whitespace-pre-wrap">{String(this.props.children)}</div>
      );
    }
    return this.props.children;
  }
}

/** Markdown + GFM tables + LaTeX rendering. */
export function Markdown({ content }: { content: string }) {
  const repairedContent = repairAdjacentDisplayMath(content);
  return (
    <div className="markdown-body">
      <MarkdownErrorBoundary>
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}
          components={{
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            ),
          }}
        >
          {repairedContent}
        </ReactMarkdown>
      </MarkdownErrorBoundary>
    </div>
  );
}
