import type { Ref } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../lib/utils";

export const markdownClasses = cn(
  "text-[13px] leading-6",
  "[&_h1]:text-sm [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:font-medium",
  "[&_p]:my-2 [&_a]:underline [&_a]:underline-offset-2",
  "[&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4",
  "[&_code]:rounded [&_code]:bg-muted [&_code]:px-1",
  "[&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3",
  "[&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
);

// Remote images are never loaded from extracted content; links open outside Linklog.
const components: Components = {
  img: ({ alt }) => <span className="text-muted-foreground">Image: {alt || "no description"}</span>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full text-xs [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:bg-muted/50 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left">
        {children}
      </table>
    </div>
  ),
};

/** Extracted page content rendered as GitHub-flavored Markdown (library and Browser inspectors). */
export function MarkdownView({ markdown, ref }: { markdown: string; ref?: Ref<HTMLDivElement> }) {
  return (
    <div ref={ref} className={markdownClasses}>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </Markdown>
    </div>
  );
}
