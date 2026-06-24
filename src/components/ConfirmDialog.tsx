import ReactDOM from "react-dom";
import { useT } from "../I18nContext";
import styles from "./ConfirmDialog.module.css";

interface Props {
  title?: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: Props) {
  const t = useT();
  return ReactDOM.createPortal(
    <div className={styles.backdrop} onMouseDown={onCancel}>
      <div className={styles.dialog} onMouseDown={(e) => e.stopPropagation()}>
        <p className={styles.title}>{title ?? t("confirm.title")}</p>
        <p className={styles.message}>{message}</p>
        <div className={styles.actions}>
          <button className={styles.cancelBtn} onClick={onCancel}>
            {t("confirm.cancel")}
          </button>
          <button className={styles.deleteBtn} onClick={onConfirm}>
            {confirmLabel ?? t("confirm.delete")}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
