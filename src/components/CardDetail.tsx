import { open } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";
import { useState, useEffect } from "react";
import type { Card } from "../types";
import { RARITY_COLORS } from "../types";
import { useT } from "../I18nContext";
import ManaCost from "./ManaCost";
import styles from "./CardDetail.module.css";

interface Props {
  card: Card;
  onAddMain?: () => void;
  onAddSide?: () => void;
  onClose?: () => void;
  displayLang?: string;
  setIconUrl?: string | null;
}

// ── Traductions FR (fallback type_line uniquement) ─────────────────────────────
const TYPE_TERMS_FR: Record<string, string> = {
  Creature:     "Créature",
  Instant:      "Éphémère",
  Sorcery:      "Rituel",
  Enchantment:  "Enchantement",
  Artifact:     "Artefact",
  Planeswalker: "Arpenteur planeswalker",
  Land:         "Terrain",
  Legendary:    "Légendaire",
  Basic:        "De base",
  Snow:         "Nival",
  Token:        "Jeton",
  Tribal:       "Tribal",
  Battle:       "Bataille",
  Saga:         "Épopée",
  Dungeon:      "Donjon",
};

function translateTypeLine(typeLine: string, lang: string): string {
  if (lang === "en") return typeLine;
  const parts = typeLine.split(" — ");
  const translatedMain = parts[0]
    .split(" ")
    .map((w) => TYPE_TERMS_FR[w] ?? w)
    .join(" ");
  return parts.length > 1 ? `${translatedMain} — ${parts.slice(1).join(" — ")}` : translatedMain;
}

// ─────────────────────────────────────────────────────────────────────────────

