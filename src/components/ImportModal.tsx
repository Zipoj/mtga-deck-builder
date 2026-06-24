import { useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../I18nContext";
import type { Deck } from "../types";
import styles from "./ImportModal.module.css";

interface Props {
  onImported: (deck: Deck) => void;
  onClose: () => void;
}

type Status = "idle" | "importing" | "done" | "error";

export default function ImportModal({ onImported, onClose }: Props) {
  const t = useT();
  const [text, setText]       = useState("");
  const [name, setName]       = useState("Deck importé");
  const [status, setStatus]   = useState<Status>("idle");
  const [error, setError]     = useState("");
  const textareaRef           = useRef<HTMLTextAreaElement>(null);

  // Estimation rapide du contenu : nb de lignes non vides non-section
  const lines = text
    .split("\n")
    .filter((l) => l.trim() && !["sideboard","commander","deck"].includes(l.trim().toLowerCase()));
  const estimatedCards = lines.length;

  const handleImport = async () => {
    if (!text.trim()) return;
    setStatus("importing");
    setError("");
    try {
      const deck = await invoke<Deck>("import_deck_mtga", {
        content: text,
        deckName: name.trim() || "Deck importé",
      });
      setStatus("done");
      setTimeout(() => {
        onImported(deck);
        onClose();
      }, 800);
    } catch (err) {
      setStatus("error");
      setError(String(err));
    }
  };

  const handlePaste = () => {
    navigator.clipboard.readText().then((t) => {
      setText(t);
      textareaRef.current?.focus();
    }).catch(() => {
      textareaRef.current?.focus();
    });
  };

  // Fermeture sur clic hors modal
  const handleBackdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <div className={styles.backdrop} onClick={handleBackdrop}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <h2>{t("import.title")}</h2>
          <button className={styles.closeBtn} onClick={onClose}>×</button>
        </div>

        <p className={styles.hint}>{t("import.hint")}</p>

        <div className={styles.nameRow}>
          <label>{t("import.deckName")}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("import.deckNamePlaceholder")}
          />
        </div>

        <div className={styles.textareaWrapper}>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"4 Lightning Bolt (M21) 150\n4 Counterspell\n...\n\nSideboard\n2 Negate"}
            spellCheck={false}
          />
          {estimatedCards > 0 && (
            <div className={styles.lineCount}>{t("import.detectedEntries", { count: estimatedCards })}</div>
          )}
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.actions}>
          <button className="btn-ghost" onClick={handlePaste}>
            {t("import.paste")}
          </button>
          <button className="btn-ghost" onClick={() => setText("")} disabled={!text}>
            {t("import.clear")}
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn-ghost" onClick={onClose}>{t("import.cancel")}</button>
          <button
            className="btn-primary"
            onClick={handleImport}
            disabled={!text.trim() || status === "importing"}
          >
            {status === "importing" ? t("import.importing")
             : status === "done"     ? t("import.done")
             : t("import.import")}
          </button>
        </div>

        {/* Format exemple */}
        <details className={styles.format}>
          <summary>{t("import.formatTitle")}</summary>
          <pre>{`4 Lightning Bolt (M21) 150
4 Snapcaster Mage (MM3) 54
20 Island

Sideboard
2 Negate (M21) 59`}</pre>
        </details>
      </div>
    </div>
  );
}
