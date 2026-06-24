import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useT } from "../I18nContext";
import type { Card, DeckWithCards } from "../types";
import styles from "./CardContextMenu.module.css";

interface Props {
  card: Card;
  x: number;
  y: number;
  isFavorite: boolean;
  openDecks: DeckWithCards[];
  openCombos: Array<{ id: number; label: string }>;
  displayLang: string;
  onAddFavorite: () => void;
  onRemoveFavorite: () => void;
  onCreateCombo: (card: Card) => void;
  onSendToDeck: (deckId: number) => void;
  onSendToCombo: (comboId: number) => void;
  onClose: () => void;
}

export default function CardContextMenu({
  card, x, y, isFavorite,
  openDecks, openCombos, displayLang,
  onAddFavorite, onRemoveFavorite, onCreateCombo,
  onSendToDeck, onSendToCombo, onClose,
}: Props) {
  const t = useT();
  const [deckSubmenu, setDeckSubmenu]   = useState(false);
  const [comboSubmenu, setComboSubmenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Ajuste la position pour rester dans l'écran
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const menuW = 210;
  const menuH = 200; // estimation
  const left = x + menuW > vw ? x - menuW : x;
  const top  = y + menuH > vh ? y - menuH : y;

  // Fermer sur clic extérieur ou Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  const cardName = displayLang === "fr" ? (card.name_fr ?? card.name_en) : card.name_en;

  const menu = (
    <div
      ref={menuRef}
      className={styles.menu}
      style={{ left, top }}
      onContextMenu={e => e.preventDefault()}
    >
      {/* Card name header */}
      <div className={styles.menuHeader}>{cardName}</div>

      {/* Favoris */}
      {isFavorite ? (
        <button className={styles.menuItem} onClick={() => { onRemoveFavorite(); }}>
          <span className={styles.menuIcon}>★</span> {t("ctx.removeFromFav")}
        </button>
      ) : (
        <button className={styles.menuItem} onClick={() => { onAddFavorite(); }}>
          <span className={styles.menuIcon}>⭐</span> {t("ctx.addToFav")}
        </button>
      )}

      <div className={styles.menuDivider} />

      {/* Créer un combo */}
      <button className={styles.menuItem} onClick={() => { onCreateCombo(card); onClose(); }}>
        <span className={styles.menuIcon}>✨</span> {t("ctx.createCombo")}
      </button>

      <div className={styles.menuDivider} />

      {/* Envoyer vers deck */}
      <div
        className={`${styles.menuItem} ${styles.menuItemSub} ${openDecks.length === 0 ? styles.menuItemDisabled : ""}`}
        onMouseEnter={() => { setDeckSubmenu(true); setComboSubmenu(false); }}
        onMouseLeave={() => setDeckSubmenu(false)}
      >
        <span className={styles.menuIcon}>🃏</span>
        <span style={{ flex: 1 }}>{t("ctx.sendToDeck")}</span>
        <span className={styles.subArrow}>▶</span>
        {deckSubmenu && openDecks.length > 0 && (
          <div className={styles.submenu}>
            {openDecks.map(od => (
              <button
                key={od.deck.id}
                className={styles.menuItem}
                onClick={() => { onSendToDeck(od.deck.id); onClose(); }}
              >
                <span className={styles.menuIcon}>🛠</span>
                <span className={styles.subLabel}>{od.deck.name}</span>
              </button>
            ))}
          </div>
        )}
        {deckSubmenu && openDecks.length === 0 && (
          <div className={styles.submenu}>
            <div className={styles.subEmpty}>{t("ctx.noOpenDeck")}</div>
          </div>
        )}
      </div>

      {/* Envoyer vers combo */}
      <div
        className={`${styles.menuItem} ${styles.menuItemSub} ${openCombos.length === 0 ? styles.menuItemDisabled : ""}`}
        onMouseEnter={() => { setComboSubmenu(true); setDeckSubmenu(false); }}
        onMouseLeave={() => setComboSubmenu(false)}
      >
        <span className={styles.menuIcon}>✨</span>
        <span style={{ flex: 1 }}>{t("ctx.sendToCombo")}</span>
        <span className={styles.subArrow}>▶</span>
        {comboSubmenu && openCombos.length > 0 && (
          <div className={styles.submenu}>
            {openCombos.map(oc => (
              <button
                key={oc.id}
                className={styles.menuItem}
                onClick={() => { onSendToCombo(oc.id); onClose(); }}
              >
                <span className={styles.menuIcon}>✨</span>
                <span className={styles.subLabel}>{oc.label}</span>
              </button>
            ))}
          </div>
        )}
        {comboSubmenu && openCombos.length === 0 && (
          <div className={styles.submenu}>
            <div className={styles.subEmpty}>{t("ctx.noOpenCombo")}</div>
          </div>
        )}
      </div>
    </div>
  );

  return createPortal(menu, document.body);
}
