import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DeckCard, DeckWithCards } from "../types";
import CardDetail from "./CardDetail";
import DeckStats from "./DeckStats";
import styles from "./DeckBuilder.module.css";

interface Props {
  deckData: DeckWithCards;
  onChange: (updated: DeckWithCards) => void;
  onToast?: (msg: string, type?: "success" | "error" | "info") => void;
}

export default function DeckBuilder({ deckData, onChange, onToast }: Props) {
  const [selectedCard, setSelectedCard] = useState<DeckCard | null>(null);
  const [showStats, setShowStats] = useState(true);
  const { deck, cards } = deckData;

  const refresh = async () => {
    const updated = await invoke<DeckWithCards>("get_deck_with_cards", { deckId: deck.id });
    onChange(updated);
  };

  const updateQty = async (dc: DeckCard, delta: number) => {
    const newQty = dc.quantity + delta;
    await invoke("update_card_quantity", {
      deckId: deck.id, cardId: dc.card.id, board: dc.board, quantity: newQty,
    });
    refresh();
  };

  const removeCard = async (dc: DeckCard) => {
    await invoke("remove_card_from_deck", {
      deckId: deck.id, cardId: dc.card.id, board: dc.board,
    });
    refresh();
    if (selectedCard?.card.id === dc.card.id) setSelectedCard(null);
    onToast?.(`${dc.card.name_en} retiré`, "info");
  };

  const addCardToBoard = async (card: DeckCard["card"], board: "main" | "sideboard") => {
    await invoke("add_card_to_deck", {
      deckId: deck.id, cardId: card.id, quantity: 1, board,
    });
    refresh();
    onToast?.(`${card.name_en} ajouté`, "success");
  };

  const exportDeck = async () => {
    const content = await invoke<string>("export_deck_mtga", { deckId: deck.id });
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${deck.name.replace(/[^a-z0-9]/gi, "_")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    onToast?.("Deck exporté", "success");
  };

  const copyToClipboard = async () => {
    const content = await invoke<string>("export_deck_mtga", { deckId: deck.id });
    await navigator.clipboard.writeText(content);
    onToast?.("Copié dans le presse-papiers !", "success");
  };

  const main      = cards.filter((c) => c.board === "main");
  const side      = cards.filter((c) => c.board === "sideboard");
  const commander = cards.filter((c) => c.board === "commander");
  const totalMain = main.reduce((s, c) => s + c.quantity, 0);

  return (
    <div className={styles.container}>
      {/* En-tête */}
      <div className={styles.header}>
        <div>
          <h1 className={styles.deckName}>{deck.name}</h1>
          <span className={styles.format}>{deck.format}</span>
          <span className={styles.totalCount}>{totalMain} cartes</span>
        </div>
        <div className={styles.headerActions}>
          <button
            className={`btn-ghost ${showStats ? styles.activeBtn : ""}`}
            onClick={() => setShowStats((v) => !v)}
            title="Statistiques du deck"
          >
            📊 Stats
          </button>
          <button className="btn-ghost" onClick={copyToClipboard}>📋 Copier</button>
          <button className="btn-ghost" onClick={exportDeck}>⬇ Exporter</button>
        </div>
      </div>

      <div className={styles.body}>
        {/* ── Liste des cartes ── */}
        <div className={styles.cardList}>
          {commander.length > 0 && (
            <BoardSection title="Commander" icon="👑"
              cards={commander} onSelect={setSelectedCard} selected={selectedCard}
              onQty={updateQty} onRemove={removeCard} />
          )}
          <BoardSection title="Deck principal" icon="⚔"
            cards={main} onSelect={setSelectedCard} selected={selectedCard}
            onQty={updateQty} onRemove={removeCard} />
          {side.length > 0 && (
            <BoardSection title="Sideboard" icon="🛡"
              cards={side} onSelect={setSelectedCard} selected={selectedCard}
              onQty={updateQty} onRemove={removeCard} />
          )}
          {cards.length === 0 && (
            <p className={styles.empty}>
              Deck vide — cherche des cartes dans l'onglet Recherche pour les ajouter.
            </p>
          )}
        </div>

        {/* ── Panneau droit : stats ou détail carte ── */}
        <div className={styles.rightPanel}>
          {selectedCard ? (
            <CardDetail
              card={selectedCard.card}
              onAddMain={() => addCardToBoard(selectedCard.card, "main")}
              onAddSide={() => addCardToBoard(selectedCard.card, "sideboard")}
              onClose={() => setSelectedCard(null)}
            />
          ) : showStats && cards.length > 0 ? (
            <DeckStats cards={cards} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ─── Section (commander / mainboard / sideboard) ──────────────────────────────
function BoardSection({ title, icon, cards, onSelect, selected, onQty, onRemove }: {
  title: string; icon: string; cards: DeckCard[];
  onSelect: (dc: DeckCard) => void; selected: DeckCard | null;
  onQty: (dc: DeckCard, delta: number) => void; onRemove: (dc: DeckCard) => void;
}) {
  const total  = cards.reduce((s, c) => s + c.quantity, 0);
  const groups = groupByType(cards);

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <span>{icon} {title}</span>
        <span className={styles.sectionCount}>{total}</span>
      </div>
      {groups.map(([groupName, groupCards]) => (
        <div key={groupName} className={styles.typeGroup}>
          <div className={styles.typeGroupLabel}>
            {groupName} ({groupCards.reduce((s, c) => s + c.quantity, 0)})
          </div>
          {groupCards.map((dc) => (
            <CardRow
              key={`${dc.card.id}-${dc.board}`}
              dc={dc}
              selected={selected?.card.id === dc.card.id && selected?.board === dc.board}
              onSelect={() => onSelect(dc)}
              onInc={() => onQty(dc, +1)}
              onDec={() => onQty(dc, -1)}
              onRemove={() => onRemove(dc)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// ─── Ligne de carte ────────────────────────────────────────────────────────────
function CardRow({ dc, selected, onSelect, onInc, onDec, onRemove }: {
  dc: DeckCard; selected: boolean;
  onSelect: () => void; onInc: () => void; onDec: () => void; onRemove: () => void;
}) {
  return (
    <div
      className={`${styles.cardRow} ${selected ? styles.cardRowSelected : ""}`}
      onClick={onSelect}
    >
      <div className={styles.qtyControls} onClick={(e) => e.stopPropagation()}>
        <button className={styles.qtyBtn} onClick={onDec}>−</button>
        <span className={styles.qty}>{dc.quantity}</span>
        <button className={styles.qtyBtn} onClick={onInc}>+</button>
      </div>
      <span className={`${styles.cardName} rarity-${dc.card.rarity}`}>
        {dc.card.name_en}
        {dc.card.name_fr && dc.card.name_fr !== dc.card.name_en && (
          <span className={styles.frName}> · {dc.card.name_fr}</span>
        )}
      </span>
      {dc.card.mana_cost && (
        <span className={styles.manaCost}>{dc.card.mana_cost}</span>
      )}
      <button
        className={styles.removeBtn}
        onClick={(e) => { e.stopPropagation(); onRemove(); }}
      >×</button>
    </div>
  );
}

// ─── Groupement par type ───────────────────────────────────────────────────────
const TYPE_ORDER = ["Creature","Planeswalker","Instant","Sorcery","Enchantment","Artifact","Land","Other"];
const TYPE_LABELS: Record<string, string> = {
  Creature: "Créatures", Planeswalker: "Planeswalkers", Instant: "Instantanés",
  Sorcery: "Rituels", Enchantment: "Enchantements", Artifact: "Artefacts",
  Land: "Terrains", Other: "Autre",
};

function getTypeGroup(typeLine: string | null): string {
  if (!typeLine) return "Other";
  const t = typeLine.toLowerCase();
  if (t.includes("creature"))     return "Creature";
  if (t.includes("planeswalker")) return "Planeswalker";
  if (t.includes("instant"))      return "Instant";
  if (t.includes("sorcery"))      return "Sorcery";
  if (t.includes("enchantment"))  return "Enchantment";
  if (t.includes("artifact"))     return "Artifact";
  if (t.includes("land"))         return "Land";
  return "Other";
}

function groupByType(cards: DeckCard[]): [string, DeckCard[]][] {
  const map = new Map<string, DeckCard[]>();
  for (const dc of cards) {
    const g = getTypeGroup(dc.card.type_line);
    if (!map.has(g)) map.set(g, []);
    map.get(g)!.push(dc);
  }
  for (const [, group] of map) {
    group.sort((a, b) => (a.card.cmc ?? 0) - (b.card.cmc ?? 0) || a.card.name_en.localeCompare(b.card.name_en));
  }
  return TYPE_ORDER.filter((t) => map.has(t)).map((t) => [TYPE_LABELS[t], map.get(t)!]);
}
