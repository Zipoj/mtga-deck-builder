import { useState, useRef, useEffect } from "react";
import styles from "./FlagSelect.module.css";

export interface FlagOption {
  value: string;
  label: string;
  fi: string;        // code ISO 3166-1 alpha-2 pour flag-icons (ex: "fr", "jp")
  disabled?: boolean;
  hint?: string;     // texte grisé affiché après le label (ex: "(non détecté)")
}

interface Props {
  value: string;
  options: FlagOption[];
  onChange?: (value: string) => void;
  disabled?: boolean;
}

export default function FlagSelect({ value, options, onChange, disabled = false }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = options.find(o => o.value === value);

  // Fermer en cliquant en dehors
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={rootRef} className={styles.root}>
      <button
        type="button"
        className={styles.trigger}
        onClick={() => !disabled && setOpen(v => !v)}
        disabled={disabled}
      >
        {current && (
          <span
            className={`fi fi-${current.fi}`}
            style={{ borderRadius: 2, flexShrink: 0, fontSize: 16 }}
          />
        )}
        <span className={styles.triggerLabel}>{current?.label ?? value}</span>
        <span className={styles.chevron}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className={styles.dropdown}>
          {options.map(opt => (
            <button
              key={opt.value}
              type="button"
              className={`${styles.option} ${opt.value === value ? styles.optionActive : ""}`}
              disabled={opt.disabled}
              onClick={() => {
                if (!opt.disabled) {
                  onChange?.(opt.value);
                  setOpen(false);
                }
              }}
            >
              <span
                className={`fi fi-${opt.fi}`}
                style={{ borderRadius: 2, flexShrink: 0, fontSize: 16 }}
              />
              <span>{opt.label}</span>
              {opt.hint && (
                <span style={{ opacity: 0.45, fontSize: 11, marginLeft: 4 }}>{opt.hint}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
