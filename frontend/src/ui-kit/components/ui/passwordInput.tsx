import * as React from "react";
import { AnimatePresence, motion, useReducedMotionConfig } from "framer-motion";
import { Eye, Icon, type IconNode } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";
import { Input, type InputProps } from "./input";

// lucide's `eye-off` without its last path (the `m2 2 20 20` slash), which is
// drawn separately below so it can draw in with pathLength.
const EYE_OFF_BODY: IconNode = [
  ["path", { d: "M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49", key: "ct8e1f" }],
  ["path", { d: "M14.084 14.158a3 3 0 0 1-4.242-4.242", key: "151rxh" }],
  ["path", { d: "M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143", key: "13bj9a" }],
];

const TRANSITION = { duration: 0.15, ease: "easeOut" } as const;
// framer-motion's own reducedMotion only drops transforms; opacity and
// pathLength would still animate, so reduced motion swaps in one step here.
const INSTANT = { duration: 0 } as const;

export interface PasswordInputProps extends Omit<InputProps, "type" | "endIcon" | "kind"> {
  /**
   * Change this to put the field back to hidden - e.g. bump a counter after a
   * successful submit that keeps the field mounted. Unmounting resets it too.
   */
  resetKey?: React.Key;
}

/**
 * A password field with an eye button that shows and hides what is typed
 * (password reset spec §6). The caller still sets `autoComplete`
 * (`current-password` / `new-password`) so password managers keep filling it.
 *
 * The eye is a real `type="button"`, so it never submits the form. A pointer
 * click leaves focus and the caret in the field; a keyboard press leaves focus
 * on the eye.
 */
function PasswordInput({ id, ref, resetKey, ...props }: PasswordInputProps) {
  const generatedId = React.useId();
  const inputId = id ?? generatedId;
  const [revealed, setRevealed] = React.useState(false);
  const reduced = useReducedMotionConfig();
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const caret = React.useRef<[number | null, number | null] | null>(null);

  const [seenResetKey, setSeenResetKey] = React.useState(resetKey);
  if (seenResetKey !== resetKey) {
    setSeenResetKey(resetKey);
    setRevealed(false);
  }

  const setRefs = React.useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  // Switching `type` can move the caret in some browsers; put it back.
  React.useLayoutEffect(() => {
    const node = inputRef.current;
    const saved = caret.current;
    caret.current = null;
    if (!node || !saved || document.activeElement !== node) return;
    try {
      node.setSelectionRange(saved[0], saved[1]);
    } catch {
      // Some input types refuse selection APIs; nothing to restore.
    }
  }, [revealed]);

  const onToggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    const node = inputRef.current;
    // detail > 0 is a pointer click; 0 is Space / Enter on the focused button.
    if (node && e.detail > 0) {
      caret.current = [node.selectionStart, node.selectionEnd];
      node.focus();
    }
    setRevealed((v) => !v);
  };

  const transition = reduced ? INSTANT : TRANSITION;
  const enter = { opacity: 0, scale: 0.8, rotate: -15 };
  const shown = { opacity: 1, scale: 1, rotate: 0 };

  return (
    <Input
      {...props}
      id={inputId}
      ref={setRefs}
      type={revealed ? "text" : "password"}
      endIcon={
        <button
          type="button"
          aria-label={revealed ? "Hide password" : "Show password"}
          aria-pressed={revealed}
          aria-controls={inputId}
          disabled={props.disabled}
          // Keep focus in the field on a pointer press.
          onMouseDown={(e) => e.preventDefault()}
          onClick={onToggle}
          className={cn(
            "relative flex size-8 items-center justify-center rounded-md",
            "text-subtle-foreground hover:text-foreground transition-colors",
            "focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none",
            "disabled:pointer-events-none disabled:opacity-50",
          )}
        >
          <AnimatePresence initial={false}>
            {revealed ? (
              <motion.span
                key="eye-off"
                data-icon="eye-off"
                aria-hidden
                className="absolute inset-0 flex items-center justify-center"
                initial={reduced ? false : enter}
                animate={shown}
                exit={enter}
                transition={transition}
              >
                <Icon iconNode={EYE_OFF_BODY}>
                  <motion.path
                    d="m2 2 20 20"
                    initial={reduced ? false : { pathLength: 0 }}
                    animate={{ pathLength: 1 }}
                    transition={transition}
                  />
                </Icon>
              </motion.span>
            ) : (
              <motion.span
                key="eye"
                data-icon="eye"
                aria-hidden
                className="absolute inset-0 flex items-center justify-center"
                initial={reduced ? false : enter}
                animate={shown}
                exit={enter}
                transition={transition}
              >
                <Eye />
              </motion.span>
            )}
          </AnimatePresence>
        </button>
      }
    />
  );
}

export { PasswordInput };
