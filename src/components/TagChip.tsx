import { Sparkles, X } from "lucide-react";
import type { Tag } from "../types";
import { tagStyle, formatPct } from "../lib/tags";
import { cn } from "../lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export function TagDot({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      style={tagStyle(name)}
      className={cn("size-1.5 shrink-0 rounded-full bg-(--tag-dot)", className)}
    />
  );
}

export function TagChip({
  tag,
  origin,
  score,
  onClick,
  onRemove,
}: {
  tag: Tag;
  origin?: "manual" | "auto";
  score?: number;
  onClick?: () => void;
  onRemove?: () => void;
}) {
  const chip = (
    <span
      style={tagStyle(tag.name)}
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-2xs font-medium",
        "bg-(--tag-bg) text-(--tag-fg)",
        onClick && "cursor-pointer hover:opacity-80 transition-opacity duration-150",
      )}
      onClick={
        onClick
          ? (e) => {
              e.stopPropagation();
              onClick();
            }
          : undefined
      }
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter") {
                e.stopPropagation();
                onClick();
              }
            }
          : undefined
      }
    >
      <TagDot name={tag.name} />
      <span className="max-w-40 truncate">{tag.name}</span>
      {origin === "auto" && <Sparkles className="size-3" aria-hidden />}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${tag.name}`}
          className="-mr-0.5 rounded-sm opacity-60 hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  );
  if (origin) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{chip}</TooltipTrigger>
        <TooltipContent>
          {origin === "auto"
            ? `Auto-tagged${score !== undefined ? ` · ${formatPct(score)} confidence` : ""}`
            : "Added manually"}
        </TooltipContent>
      </Tooltip>
    );
  }
  return chip;
}
