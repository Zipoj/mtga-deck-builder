import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import ReactDOM from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  DndContext, DragEndEvent, DragStartEvent, DragOverlay,
  useDraggable, useDroppable,
  PointerSensor, useSensor, useSensors,
} from "@dnd-kit/core";
import type { Card, Combo, CardFilters, DeckWithCards } from "../types";
import { useT } from "../I18nContext";
import ManaCost from "./ManaCost";
import ConfirmDialog from "./ConfirmDialog";
import CardDetail from "./CardDetail";
import styles from "./CombosView.module.css";
import bStyles from "./IntegratedDeckBuilder.module.css";

// Alchemy exclusion icon
const IcoNoAlchemy = () => (
  <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
    <text x="2" y="12" fontSize="11" fontWeight="700" fontFamily="monospace" fill="currentColor">A</text>
    <line x1="1" y1="2" x2="14" y2="13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
);

interface Props {
  onToast?: (msg: string, type?: "success" | "error" | "info") => void;
  displayLang: string;
  langCode?: string;
  imageLangCode?: string;
  onNewCombo?: () => void;
  onOpenCombo?: (combo: Combo) => void;
  favoriteIds?: Set<string>;
  onContextMenu?: (card: Card, x: number, y: number) => void;
  openDecks?: DeckWithCards[];
  onDeckUpdated?: (deckId: number) => void;
}

// ─── Static filter config (identical to deck builder) ────────────────────────

const SVG = "https://svgs.scryfall.io/card-symbols";

interface SetInfo { code: string; count: number; }

const COLOR_BTNS = [
  { code: "W", title: "Blanc" },
  { code: "U", title: "Bleu" },
  { code: "B", title: "Noir" },
  { code: "R", title: "Rouge" },
  { code: "G", title: "Vert" },
  { code: "C", title: "Incolore" },
];

// ── Type SVG icons ────────────────────────────────────────────────────────────
const TYPE_BTNS: { code: string; title: string; ms: string }[] = [
  { code: "Creature",     title: "Créatures",     ms: "creature" },
  { code: "Instant",      title: "Éphémères",     ms: "instant" },
  { code: "Sorcery",      title: "Rituels",       ms: "sorcery" },
  { code: "Enchantment",  title: "Enchantements", ms: "enchantment" },
  { code: "Planeswalker", title: "Planeswalkers", ms: "planeswalker" },
  { code: "Battle",       title: "Batailles",     ms: "battle" },
  { code: "Commander",    title: "Commandants",   ms: "commander" },
  { code: "Land",         title: "Terrains",      ms: "land" },
];

const CMC_BTNS = [0, 1, 2, 3, 4, 5, 6, "7+"] as const;

const RARITY_COLORS = {
  common:   "#9a9a9a",
  uncommon: "#aacde8",
  rare:     "#d4af37",
  mythic:   "#e8672a",
} as const;
const RARITY_BTNS = ["common", "uncommon", "rare", "mythic"] as const;


function RarityGem({ rarity }: { rarity: string }) {
  const isCommon = rarity === "common";
  const fill = isCommon ? "#0d0d1a" : rarity === "uncommon" ? "#9eb8d9" : rarity === "rare" ? "#d4af37" : rarity === "mythic" ? "#e8612c" : "#8888a0";
  return (
    <svg width="9" height="9" viewBox="0 0 10 10" style={{ flexShrink: 0, display: "inline-block", marginRight: 2 }}>
      <polygon points="5,0 10,5 5,10 0,5" fill={fill} stroke={isCommon ? "#9090a0" : "none"} strokeWidth={isCommon ? "1.5" : "0"} />
    </svg>
  );
}

// ─── Main view ────────────────────────────────────────────────────────────────

const COLOR_ORDER = ["W", "U", "B", "R", "G", "C"];

const COMBO_TAGS = [
  "Infini", "Win-con", "Synergie", "Moteur à valeur", "Rampe",
  "Pioche", "Jetons", "Réanimation", "Storm", "Tuteur",
  "Protection", "EDH", "2 cartes", "3 cartes", "Instantané",
];

// Traduit un tag (valeur canonique FR stockée en base) via la clé i18n combo.tag.<valeur>.
// Repli sur la valeur brute si aucune traduction (tags personnalisés / anciens).
function tagLabel(t: (key: string) => string, tag: string): string {
  const key = `combo.tag.${tag}`;
  const v = t(key);
  return v === key ? tag : v;
}

const FORMATS_COMBO = [
  { value: "standard",       label: "Standard"       },
  { value: "historic",       label: "Historic"       },
  { value: "alchemy",        label: "Alchemy"        },
  { value: "pioneer",        label: "Pioneer"        },
  { value: "explorer",       label: "Explorer"       },
  { value: "brawl",          label: "Brawl"          },
  { value: "historic_brawl", label: "Historic Brawl" },
  { value: "timeless",       label: "Timeless"       },
];

interface ScryfallSetC { code: string; set_type: string; released_at: string; arena_code?: string; }

function getFormatSetCodesC(format: string, sets: ScryfallSetC[]): string[] | null {
  const paperTypes = ["expansion", "core", "starter", "draft_innovation"];
  switch (format) {
    case "standard": {
      const cutoff = new Date(); cutoff.setFullYear(cutoff.getFullYear() - 2);
      return sets.filter(s => paperTypes.includes(s.set_type) && new Date(s.released_at) >= cutoff).map(s => s.code);
    }
    case "pioneer": case "explorer":
      return sets.filter(s => paperTypes.includes(s.set_type) && new Date(s.released_at) >= new Date("2012-10-05")).map(s => s.code);
    case "modern":
      return sets.filter(s => paperTypes.includes(s.set_type) && new Date(s.released_at) >= new Date("2003-07-28")).map(s => s.code);
    case "alchemy":
      return sets.filter(s => !!s.arena_code).map(s => s.code);
    case "historic": case "timeless":
      // Formats « tout Arena » : pas de restriction de set (filtre arena_id côté SQL).
      return null;
    default: return null;
  }
}

function sumManaCostsTotal(cardNames: string[], cardObjects: Record<string, Card>): number {
  let total = 0;
  for (const name of cardNames) {
    const cmc = cardObjects[name]?.cmc;
    if (typeof cmc === "number") total += cmc;
  }
  return total;
}

function buildManaCostString(cardNames: string[], cardObjects: Record<string, Card>): string {
  let generic = 0;
  const colored: string[] = [];
  const ORDER = ["W", "U", "B", "R", "G"];
  for (const name of cardNames) {
    const cost = cardObjects[name]?.mana_cost ?? "";
    for (const m of (cost.matchAll(/\{([^}]+)\}/g) as unknown as RegExpMatchArray[])) {
      const sym = m[1];
      if (/^\d+$/.test(sym)) generic += parseInt(sym);
      else if (sym !== "X") colored.push(`{${sym}}`);
    }
  }
  colored.sort((a, b) =>
    ((ORDER.findIndex(c => a.includes(c)) + 99) % 99) - ((ORDER.findIndex(c => b.includes(c)) + 99) % 99)
  );
  return (generic > 0 ? `{${generic}}` : "") + colored.join("");
}

