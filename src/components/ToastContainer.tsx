import type { Toast } from "../hooks/useToast";
import styles from "./ToastContainer.module.css";

interface Props {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}

// Curved-arrow undo icon
const UndoArrow = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"
    stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2.5 5.5 C2.5 3 4.5 1.5 7.5 1.5 C11 1.5 13.5 4 13.5 7.5 C13.5 11 11 13.5 7.5 13.5" />
    <polyline points="2.5,2.5 2.5,5.5 5.5,5.5" />
  </svg>
);

export default function ToastContainer({ toasts, onDismiss }: Props) {
  if (toasts.length === 0) return null;
  return (
    <div className={styles.container}>
      {toasts.map((t) =>
        t.type === "undo" ? (
          // ── Undo toast : persists until dismissed, two action buttons ──
          <div key={t.id} className={`${styles.toast} ${styles.undo}`}>
            <span className={styles.undoIcon}>↩</span>
            <span className={styles.message}>{t.message}</span>
            <button
              className={styles.undoBtn}
              title="Annuler la suppression"
              onClick={() => { t.onUndo?.(); onDismiss(t.id); }}
            >
              <UndoArrow />
            </button>
            <button
              className={styles.dismiss}
              title="Fermer"
              onClick={() => onDismiss(t.id)}
            >×</button>
          </div>
        ) : (
          // ── Standard toast ──
          <div key={t.id} className={`${styles.toast} ${styles[t.type]}`}>
            <span className={styles.icon}>
              {t.type === "success" ? "✅" : t.type === "error" ? "❌" : "ℹ"}
            </span>
            <span className={styles.message}>{t.message}</span>
            <button className={styles.dismiss} onClick={() => onDismiss(t.id)}>×</button>
          </div>
        )
      )}
    </div>
  );
}
