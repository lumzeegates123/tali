import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useRef } from "react";

/** True once the user has moved past the first screen; headings then take focus when their screen appears. */
export const MoveFocusContext = createContext(false);

/** A screen's heading. It receives focus on screen changes so keyboard and screen-reader users follow the flow. */
export function ScreenHeading({ id, children }: { readonly id: string; readonly children: ReactNode }) {
  const moveFocus = useContext(MoveFocusContext);
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (moveFocus) ref.current?.focus();
  }, [moveFocus]);
  return (
    <h2 id={id} ref={ref} tabIndex={-1}>
      {children}
    </h2>
  );
}

/** A polite loading message for network-dependent screens. */
export function LoadingState({ label }: { readonly label: string }) {
  return (
    <p role="status" aria-live="polite" className="loading">
      {label}
    </p>
  );
}
