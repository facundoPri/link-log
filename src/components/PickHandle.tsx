import type { ReactNode } from "react";

/** The checkbox cell of a row: the full row height starts a paint stroke (see usePaintSelection). */
export function PickHandle({ children }: { children: ReactNode }) {
  return (
    <span data-pick-handle className="-my-3 -ml-4 -mr-3 flex touch-none self-stretch py-3 pl-4 pr-3" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
      {children}
    </span>
  );
}