export default function CardDetail({ card, onAddMain, onAddSide, onClose, displayLang = "en", setIconUrl }: Props) {
  const t = useT();
  const isFr = displayLang === "fr"; // other langs fall back to EN display for now

  // ── Combo count from Commander Spellbook ──────────────────────────────────
  const [comboCount, setComboCount] = useState<number | null>(null);
  useEffect(() => {
    setComboCount(null);
    invoke<number>("get_cs_combo_count", { cardName: card.name_en })
      .then(count => setComboCount(count))
      .catch(() => setComboCount(0));
  }, [card.name_en]);

  // ── Cartes double-face : bascule recto / verso ────────────────────────────
  const [showBack, setShowBack] = useState(false);
  useEffect(() => { setShowBack(false); }, [card.id]);
  const hasBack = !!card.image_uri_back;

  const frontImg = isFr
    ? (card.image_uri_fr ?? card.image_uri_normal ?? card.image_uri_small)
    : (card.image_uri_normal ?? card.image_uri_small);
  const img = showBack && hasBack ? card.image_uri_back : frontImg;

  const rarityColor  = RARITY_COLORS[card.rarity ?? "common"] ?? "#ccc";
  const primaryName  = isFr ? (card.name_fr ?? card.name_en) : card.name_en;
  const secondName   = isFr
    ? card.name_en
    : (card.name_fr && card.name_fr !== card.name_en ? card.name_fr : null);

  // Oracle text: prefer FR when available and in FR mode
  const oracleText   = isFr ? (card.oracle_text_fr ?? card.oracle_text) : card.oracle_text;
  const textLangBadge: string | null = isFr
    ? (card.oracle_text_fr ? "FR" : (card.oracle_text ? "EN" : null))
    : null;

  const displayedType = isFr
    ? (card.type_line_fr ?? (card.type_line ? translateTypeLine(card.type_line, displayLang) : null))
    : (card.type_line ?? null);

  const resolvedSetIconUrl = setIconUrl
    ?? (card.set_code ? `https://svgs.scryfall.io/sets/${card.set_code.toLowerCase()}.svg` : null);

  const openExternal = (url: string) => { open(url).catch(() => window.open(url, "_blank", "noopener")); };
  const csUrl  = `https://commanderspellbook.com/search/?q=card%3A%22${encodeURIComponent(card.name_en)}%22`;
  // Alchemy cards have "A-" prefix (e.g. "A-Eiganjo Exemplar") → strip it
  // Apostrophes must be removed, not replaced with "-" (e.g. "Life's" → "lifes" not "life-s")
  const edhrecSlug = card.name_en
    .replace(/^A-/i, '')
    .toLowerCase()
    .replace(/'/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const ehrUrl = `https://edhrec.com/cards/${edhrecSlug}`;

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <div>
          <h2 className={styles.nameEn}>{primaryName}</h2>
          {secondName && secondName !== primaryName && (
            <p className={styles.nameFr}>{secondName}</p>
          )}
        </div>
        {onClose && (
          <button className={styles.closeBtn} onClick={onClose} title={t("nav.close")}>
            ×
          </button>
        )}
      </div>

      {img && (
        <div className={styles.cardImgWrap}>
          <img
            className={styles.cardImg}
            src={img}
            alt={card.name_en}
            loading="lazy"
          />
          {hasBack && (
            <button
              className={styles.flipBtn}
              onClick={() => setShowBack((v) => !v)}
              title={t("cd.flip")}
            >
              ⟳ {t("cd.flip")}
            </button>
          )}
        </div>
      )}

      <div className={styles.meta}>
        {card.mana_cost && (
          <div className={styles.row}>
            <span className={styles.label}>{t("cd.cost")}</span>
            <ManaCost cost={card.mana_cost} size={15} />
          </div>
        )}
        {displayedType && (
          <div className={styles.row}>
            <span className={styles.label}>{t("cd.type")}</span>
            <span>{displayedType}</span>
          </div>
        )}
        <div className={styles.row}>
          <span className={styles.label}>{t("cd.rarity")}</span>
          <span style={{ color: rarityColor }}>
            {card.rarity ? t(`rarity.${card.rarity}`) : "—"}
          </span>
        </div>
        {card.set_code && (
          <div className={styles.row}>
            <span className={styles.label}>{t("cd.set")}</span>
            <span className={styles.setCode} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              {resolvedSetIconUrl && (
                <img
                  src={resolvedSetIconUrl}
                  alt={card.set_code}
                  style={{ width: 16, height: 16, filter: "invert(0.7)" }}
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                />
              )}
              {card.set_code.toUpperCase()} #{card.collector_number}
            </span>
          </div>
        )}
        {(card.power || card.toughness) && (
          <div className={styles.row}>
            <span className={styles.label}>P/T</span>
            <span>{card.power}/{card.toughness}</span>
          </div>
        )}
        {card.loyalty && (
          <div className={styles.row}>
            <span className={styles.label}>{t("cd.loyalty")}</span>
            <span>{card.loyalty}</span>
          </div>
        )}
      </div>

      {oracleText && (
        <div className={styles.oracleText}>
          {textLangBadge && (
            <span
              className={styles.langNote}
              title={textLangBadge === "EN" ? t("cd.oracleEnOnly") : t("cd.oracleLoc")}
              style={{ opacity: textLangBadge === "EN" ? 0.6 : 1 }}
            >
              {textLangBadge}
            </span>
          )}
          {oracleText.split("\n").map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
      )}

      {(onAddMain || onAddSide) && (
        <div className={styles.actions}>
          {onAddMain && (
            <button className="btn-primary" onClick={onAddMain}>
              {t("cd.addMain")}
            </button>
          )}
          {onAddSide && (
            <button className="btn-ghost" onClick={onAddSide}>
              {t("cd.addSide")}
            </button>
          )}
        </div>
      )}

      <div className={styles.externalLinks}>
        <button
          className={styles.extBtn}
          onClick={() => openExternal(csUrl)}
          title={t("cd.csTitle")}
        >
          ⚡ {t("cd.combos")}
        </button>
        <button
          className={styles.extBtn}
          onClick={() => openExternal(ehrUrl)}
          title={t("cd.edhrecTitle")}
        >
          📖 EDHREC
        </button>
        <div className={styles.comboCount}>
          {comboCount === null ? t("cd.combosLoading") : t("cd.combosCount", { count: comboCount })}
        </div>
      </div>
    </div>
  );
}
