import { useState, useCallback, useRef } from "react";

export type ToastType = "success" | "error" | "info" | "undo";

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
  onUndo?: () => void;
}

let nextId = 0;

export function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) { clearTimeout(t); timers.current.delete(id); }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((
    message: string,
    type: ToastType = "info",
    onUndo?: () => void,
  ) => {
    const id = ++nextId;

    if (type === "undo") {
      // Undo toasts never auto-dismiss; replace any existing undo toast
      setToasts((prev) => {
        // Cancel timer for any existing undo toast (shouldn't have one, but safety)
        const existing = prev.find((t) => t.type === "undo");
        if (existing) {
          const timer = timers.current.get(existing.id);
          if (timer) { clearTimeout(timer); timers.current.delete(existing.id); }
        }
        // Keep all non-undo toasts + add the new undo toast
        return [...prev.filter((t) => t.type !== "undo"), { id, message, type, onUndo }];
      });
      // No auto-dismiss timer for undo toasts
    } else {
      setToasts((prev) => [...prev.slice(-4), { id, message, type }]);
      const timer = setTimeout(() => dismiss(id), 3000);
      timers.current.set(id, timer);
    }
  }, [dismiss]);

  return { toasts, toast, dismiss };
}