export default function CombosView({ onToast, displayLang, langCode = "en", imageLangCode = "en", onNewCombo, onOpenCombo, openDecks = [], onDeckUpdated }: Props) {
  const t = useT();
  const [combos, setCombos]               = useState<Combo[]>([]);
  const [loading, setLoading]             = useState(true);
  const [expanded, setExpanded]           = useState<number | null>(null);
  const [cardObjects, setCardObjects]     = useState<Record<string, Card>>({});
  const [hoverPreview, setHoverPreview]   = useState<{ card: Card; x: number; y: number } | null>(null);
  const [detailCard, setDetailCard]       = useState<Card | null>(null);
  const [searchQuery, setSearchQuery]     = useState("");
  const [filterColors, setFilterColors]   = useState<string[]>([]);
  const [filterTags, setFilterTags]       = useState<string[]>([]);
  const [sortMode, setSortMode]           = useState<"date" | "name" | "cost">("date");
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [comboCtxMenu, setComboCtxMenu]   = useState<{ combo: Combo; x: number; y: number } | null>(null);
  const [addToDeckState, setAddToDeckState] = useState<{ combo: Combo; deck: DeckWithCards; qty: number } | null>(null);
  const [sfSets, setSfSets]               = useState<ScryfallSetC[]>([]);
  const cardObjectsRef                    = useRef<Record<string, Card>>({});
  cardObjectsRef.current = cardObjects; // always reflects latest state (avoids stale closure in async callbacks)

  const load = async () => {
    try {
      const data = await invoke<Combo[]>("get_combos");
      setCombos(data);
    } catch (err) {
      onToast?.(t("toast.error", { msg: String(err) }), "error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Rafraîchit automatiquement quand l'addon Firefox ajoute un combo via l'API
  useEffect(() => {
    const unsub = listen("combo-added", () => { load(); });
    return () => { unsub.then(fn => fn()); };
  }, []);

  // Charge les objets Card pour tous les noms de cartes des combos
  useEffect(() => {
    if (combos.length === 0) return;
    const allNames = [...new Set(combos.flatMap(c => c.cards))];
    if (allNames.length === 0) return;
    invoke<Card[]>("get_cards_by_names", { names: allNames, langCode, imageLangCode })
      .then(cards => {
        const map: Record<string, Card> = {};
        for (const card of cards) map[card.name_en] = card;
        setCardObjects(map);
      })
      .catch(console.error);
  }, [combos, langCode]);

  const confirmDelete = async () => {
    if (confirmDeleteId === null) return;
    try {
      await invoke("delete_combo", { id: confirmDeleteId });
      setCombos(prev => prev.filter(c => c.id !== confirmDeleteId));
      setConfirmDeleteId(null);
      onToast?.(t("combo.deleted"), "info");
    } catch (err) {
      onToast?.(t("toast.error", { msg: String(err) }), "error");
    }
  };

  const toggleComboFavorite = async (combo: Combo) => {
    const newVal = !combo.is_favorite;
    setCombos(prev => prev.map(c => c.id === combo.id ? { ...c, is_favorite: newVal } : c));
    await invoke("set_combo_favorite", { id: combo.id, isFavorite: newVal });
  };

  // ── Export / Import (partage joueur à joueur) ──────────────────────────────
  const exportCombos = async (ids: number[], suggestedName: string) => {
    if (ids.length === 0) return;
    try {
      const path = await saveDialog({
        defaultPath: `${suggestedName}.json`,
        filters: [{ name: "Combo", extensions: ["json"] }],
      });
      if (!path) return;
      const n = await invoke<number>("export_combos", { ids, path });
      onToast?.(t("combo.exported", { count: n }), "success");
    } catch (err) {
      onToast?.(t("toast.error", { msg: String(err) }), "error");
    }
  };

  const importCombos = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "Combo", extensions: ["json"] }],
      });
      if (!selected || typeof selected !== "string") return;
      const n = await invoke<number>("import_combos", { path: selected });
      await load();
      onToast?.(t("combo.imported", { count: n }), "success");
    } catch (err) {
      onToast?.(t("toast.error", { msg: String(err) }), "error");
    }
  };

  const sanitizeFileName = (s: string) =>
    s.replace(/[<>:"/\\|?*]+/g, "_").trim() || "combo";

  const toggleFilterColor = (c: string) =>
    setFilterColors(prev => prev.includes(c) ? prev.filter(x => x !== c) : [...prev, c]);

  const toggleFilterTag = (t: string) =>
    setFilterTags(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);

  // Fetch Scryfall sets lazily (used for format legality check)
  useEffect(() => {
    if (openDecks.length === 0 || sfSets.length > 0) return;
    fetch("https://api.scryfall.com/sets")
      .then(r => r.json())
      .then(j => setSfSets((j.data as ScryfallSetC[]) ?? []))
      .catch(() => {});
  }, [openDecks.length]);

  const isComboLegalForDeck = (combo: Combo, deck: DeckWithCards): boolean => {
    const codes = getFormatSetCodesC(deck.deck.format, sfSets);
    if (!codes) return true; // format sans restriction de sets
    return combo.cards.every(name => {
      const card = cardObjects[name];
      if (!card || !card.set_code) return true; // carte inconnue → on laisse passer
      return codes.includes(card.set_code);
    });
  };

  const sendCardsToDeck = async (state: { combo: Combo; deck: DeckWithCards; qty: number }) => {
    const { combo, deck, qty } = state;
    const objs = cardObjectsRef.current;
    const notFound: string[] = [];
    let sent = 0;
    try {
      for (const name of combo.cards) {
        const card = objs[name];
        if (!card) { notFound.push(name); continue; }
        await invoke("add_card_to_deck", { deckId: deck.deck.id, cardId: card.id, quantity: qty, board: "main" });
        sent++;
      }
      if (notFound.length > 0) {
        console.warn("[CombosView] cartes non trouvées dans cardObjects :", notFound);
      }
      if (sent === 0) {
        onToast?.(t("combo.noneRecognized", { names: notFound.join(", ") }), "error");
      } else {
        const total = sent * qty;
        onToast?.(t("combo.cardsAdded", { count: total, name: deck.deck.name }), "success");
        onDeckUpdated?.(deck.deck.id);
      }
      setAddToDeckState(null);
    } catch (err) {
      console.error("[CombosView] add_card_to_deck error:", err);
      onToast?.(t("toast.error", { msg: String(err) }), "error");
    }
  };

  const displayed = useMemo(() => {
    return combos
      .filter(c => {
        if (searchQuery) {
          const q = searchQuery.toLowerCase();
          if (!c.name.toLowerCase().includes(q) && !c.description.toLowerCase().includes(q)) return false;
        }
        if (filterColors.length > 0) {
          const colorId = COLOR_ORDER.filter(col =>
            c.cards.some(name => (cardObjects[name]?.color_identity ?? []).includes(col)));
          if (!filterColors.some(fc => colorId.includes(fc))) return false;
        }
        if (filterTags.length > 0) {
          const comboTags = c.tags.split(",").map(t => t.trim());
          if (!filterTags.some(ft => comboTags.includes(ft))) return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (!!a.is_favorite !== !!b.is_favorite) return a.is_favorite ? -1 : 1;
        if (sortMode === "name") return a.name.localeCompare(b.name);
        if (sortMode === "cost") return sumManaCostsTotal(a.cards, cardObjects) - sumManaCostsTotal(b.cards, cardObjects);
        return 0;
      });
  }, [combos, searchQuery, filterColors, filterTags, sortMode, cardObjects]);

  const hasListFilters = searchQuery.length > 0 || filterColors.length > 0 || filterTags.length > 0 || sortMode !== "date";
  const deleteTarget = combos.find(c => c.id === confirmDeleteId);

  return (
    <div className={styles.container}>
      {/* ── Header ── */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <h2 className={styles.title}>🎯 {t("combo.title")}</h2>
          <span className={styles.count}>{t("combo.savedCount", { count: combos.length })}</span>
        </div>
        <div className={styles.headerActions}>
          <button className="btn-ghost" onClick={importCombos}>{t("combo.import")}</button>
          {combos.length > 0 && (
            <button
              className="btn-ghost"
              onClick={() => exportCombos(combos.map(c => c.id), "combos")}
            >{t("combo.exportAll")}</button>
          )}
          <button className="btn-primary" onClick={() => onNewCombo?.()}>{t("combo.new")}</button>
        </div>
      </div>

      {/* ── Filter bar ── */}
      <div className={styles.listFilterBar}>
        <input
          className={styles.listSearch}
          type="text"
          placeholder={t("combo.searchPlaceholder")}
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />
        <div className={bStyles.filterGroup} style={{ marginLeft: 4 }}>
          {COLOR_ORDER.filter(c => c !== "C").map(c => (
            <button key={c}
              className={`${bStyles.colorBtn} ${filterColors.includes(c) ? bStyles.filterActive : ""}`}
              title={c} onClick={() => toggleFilterColor(c)}>
              <img src={`${SVG}/${c}.svg`} alt={c} width={18} height={18} />
            </button>
          ))}
        </div>
        <select
          className={styles.sortSelect}
          value={sortMode}
          onChange={e => setSortMode(e.target.value as "date" | "name" | "cost")}
        >
          <option value="date">{t("combo.sortDate")}</option>
          <option value="name">{t("combo.sortName")}</option>
          <option value="cost">{t("combo.sortCost")}</option>
        </select>
        {hasListFilters && (
          <button className={bStyles.clearBtn} onClick={() => { setSearchQuery(""); setFilterColors([]); setFilterTags([]); setSortMode("date"); }}>✕</button>
        )}
      </div>

      {/* ── Tag chips ── */}
      <div className={styles.tagFilterRow}>
        {COMBO_TAGS.map(tag => (
          <button key={tag}
            className={`${styles.tagChip} ${filterTags.includes(tag) ? styles.tagChipActive : ""}`}
            onClick={() => toggleFilterTag(tag)}>{tagLabel(t, tag)}</button>
        ))}
      </div>

      {/* ── List ── */}
      <div className={styles.list}>
        {loading && <p className={styles.empty}>{t("combo.loading")}</p>}
        {!loading && combos.length === 0 && (
          <div className={styles.emptyState}>
            <p>{t("combo.emptyNone")}</p>
            <p className={styles.emptyHint}>
              {t("combo.emptyHint")}
            </p>
          </div>
        )}
        {!loading && combos.length > 0 && displayed.length === 0 && (
          <p className={styles.empty}>{t("combo.emptyFilter")}</p>
        )}

        {displayed.map(combo => {
          const colorId = COLOR_ORDER.filter(color =>
            combo.cards.some(name => (cardObjects[name]?.color_identity ?? []).includes(color))
          );
          const manaCostStr = buildManaCostString(combo.cards, cardObjects);
          return (
            <div
              key={combo.id}
              className={`${styles.card} ${expanded === combo.id ? styles.cardExpanded : ""}`}
              onContextMenu={e => { e.preventDefault(); setComboCtxMenu({ combo, x: e.clientX, y: e.clientY }); }}
            >
              <div className={styles.cardHeader} onClick={() => setExpanded(expanded === combo.id ? null : combo.id)}>
                <div className={styles.cardLeft}>
                  <button
                    className={styles.favBtnList}
                    title={combo.is_favorite ? t("combo.removeFav") : t("combo.addFav")}
                    onClick={e => { e.stopPropagation(); toggleComboFavorite(combo); }}
                  ><i className="ms ms-ability-copy" style={{ color: combo.is_favorite ? "#d4a017" : "var(--text-muted)", fontSize: "1em" }} /></button>
                  <span className={styles.comboName}>{combo.name || t("combo.unnamed")}</span>
                  <span className={styles.cardCount}>{t("view.cardCount", { count: combo.cards.length })}</span>
                  {colorId.length > 0 && (
                    <span className={styles.comboColors}>
                      {colorId.map(c => (
                        <img key={c} src={`${SVG}/${c}.svg`}
                          alt={c} className={styles.colorSymbol}
                          onError={e => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                        />
                      ))}
                    </span>
                  )}
                  {manaCostStr && (
                    <>
                      <span className={styles.costSep}>·</span>
                      <span className={styles.costLabel}>{t("combo.cost")}</span>
                      <ManaCost cost={manaCostStr} size={14} />
                    </>
                  )}
                  {/* Tags preview : 2 tags max dans la vue compacte */}
                  {(() => {
                    const tags = combo.tags.split(",").map(s => s.trim()).filter(Boolean);
                    if (tags.length === 0) return null;
                    const preview = tags.slice(0, 2);
                    const rest    = tags.length - 2;
                    return (
                      <>
                        {preview.map((tag, i) => <span key={i} className={styles.tagPreview}>{tagLabel(t, tag)}</span>)}
                        {rest > 0 && <span className={styles.tagMore}>+{rest}</span>}
                      </>
                    );
                  })()}
                </div>
                <div className={styles.cardRight}>
                  <span className={styles.chevron}>{expanded === combo.id ? "▲" : "▼"}</span>
                  {onOpenCombo && (
                    <button
                      className={styles.ouvrirBtn}
                      onClick={e => { e.stopPropagation(); onOpenCombo(combo); }}
                    >{t("combo.open")}</button>
                  )}
                  <button
                    className={styles.deleteBtn}
                    onClick={e => { e.stopPropagation(); exportCombos([combo.id], sanitizeFileName(combo.name)); }}
                    title={t("combo.export")}
                  >⬆</button>
                  <button
                    className={styles.deleteBtn}
                    onClick={e => { e.stopPropagation(); setConfirmDeleteId(combo.id); }}
                    title={t("combo.delete")}
                  >✕</button>
                </div>
              </div>

              {expanded === combo.id && (
                <div className={styles.cardBody}>
                  <div className={styles.cardsList}>
                    {combo.cards.map((cardName, i) => {
                      const co = cardObjects[cardName];
                      return (
                        <span
                          key={i}
                          className={styles.cardPill}
                          style={{ cursor: co ? "pointer" : "default" }}
                          onMouseEnter={e => {
                            if (!co) return;
                            setHoverPreview({ card: co, x: e.clientX, y: e.clientY });
                          }}
                          onMouseMove={e => {
                            if (!co) return;
                            setHoverPreview({ card: co, x: e.clientX, y: e.clientY });
                          }}
                          onMouseLeave={() => setHoverPreview(null)}
                          onClick={() => {
                            if (!co) return;
                            setHoverPreview(null);
                            setDetailCard(co);
                            invoke<Card | null>("get_card_by_id", { cardId: co.id })
                              .then(full => { if (full) setDetailCard(full); })
                              .catch(() => {});
                          }}
                        >
                          {co?.mana_cost && <ManaCost cost={co.mana_cost} size={11} />}
                          <span className={styles.cardPillName}>
                            {displayLang === "fr" ? (co?.name_fr ?? cardName) : cardName}
                          </span>
                        </span>
                      );
                    })}
                  </div>
                  {combo.tags && (
                    <div className={styles.tags}>
                      {combo.tags.split(",").map(s => s.trim()).filter(Boolean).map((tag, i) => (
                        <span key={i} className={styles.tag}>{tagLabel(t, tag)}</span>
                      ))}
                    </div>
                  )}
                  <p className={styles.meta}>
                    {t("combo.addedOn", { date: new Date(combo.created_at).toLocaleDateString() })}
                    {combo.description?.startsWith("http") && (
                      <> · <a
                        href={combo.description}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={styles.sourceLink}
                        onClick={e => e.stopPropagation()}
                      >{combo.source !== "manual" ? combo.source : combo.description}</a></>
                    )}
                    {combo.description && !combo.description.startsWith("http") && (
                      <> · {combo.description}</>
                    )}
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Hover card preview — rendu via portal pour échapper overflow:hidden */}
      {hoverPreview && (() => {
        const c = hoverPreview.card;
        const imgSrc = displayLang === "fr"
          ? (c.image_uri_fr ?? c.image_uri_normal ?? c.image_uri_small)
          : (c.image_uri_normal ?? c.image_uri_small);
        if (!imgSrc) return null;
        const PW = 180;
        const left = hoverPreview.x + 16 + PW > window.innerWidth
          ? hoverPreview.x - PW - 8
          : hoverPreview.x + 16;
        const top = Math.max(8, Math.min(hoverPreview.y - 30, window.innerHeight - 270));
        return ReactDOM.createPortal(
          <div style={{
            position: "fixed", left, top,
            zIndex: 9999, pointerEvents: "none",
            borderRadius: 10, overflow: "hidden",
            boxShadow: "0 8px 32px rgba(0,0,0,0.7)",
            animation: "none",
          }}>
            <img src={imgSrc} alt={displayLang === "fr" ? (c.name_fr ?? c.name_en) : c.name_en}
              style={{ width: PW, display: "block" }} />
          </div>,
          document.body
        );
      })()}

      {confirmDeleteId !== null && (
        <ConfirmDialog
          message={t("combo.deleteConfirm", { name: deleteTarget?.name ?? t("combo.deleteFallback") })}
          onConfirm={confirmDelete}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}

      {/* ── Card detail overlay (click sur un pill) ── */}
      {detailCard && ReactDOM.createPortal(
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 900 }}
            onClick={() => setDetailCard(null)}
          />
          <div style={{
            position: "fixed", right: 0, top: 0, bottom: 0, width: 320,
            zIndex: 901, overflowY: "auto", background: "var(--bg-secondary)",
            borderLeft: "1px solid var(--border)",
            boxShadow: "-4px 0 20px rgba(0,0,0,0.4)",
          }}>
            <CardDetail
              card={detailCard}
              displayLang={displayLang}
              setIconUrl={null}
              onClose={() => setDetailCard(null)}
            />
          </div>
        </>,
        document.body
      )}

      {/* ── Context menu clic droit ── */}
      {comboCtxMenu && ReactDOM.createPortal(
        <>
          <div className={styles.ctxBackdrop} onMouseDown={() => setComboCtxMenu(null)} />
          <div
            className={styles.ctxMenu}
            style={{
              left: Math.min(comboCtxMenu.x, window.innerWidth - 240),
              top: Math.min(comboCtxMenu.y, window.innerHeight - 60 - openDecks.length * 40),
            }}
            onMouseDown={e => e.stopPropagation()}
          >
            <div className={styles.ctxMenuTitle}>{t("combo.addToDeck")}</div>
            {openDecks.length === 0 ? (
              <div className={styles.ctxMenuEmpty}>{t("combo.noOpenDeck")}</div>
            ) : openDecks.map(d => {
              const legal = isComboLegalForDeck(comboCtxMenu.combo, d);
              return (
                <button
                  key={d.deck.id}
                  className={`${styles.ctxMenuItem} ${!legal ? styles.ctxMenuItemDisabled : ""}`}
                  disabled={!legal}
                  title={!legal ? t("combo.outOfFormat", { format: d.deck.format }) : ""}
                  onClick={() => { setComboCtxMenu(null); setAddToDeckState({ combo: comboCtxMenu.combo, deck: d, qty: 1 }); }}
                >
                  <span className={styles.ctxMenuDeckName}>{d.deck.name}</span>
                  <span className={styles.ctxMenuFormat}>{d.deck.format}</span>
                  {!legal && <span className={styles.ctxMenuBan}>🚫</span>}
                </button>
              );
            })}
          </div>
        </>,
        document.body
      )}

      {/* ── Popup quantité ── */}
      {addToDeckState && ReactDOM.createPortal(
        <div className={styles.addDeckBackdrop} onClick={() => setAddToDeckState(null)}>
          <div className={styles.addDeckDialog} onClick={e => e.stopPropagation()}>
            <p className={styles.addDeckTitle}>{t("combo.addToDeck")}</p>
            <p className={styles.addDeckSub}>
              <strong>{addToDeckState.combo.name || t("combo.unnamed")}</strong>
              <span className={styles.addDeckArrow}>→</span>
              <em>{addToDeckState.deck.deck.name}</em>
            </p>
            <p className={styles.addDeckNote}>
              {t("combo.totalCards", { count: addToDeckState.combo.cards.length * addToDeckState.qty })}
              {" "}{t("combo.breakdown", { cards: addToDeckState.combo.cards.length, qty: addToDeckState.qty })}
            </p>
            <div className={styles.qtyRow}>
              <button
                className={styles.qtyBtn}
                onClick={() => setAddToDeckState(s => s && s.qty > 1 ? { ...s, qty: s.qty - 1 } : s)}
                disabled={addToDeckState.qty <= 1}
              >−</button>
              <span className={styles.qtyVal}>{addToDeckState.qty}</span>
              <button
                className={styles.qtyBtn}
                onClick={() => setAddToDeckState(s => s && s.qty < 4 ? { ...s, qty: s.qty + 1 } : s)}
                disabled={addToDeckState.qty >= 4}
              >+</button>
            </div>
            <div className={styles.addDeckActions}>
              <button className={styles.addDeckCancel} onClick={() => setAddToDeckState(null)}>{t("combo.cancel")}</button>
              <button className={styles.addDeckSend} onClick={() => sendCardsToDeck(addToDeckState)}>{t("combo.send")}</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// ─── Combo Creator : full browser panel + DnD + detail panel ────────────────

export function ComboCreator({
  onClose, onToast, displayLang, langCode = "en", imageLangCode = "en", editCombo, pendingAdd, favoriteIds: _favoriteIds, onContextMenu,
}: {
  onClose: () => void;
  onToast?: (msg: string, type?: "success" | "error" | "info") => void;
  displayLang: string;
  langCode?: string;
  imageLangCode?: string;
  editCombo?: Combo;
  pendingAdd?: Card[];
  favoriteIds?: Set<string>;
  onContextMenu?: (card: Card, x: number, y: number) => void;
}) {
  const t = useT();
  // ── Browser state ─────────────────────────────────────────────────────────
  const [query, setQuery]         = useState("");
  const [results, setResults]     = useState<Card[]>([]);
  const [loading, setLoading]     = useState(false);
  const [filters, setFilters]     = useState<CardFilters>({ sort_by: "cmc" });
  const [sets, setSets]           = useState<SetInfo[]>([]);
  const [setNames, setSetNames]   = useState<Record<string, string>>({});
  const [setIcons, setSetIcons]   = useState<Record<string, string>>({});
  const [setDates, setSetDates]   = useState<Record<string, string>>({});
  const [filterSets, setFilterSets] = useState<string[]>([]);
  const [setPickerOpen, setSetPickerOpen] = useState(false);
  const [excludeAlchemy, setExcludeAlchemy] = useState(false);
  const [zoom, setZoom]           = useState<number>(() => Number(localStorage.getItem("card_zoom") ?? "120"));
  const setPickerRef              = useRef<HTMLDivElement>(null);
  const gridRef                   = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(700);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Format filter ──────────────────────────────────────────────────────────
  const [scryfallSetsC, setScryfallSetsC] = useState<ScryfallSetC[]>([]);
  const [formatFilter, setFormatFilter]   = useState("");
  const scryfallSetsCRef = useRef<ScryfallSetC[]>([]);
  const formatFilterRef  = useRef("");
  scryfallSetsCRef.current = scryfallSetsC;
  formatFilterRef.current  = formatFilter;

  // ── Detail card panel ─────────────────────────────────────────────────────
  const [detailCard, setDetailCard]   = useState<Card | null>(null);
  const [hoverCard,  setHoverCard]    = useState<{ card: Card; x: number; y: number } | null>(null);

  // ── Selection + form state ────────────────────────────────────────────────
  const [selected, setSelected]       = useState<Card[]>([]);
  const [name, setName]               = useState(editCombo?.name ?? "");
  const [description, setDescription] = useState(editCombo?.description ?? "");
  const [selectedTags, setSelectedTags] = useState<string[]>(
    () => (editCombo?.tags ?? "").split(",").map(t => t.trim()).filter(t => COMBO_TAGS.includes(t))
  );
  const [saving, setSaving]           = useState(false);

  // ── DnD ───────────────────────────────────────────────────────────────────
  const [draggingCard, setDraggingCard] = useState<Card | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );
  const { setNodeRef: setDropRef, isOver: isDropOver } = useDroppable({ id: "combo-drop" });

  const dragCardRef = useRef<Card | null>(null);
  const formPanelDomRef = useRef<HTMLDivElement | null>(null);
  const dropListenerRef = useRef<((e: PointerEvent) => void) | null>(null);

  const handleDragStart = (e: DragStartEvent) => {
    const card = e.active.data.current?.card as Card ?? null;
    dragCardRef.current = card;
    setDraggingCard(card);
    if (!card) return;
    const onUp = (ev: PointerEvent) => {
      document.removeEventListener("pointerup", onUp, true);
      dropListenerRef.current = null;
      const c = dragCardRef.current;
      if (!c) return;
      const el = formPanelDomRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
        setSelected(prev => prev.some(x => x.id === c.id) ? prev : [...prev, c]);
      }
    };
    dropListenerRef.current = onUp;
    document.addEventListener("pointerup", onUp, true);
  };
  const handleDragEnd = (_e: DragEndEvent) => {
    if (dropListenerRef.current) {
      document.removeEventListener("pointerup", dropListenerRef.current, true);
      dropListenerRef.current = null;
    }
    dragCardRef.current = null;
    setDraggingCard(null);
  };

  const toggleTag = (tag: string) =>
    setSelectedTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);

  // ── Search ────────────────────────────────────────────────────────────────
  const search = useCallback(async (q: string, f: CardFilters, set: string[]) => {
    setLoading(true);
    try {
      const af: CardFilters = { ...f };
      // Apply format restriction from format dropdown
      const fmt = formatFilterRef.current;
      const formatCodes = fmt ? getFormatSetCodesC(fmt, scryfallSetsCRef.current) : null;
      // Sets manuellement sélectionnés → priorité sur la restriction de format
      const effectiveSets: string[] | undefined = set.length > 0
        ? set
        : (formatCodes ?? undefined);
      if (effectiveSets && effectiveSets.length > 0) af.set_codes = effectiveSets;
      const res = await invoke<Card[]>("search_cards", { query: q, limit: 99999, filters: af, langCode, imageLangCode });
      const seen = new Set<string>();
      setResults(res.filter((c) => {
        const key = c.oracle_id ?? c.id;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      }));
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }, []);

  // Pré-charge les cartes quand on réouvre un combo existant
  useEffect(() => {
    if (!editCombo || editCombo.cards.length === 0) return;
    invoke<Card[]>("get_cards_by_names", { names: editCombo.cards, langCode, imageLangCode })
      .then(cards => {
        // Preserve order from editCombo.cards
        const cardMap: Record<string, Card> = {};
        for (const c of cards) cardMap[c.name_en] = c;
        setSelected(editCombo.cards.map(n => cardMap[n]).filter(Boolean));
      })
      .catch(console.error);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Consomme les cartes envoyées depuis le menu contextuel ───────────────────
  useEffect(() => {
    if (!pendingAdd || pendingAdd.length === 0) return;
    pendingAdd.forEach(card => addCard(card));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAdd]);

  useEffect(() => {
    invoke<SetInfo[]>("get_sets").then(setSets).catch(() => {});
    search("", { sort_by: "cmc" }, []);
    fetch("https://api.scryfall.com/sets").then(r => r.json()).then((data) => {
      const names: Record<string, string> = {};
      const icons: Record<string, string> = {};
      const dates: Record<string, string> = {};
      const sfSets: ScryfallSetC[] = [];
      for (const s of data.data ?? []) {
        names[s.code] = s.name;
        if (s.icon_svg_uri) icons[s.code] = s.icon_svg_uri;
        if (s.released_at) dates[s.code] = s.released_at;
        sfSets.push({ code: s.code, set_type: s.set_type ?? "", released_at: s.released_at ?? "", arena_code: s.arena_code });
      }
      setSetNames(names); setSetIcons(icons); setSetDates(dates);
      const arenaCodes = sfSets.filter(s => !!s.arena_code).map(s => s.code);
      localStorage.setItem("scryfall_arena_set_codes", JSON.stringify(arenaCodes));
      setScryfallSetsC(sfSets);
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (setPickerRef.current && !setPickerRef.current.contains(e.target as Node))
        setSetPickerOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    setContainerWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setContainerWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleInput = (v: string) => {
    setQuery(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(v, filters, filterSets), 250);
  };

  // ── Filter toggles ────────────────────────────────────────────────────────
  const toggleColor = (code: string) => {
    const cur = filters.colors ?? [];
    const next = cur.includes(code) ? cur.filter(c => c !== code) : [...cur, code];
    const nf = { ...filters, colors: next.length ? next : undefined };
    setFilters(nf); search(query, nf, filterSets);
  };
  const toggleMulticolor = () => {
    const nf = { ...filters, multicolor: filters.multicolor ? undefined : true };
    setFilters(nf); search(query, nf, filterSets);
  };
  const toggleRarity = (code: string) => {
    const cur = filters.rarities ?? [];
    const next = cur.includes(code) ? cur.filter(r => r !== code) : [...cur, code];
    const nf = { ...filters, rarities: next.length ? next : undefined };
    setFilters(nf); search(query, nf, filterSets);
  };
  const toggleType = (code: string) => {
    const cur = filters.card_types ?? [];
    const next = cur.includes(code) ? cur.filter(t => t !== code) : [...cur, code];
    const nf = { ...filters, card_types: next.length ? next : undefined };
    setFilters(nf); search(query, nf, filterSets);
  };
  const toggleCmc = (val: typeof CMC_BTNS[number]) => {
    const num = val === "7+" ? 7 : (val as number);
    const cur = filters.cmc_values ?? [];
    const next = cur.includes(num) ? cur.filter(v => v !== num) : [...cur, num];
    const nf = { ...filters, cmc_values: next.length ? next : undefined };
    setFilters(nf); search(query, nf, filterSets);
  };
  const setSort = (s: "name" | "cmc" | "rarity") => {
    const nf = { ...filters, sort_by: s };
    setFilters(nf); search(query, nf, filterSets);
  };
  const toggleOwnedOnly = () => {
    const nf = { ...filters, owned_only: filters.owned_only ? undefined : true };
    setFilters(nf); search(query, nf, filterSets);
  };
  const clearFilters = () => {
    const nf: CardFilters = { sort_by: "cmc" };
    setFilters(nf); setFilterSets([]);
    setFormatFilter(""); formatFilterRef.current = "";
    search(query, nf, []);
  };
  const handleZoom = (val: number) => {
    setZoom(val); localStorage.setItem("card_zoom", String(val));
  };

  // ── Selection helpers ─────────────────────────────────────────────────────
  const selectedIds = useMemo(() => new Set(selected.map(c => c.id)), [selected]);
  const addCard = (card: Card) => {
    setSelected(prev => {
      if (prev.some(c => c.id === card.id)) return prev;
      // Auto-nommage depuis la première carte si le nom est encore vide
      if (prev.length === 0 && !name.trim()) {
        const cardName = displayLang === "fr" ? (card.name_fr ?? card.name_en) : card.name_en;
        setName(cardName);
      }
      return [...prev, card];
    });
  };
  const removeCard = (card: Card) => {
    setSelected(prev => prev.filter(c => c.id !== card.id));
  };

  // ── Save ──────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (selected.length === 0 || !name.trim()) return;
    setSaving(true);
    try {
      if (editCombo) {
        await invoke("delete_combo", { id: editCombo.id });
      }
      await invoke("create_combo", {
        name: name.trim(),
        cards: selected.map(c => c.name_en),
        description: description.trim(),
        tags: selectedTags.join(", "),
        source: editCombo?.source ?? "manual",
      });
      onToast?.(editCombo ? t("combo.updated") : t("combo.saved"), "success");
      onClose();
    } catch (err) {
      onToast?.(t("toast.error", { msg: String(err) }), "error");
    } finally {
      setSaving(false);
    }
  };

  // ── Computed ──────────────────────────────────────────────────────────────
  const hasFilters = (filters.colors?.length ?? 0) > 0 || filters.multicolor ||
    (filters.rarities?.length ?? 0) > 0 || (filters.card_types?.length ?? 0) > 0 ||
    (filters.cmc_values?.length ?? 0) > 0 || filterSets.length > 0;

  const selColors   = filters.colors ?? [];
  const selRarities = filters.rarities ?? [];

  const sortedSets = useMemo(() => {
    let arenaCodes: Set<string> | null = null;
    if (scryfallSetsC.length > 0) {
      arenaCodes = new Set(scryfallSetsC.filter(s => !!s.arena_code).map(s => s.code));
    } else {
      try {
        const cached = localStorage.getItem("scryfall_arena_set_codes");
        if (cached) arenaCodes = new Set(JSON.parse(cached) as string[]);
      } catch { /* ignore */ }
    }
    return [...sets]
      .filter(s => !arenaCodes || arenaCodes.has(s.code))
      .sort((a, b) => (setDates[b.code] ?? "").localeCompare(setDates[a.code] ?? ""));
  }, [sets, setDates, scryfallSetsC]);

  const filteredResults = useMemo(
    () => excludeAlchemy ? results.filter(c => !c.name_en.startsWith("A-")) : results,
    [results, excludeAlchemy]
  );

  // ── Virtual grid ──────────────────────────────────────────────────────────
  const COLS  = Math.max(1, Math.floor((containerWidth - 12) / (zoom + 8)));
  const colW  = Math.max(1, (containerWidth - 20 - (COLS - 1) * 8) / COLS);
  const ROW_H = Math.ceil(colW * (88 / 63)) + 36;
  const vRows = useMemo(() => {
    const out: Card[][] = [];
    for (let i = 0; i < filteredResults.length; i += COLS) out.push(filteredResults.slice(i, i + COLS));
    return out;
  }, [filteredResults, COLS]);
  const rowVirtualizer = useVirtualizer({
    count: vRows.length,
    getScrollElement: () => gridRef.current,
    estimateSize: () => ROW_H,
    overscan: 4,
  });

  const dragImg = draggingCard
    ? (displayLang === "fr"
        ? (draggingCard.image_uri_fr ?? draggingCard.image_uri_normal ?? draggingCard.image_uri_small)
        : (draggingCard.image_uri_normal ?? draggingCard.image_uri_small))
    : null;

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => { dragCardRef.current = null; setDraggingCard(null); }}
      autoScroll={false}
    >
      <div className={styles.creatorContainer}>
        {/* Header */}
        <div className={styles.creatorHeader}>
          <h2 className={styles.title}>{t("combo.new")}</h2>
          <button className="btn-ghost" onClick={onClose}>{t("combo.creatorCancel")}</button>
        </div>

        <div className={styles.creatorBody}>

          {/* ── LEFT : full card browser ── */}
          <div className={styles.browserPanel}>
            <div className={styles.searchRow}>
              <input
                className={styles.searchInput}
                type="text"
                placeholder={t("combo.searchCard")}
                value={query}
                onChange={e => handleInput(e.target.value)}
                autoFocus
              />
              <div className={styles.zoomWrap}>
                <span className={styles.zoomIcon}>⊞</span>
                <span className={styles.zoomTrack}>
                  <input type="range" min="80" max="200" value={zoom}
                    className={styles.zoomSlider}
                    onChange={e => handleZoom(Number(e.target.value))} />
                  <span className={styles.zoomThumb}
                    style={{ left: `${((zoom - 80) / (200 - 80)) * 100}%` }} />
                </span>
              </div>
            </div>

            <div className={styles.filterBar}>
              <div className={styles.filterGroup}>
                {COLOR_BTNS.map((c) => (
                  <button key={c.code}
                    className={`${styles.colorBtn} ${selColors.includes(c.code) ? styles.filterActive : ""}`}
                    title={t(`color.${c.code}`)} onClick={() => toggleColor(c.code)}>
                    <img src={`${SVG}/${c.code}.svg`} alt={c.code} width={20} height={20} />
                  </button>
                ))}
                <button className={`${styles.multicolorBtn} ${filters.multicolor ? styles.filterActive : ""}`}
                  title={t("filter.multicolor")} onClick={toggleMulticolor} />
              </div>
              <div className={styles.filterGroup}>
                {TYPE_BTNS.map((tb) => (
                  <button key={tb.code}
                    className={`${styles.typeBtn} ${tb.code === "Land" ? styles.landBtn : ""} ${(filters.card_types ?? []).includes(tb.code) ? styles.filterActive : ""}`}
                    title={t(`type.${tb.code}`)} onClick={() => toggleType(tb.code)}><i className={`ms ms-${tb.ms}`} /></button>
                ))}
              </div>
              <div className={styles.filterGroup}>
                {CMC_BTNS.map((n) => {
                  const num = n === "7+" ? 7 : (n as number);
                  const active = (filters.cmc_values ?? []).includes(num);
                  return (
                    <button key={n}
                      className={`${styles.cmcBtn} ${active ? styles.filterActive : ""}`}
                      title={n === "7+" ? t("combo.cmcGte") : t("combo.cmcEq", { n })}
                      onClick={() => toggleCmc(n)}>{n}</button>
                  );
                })}
              </div>
              <div className={styles.filterGroup}>
                {RARITY_BTNS.map((code) => (
                  <button key={code}
                    className={`${styles.rarityBtn} ${selRarities.includes(code) ? styles.filterActive : ""}`}
                    title={t(`rarity.${code}`)}
                    onClick={() => toggleRarity(code)}>
                    <i className="ms ms-rarity" style={{ color: RARITY_COLORS[code], fontSize: "1.1em" }} />
                  </button>
                ))}
              </div>
              <div className={styles.filterGroup}>
                <div className={styles.setPicker} ref={setPickerRef}>
                  <button
                    className={`${styles.setPickerBtn} ${filterSets.length > 0 ? styles.filterActive : ""}`}
                    onClick={() => setSetPickerOpen(v => !v)}
                    title={filterSets.length > 0 ? filterSets.map(c => setNames[c] ?? c.toUpperCase()).join(", ") : t("filter.allSets")}>
                    {filterSets.length === 1 && setIcons[filterSets[0]] && <img src={setIcons[filterSets[0]]} alt="" className={styles.setIcon} />}
                    <span className={styles.setPickerLabel}>
                      {filterSets.length === 0 ? t("filter.set")
                        : filterSets.length === 1 ? (setNames[filterSets[0]] ?? filterSets[0].toUpperCase())
                        : t("filter.setsCount", { count: filterSets.length })}
                    </span>
                    <span className={styles.setPickerArrow}>▾</span>
                  </button>
                  {setPickerOpen && (
                    <div className={styles.setPickerDropdown}>
                      <div className={`${styles.setPickerOption} ${filterSets.length === 0 ? styles.setPickerOptionActive : ""}`}
                        onClick={() => { setFilterSets([]); search(query, filters, []); }}>{t("filter.allSets")}</div>
                      {sortedSets.map(s => {
                        const checked = filterSets.includes(s.code);
                        const toggle = () => {
                          const next = checked ? filterSets.filter(c => c !== s.code) : [...filterSets, s.code];
                          setFilterSets(next); search(query, filters, next);
                        };
                        return (
                          <div key={s.code}
                            className={`${styles.setPickerOption} ${checked ? styles.setPickerOptionActive : ""}`}
                            onClick={toggle}>
                            <span className={styles.setPickerCheck}>{checked ? "☑" : "☐"}</span>
                            {setIcons[s.code] && <img src={setIcons[s.code]} alt="" className={styles.setIcon} />}
                            <span>{setNames[s.code] ?? s.code.toUpperCase()}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                <select className={styles.compactSelect} value={filters.sort_by ?? "cmc"}
                  onChange={e => setSort(e.target.value as "name" | "cmc" | "rarity")}>
                  <option value="cmc">{t("combo.sortCmc")}</option>
                  <option value="name">{t("combo.sortAz")}</option>
                  <option value="rarity">{t("combo.sortRarity")}</option>
                </select>
                <select className={styles.compactSelect} value={formatFilter}
                  onChange={e => {
                    const fmt = e.target.value;
                    setFormatFilter(fmt);
                    formatFilterRef.current = fmt;
                    search(query, filters, filterSets);
                  }}
                >
                  <option value="">{t("combo.formatPlaceholder")}</option>
                  {FORMATS_COMBO.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
                {hasFilters && <button className={styles.clearBtn} onClick={clearFilters} title={t("combo.clear")}>✕</button>}
              </div>
              {/* Collection + Alchemy filter */}
              <div className={styles.filterGroup}>
                <button
                  className={`${styles.typeBtn} ${filters.owned_only ? styles.filterActive : ""}`}
                  title={t("filter.ownedOnly")}
                  onClick={toggleOwnedOnly}
                >📦</button>
                <button
                  className={`${styles.typeBtn} ${excludeAlchemy ? styles.filterActive : ""}`}
                  title={t("filter.excludeAlchemy")}
                  onClick={() => setExcludeAlchemy(v => !v)}
                ><IcoNoAlchemy /></button>
              </div>
            </div>

            {/* Card grid */}
            <div className={styles.grid} ref={gridRef}>
              {loading && <p className={styles.status}>{t("view.searching")}</p>}
              {!loading && filteredResults.length === 0 && (
                <p className={styles.status}>
                  {query ? t("combo.noResultFor", { query }) : (excludeAlchemy && results.length > 0 ? t("combo.allAlchemy") : t("combo.loading"))}
                </p>
              )}
              {!loading && filteredResults.length > 0 && (
                <>
                  <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
                    {rowVirtualizer.getVirtualItems().map((vRow) => (
                      <div
                        key={vRow.index}
                        style={{
                          position: "absolute", top: 0,
                          transform: `translateY(${vRow.start}px)`,
                          left: 0, right: 0,
                          display: "grid",
                          gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`,
                          gap: "8px",
                        }}
                      >
                        {vRows[vRow.index].map((card) => (
                          <DraggableComboTile
                            key={card.id}
                            card={card}
                            displayLang={displayLang}
                            isSelected={selectedIds.has(card.id)}
                            isDraggingAny={!!draggingCard}
                            zoom={zoom}
                            onAdd={() => addCard(card)}
                            onRemove={() => removeCard(card)}
                            onCardClick={() => {
                              setDetailCard(card);
                              invoke<Card | null>("get_card_by_id", { cardId: card.id })
                                .then(full => { if (full) setDetailCard(full); })
                                .catch(() => {});
                            }}
                            onContextMenu={onContextMenu}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                  <p className={styles.resultCount}>
                    {t("combo.resultCount", { count: filteredResults.length })}{excludeAlchemy && results.length !== filteredResults.length ? t("combo.alchemyExcluded", { count: results.length - filteredResults.length }) : ""}
                  </p>
                </>
              )}
            </div>
          </div>

          {/* ── CENTER : fiche détail (optionnelle) ── */}
          {detailCard && (
            <div className={styles.detailPanel}>
              <CardDetail
                card={detailCard}
                displayLang={displayLang}
                setIconUrl={null}
                onAddMain={() => { addCard(detailCard); }}
                onAddSide={undefined}
                onClose={() => setDetailCard(null)}
              />
            </div>
          )}

          {/* ── RIGHT : selection + form ── */}
          <div
            className={styles.formPanel}
            ref={formPanelDomRef}
          >
            {/* Drop zone */}
            <div
              ref={setDropRef}
              className={`${styles.selectedSection} ${isDropOver ? styles.selectedSectionOver : ""}`}
            >
              <div className={styles.selectedHeader}>
                <span>{t("combo.comboCards")}</span>
                <span className={styles.selectedCount}>{selected.length}</span>
              </div>
              {selected.length === 0 ? (
                <p className={styles.selectedEmpty}>
                  {isDropOver ? t("combo.dropHere") : t("combo.dragHint")}
                </p>
              ) : (
                <div className={styles.selectedList}>
                  {selected.map(card => {
                    const cardName = displayLang === "fr" ? (card.name_fr ?? card.name_en) : card.name_en;
                    return (
                      <div key={card.id} className={styles.selectedItem}
                        style={{ cursor: "pointer" }}
                        onMouseEnter={e => setHoverCard({ card, x: e.clientX, y: e.clientY })}
                        onMouseMove={e  => setHoverCard({ card, x: e.clientX, y: e.clientY })}
                        onMouseLeave={() => setHoverCard(null)}
                        onClick={() => {
                          setHoverCard(null);
                          setDetailCard(card);
                          invoke<Card | null>("get_card_by_id", { cardId: card.id })
                            .then(full => { if (full) setDetailCard(full); })
                            .catch(() => {});
                        }}
                        onContextMenu={onContextMenu ? (e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(card, e.clientX, e.clientY); } : undefined}
                      >
                        <RarityGem rarity={card.rarity} />
                        {card.mana_cost && <ManaCost cost={card.mana_cost} size={10} />}
                        <span className={styles.selectedName}>{cardName}</span>
                        <button className={styles.selectedRemove}
                          onClick={(e) => { e.stopPropagation(); removeCard(card); }} title={t("combo.removeTile")}>×</button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Form fields */}
            <div className={styles.formSection}>
              <div className={styles.formRow}>
                <label className={styles.label}>{t("combo.nameLabel")} <span className={styles.required}>*</span></label>
                <input
                  className={`${styles.formInput} ${name.trim() === "" && selected.length > 0 ? styles.formInputError : ""}`}
                  type="text"
                  placeholder={t("combo.namePlaceholder")}
                  value={name}
                  onChange={e => setName(e.target.value)}
                />
              </div>
              <div className={styles.formRow}>
                <label className={styles.label}>{t("combo.descLabel")} <span className={styles.labelOptional}>{t("combo.optional")}</span></label>
                <textarea className={styles.formTextarea} rows={3}
                  placeholder={t("combo.descPlaceholder")} value={description}
                  onChange={e => setDescription(e.target.value)} />
              </div>
              <div className={styles.formRow}>
                <label className={styles.label}>{t("combo.tagsLabel")} <span className={styles.labelOptional}>{t("combo.optional")}</span></label>
                <div className={styles.tagPicker}>
                  {COMBO_TAGS.map(tag => (
                    <button key={tag}
                      className={`${styles.tagChipPicker} ${selectedTags.includes(tag) ? styles.tagChipPickerActive : ""}`}
                      onClick={() => toggleTag(tag)}>{tagLabel(t, tag)}</button>
                  ))}
                </div>
              </div>
            </div>

            <button
              className="btn-primary"
              onClick={handleSave}
              disabled={saving || selected.length === 0 || !name.trim()}
              style={{ width: "100%", marginTop: 8 }}
            >
              {saving ? t("combo.saving")
                : selected.length === 0 ? t("combo.addCardsFirst")
                : !name.trim() ? t("combo.enterName")
                : t("combo.save", { count: selected.length })}
            </button>
          </div>
        </div>
      </div>

      <DragOverlay dropAnimation={null}>
        {dragImg && (
          <img src={dragImg} alt="" style={{ width: zoom, borderRadius: 8, opacity: 0.92, pointerEvents: "none" }} />
        )}
      </DragOverlay>

      {/* ── Hover preview (CARTES DU COMBO) — portal hors overflow ── */}
      {hoverCard && (() => {
        const c = hoverCard.card;
        const imgSrc = displayLang === "fr"
          ? (c.image_uri_fr ?? c.image_uri_normal ?? c.image_uri_small)
          : (c.image_uri_normal ?? c.image_uri_small);
        if (!imgSrc) return null;
        const PW = 180;
        const left = hoverCard.x + 16 + PW > window.innerWidth
          ? hoverCard.x - PW - 8 : hoverCard.x + 16;
        const top = Math.max(8, Math.min(hoverCard.y - 30, window.innerHeight - 270));
        return ReactDOM.createPortal(
          <div style={{
            position: "fixed", left, top, zIndex: 9999, pointerEvents: "none",
            borderRadius: 10, overflow: "hidden",
            boxShadow: "0 8px 32px rgba(0,0,0,0.7)",
          }}>
            <img src={imgSrc} alt={displayLang === "fr" ? (c.name_fr ?? c.name_en) : c.name_en}
              style={{ width: PW, display: "block" }} />
          </div>,
          document.body
        );
      })()}
    </DndContext>
  );
}

// ─── DraggableComboTile ────────────────────────────────────────────────────────

function DraggableComboTile({
  card, displayLang, isSelected, isDraggingAny, zoom, onAdd, onRemove, onCardClick, onContextMenu,
}: {
  card: Card; displayLang: string; isSelected: boolean; isDraggingAny: boolean;
  zoom: number;
  onAdd: () => void; onRemove: () => void;
  onCardClick?: () => void;
  onContextMenu?: (card: Card, x: number, y: number) => void;
}) {
  const t = useT();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: card.id, data: { card },
  });
  const imgSrc = displayLang === "fr"
    ? (card.image_uri_fr ?? card.image_uri_normal ?? card.image_uri_small)
    : (card.image_uri_normal ?? card.image_uri_small);
  const cardName = displayLang === "fr" ? (card.name_fr ?? card.name_en) : card.name_en;

  return (
    <div
      ref={setNodeRef}
      className={`${styles.tile} ${isSelected ? styles.tileSelected : ""}`}
      style={{ width: zoom, opacity: isDragging ? 0 : 1, touchAction: "none" }}
      title={t("combo.dragToAdd")}
      onContextMenu={onContextMenu ? (e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(card, e.clientX, e.clientY); } : undefined}
      {...listeners}
      {...attributes}
      onClick={() => onCardClick?.()}
    >
      {imgSrc
        ? <img className={styles.tileImg} src={imgSrc} alt={cardName} loading="lazy" />
        : <div className={styles.tileNoImg}>{cardName}</div>
      }
      <div className={styles.tileMeta}>
        <RarityGem rarity={card.rarity} />
        <span className={styles.tileName}>{cardName}</span>
        {card.mana_cost && <ManaCost cost={card.mana_cost} size={9} />}
      </div>
      {/* + / ✓ button — stops drag propagation */}
      <button
        className={`${styles.tileAdd} ${isSelected ? styles.tileAddSelected : ""}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); isSelected ? onRemove() : onAdd(); }}
        title={isSelected ? t("combo.removeFromCombo") : t("combo.addToCombo")}
        style={{ opacity: isDraggingAny ? 0 : undefined }}
      >{isSelected ? "✓" : "+"}</button>
    </div>
  );
}
