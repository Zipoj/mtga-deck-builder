import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext, verticalListSortingStrategy,
  useSortable, arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Deck } from "../types";
import { useT } from "../I18nContext";
import ImportModal from "./ImportModal";
import ConfirmDialog from "./ConfirmDialog";
import styles from "./DeckList.module.css";
import bStyles from "./IntegratedDeckBuilder.module.css";

const SVG = "https://svgs.scryfall.io/card-symbols";
const COLOR_ORDER = ["W", "U", "B", "R", "G", "C"];

interface Props {
  onOpenDeck: (deck: Deck) => void;
  onDeckChange: () => void;
  onToast?: (msg: string, type?: "success" | "error" | "info") => void;
}

export default function DeckList({ onOpenDeck, onDeckChange, onToast }: Props) {
  const t = useT();
  const [decks, setDecks]                   = useState<Deck[]>([]);
  const [creating, setCreating]             = useState(false);
  const [newName, setNewName]               = useState("");
  const [newFormat, setNewFormat]           = useState("standard");
  const [showImport, setShowImport]         = useState(false);
  const [editingId, setEditingId]           = useState<number | null>(null);
  const [editName, setEditName]             = useState("");
  const [filterColors, setFilterColors]     = useState<string[]>([]);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const loadDecks = useCallback(async () => {
    const list = await invoke<Deck[]>("get_decks");
    setDecks(list);
  }, []);

  useEffect(() => { loadDecks(); }, [loadDecks]);

  // ── Derived: split into favorites and others ──────────────────────────────
  const favDecks   = decks.filter((d) => d.is_favorite);
  const otherDecks = decks.filter((d) => !d.is_favorite);

  // ── Color filtering ───────────────────────────────────────────────────────
  const toggleColor = (c: string) =>
    setFilterColors((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]
    );

  const applyColorFilter = (list: Deck[]) => {
    if (filterColors.length === 0) return list;
    return list.filter((d) =>
      filterColors.some((c) => d.color_identities.includes(c))
    );
  };

  const visibleFavs   = applyColorFilter(favDecks);
  const visibleOthers = applyColorFilter(otherDecks);

  // ── Sensors ───────────────────────────────────────────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  // ── Drag-end for a group ──────────────────────────────────────────────────
  const handleDragEnd = async (
    event: DragEndEvent,
    group: Deck[],
    indexOffset: number
  ) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = group.findIndex((d) => d.id === Number(active.id));
    const newIndex = group.findIndex((d) => d.id === Number(over.id));
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(group, oldIndex, newIndex);

    // Rebuild full deck list preserving the other group
    const otherGroup = indexOffset === 0 ? otherDecks : favDecks;
    const merged =
      indexOffset === 0
        ? [...reordered, ...otherGroup]
        : [...otherGroup, ...reordered];
    setDecks(merged);

    // Persist: send the ordered IDs of the full list
    const allOrdered = merged.map((d) => d.id);
    await invoke("reorder_decks", { orderedIds: allOrdered });
  };

  // ── Favorite toggle ───────────────────────────────────────────────────────
  const toggleFavorite = async (deck: Deck) => {
    const newVal = !deck.is_favorite;
    setDecks((prev) =>
      prev.map((d) => (d.id === deck.id ? { ...d, is_favorite: newVal } : d))
    );
    await invoke("set_deck_favorite", { deckId: deck.id, isFavorite: newVal });
    onDeckChange();
  };

  // ── CRUD ──────────────────────────────────────────────────────────────────
  const createDeck = async () => {
    if (!newName.trim()) return;
    await invoke("create_deck", { name: newName.trim(), format: newFormat });
    setNewName("");
    setCreating(false);
    loadDecks();
    onDeckChange();
    onToast?.(t("toast.deckCreated"), "success");
  };

  const confirmDelete = async () => {
    if (confirmDeleteId === null) return;
    const deck = decks.find((d) => d.id === confirmDeleteId);
    await invoke("delete_deck", { deckId: confirmDeleteId });
    setConfirmDeleteId(null);
    loadDecks();
    onDeckChange();
    onToast?.(t("toast.deckDeleted", { name: deck?.name ?? "Deck" }), "info");
  };

  const duplicateDeck = async (deck: Deck) => {
    await invoke("duplicate_deck", { deckId: deck.id });
    loadDecks();
    onDeckChange();
    onToast?.(t("toast.deckDuplicated", { name: deck.name }), "success");
  };

  const startRename = (deck: Deck) => {
    setEditingId(deck.id);
    setEditName(deck.name);
  };

  const confirmRename = async (deck: Deck) => {
    if (!editName.trim() || editName === deck.name) { setEditingId(null); return; }
    await invoke("rename_deck", { deckId: deck.id, name: editName.trim() });
    setEditingId(null);
    loadDecks();
    onToast?.(t("toast.deckRenamed"), "success");
  };

  const exportDeck = async (deck: Deck) => {
    const content = await invoke<string>("export_deck_mtga", { deckId: deck.id });
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${deck.name.replace(/[^a-z0-9]/gi, "_")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    onToast?.(t("toast.deckExported", { name: deck.name }), "success");
  };

  const handleImported = (deck: Deck) => {
    loadDecks();
    onDeckChange();
    onOpenDeck(deck);
    onToast?.(t("toast.deckImported", { name: deck.name }), "success");
  };

  const deleteTarget = decks.find((d) => d.id === confirmDeleteId);

  return (
    <div className={styles.container}>
      {/* ── Header ── */}
      <div className={styles.header}>
        <h1>{t("decklist.title")} <span className={styles.count}>{decks.length}</span></h1>
        <div className={styles.headerActions}>
          <button className="btn-ghost" onClick={() => setShowImport(true)}>{t("decklist.importMtga")}</button>
          <button className="btn-primary" onClick={() => setCreating(true)}>{t("decklist.new")}</button>
        </div>
      </div>

      {/* ── Create form ── */}
      {creating && (
        <div className={styles.createForm}>
          <input
            type="text"
            placeholder={t("decklist.deckNamePlaceholder")}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") createDeck(); if (e.key === "Escape") setCreating(false); }}
            autoFocus
          />
          <select value={newFormat} onChange={(e) => setNewFormat(e.target.value)}>
            {FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
          <button className="btn-primary" onClick={createDeck}>{t("decklist.create")}</button>
          <button className="btn-ghost" onClick={() => setCreating(false)}>{t("decklist.cancel")}</button>
        </div>
      )}

      {/* ── Color filter bar ── */}
      <div className={bStyles.filterBar}>
        <div className={bStyles.filterGroup}>
          {COLOR_ORDER.map((c) => (
            <button
              key={c}
              className={`${bStyles.colorBtn} ${filterColors.includes(c) ? bStyles.filterActive : ""}`}
              title={c}
              onClick={() => toggleColor(c)}
            >
              <img src={`${SVG}/${c}.svg`} alt={c} width={18} height={18} />
            </button>
          ))}
        </div>
        {filterColors.length > 0 && (
          <button className={bStyles.clearBtn} onClick={() => setFilterColors([])}>✕</button>
        )}
      </div>

      {/* ── Grid ── */}
      {decks.length === 0 ? (
        <div className={styles.empty}>
          <p>{t("decklist.empty")}</p>
          <p className="text-muted">{t("decklist.emptyHint")}</p>
        </div>
      ) : (
        <div className={styles.scrollArea}>
          {/* Favorites group */}
          {visibleFavs.length > 0 && (
            <div className={styles.groupSection}>
              <div className={styles.groupLabel}>⭐ {t("decklist.favorites")}</div>
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={(e) => handleDragEnd(e, favDecks, 0)}
              >
                <SortableContext items={favDecks.map((d) => d.id)} strategy={verticalListSortingStrategy}>
                  <div className={styles.grid}>
                    {visibleFavs.map((deck) => (
                      <SortableDeckCard
                        key={deck.id}
                        deck={deck}
                        isEditing={editingId === deck.id}
                        editName={editName}
                        onEditNameChange={setEditName}
                        onOpen={() => onOpenDeck(deck)}
                        onDelete={() => setConfirmDeleteId(deck.id)}
                        onDuplicate={() => duplicateDeck(deck)}
                        onExport={() => exportDeck(deck)}
                        onStartRename={() => startRename(deck)}
                        onConfirmRename={() => confirmRename(deck)}
                        onCancelRename={() => setEditingId(null)}
                        onToggleFavorite={() => toggleFavorite(deck)}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            </div>
          )}

          {/* Others group */}
          {visibleOthers.length > 0 && (
            <div className={styles.groupSection}>
              {visibleFavs.length > 0 && <div className={styles.groupLabel}>{t("decklist.otherDecks")}</div>}
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={(e) => handleDragEnd(e, otherDecks, 1)}
              >
                <SortableContext items={otherDecks.map((d) => d.id)} strategy={verticalListSortingStrategy}>
                  <div className={styles.grid}>
                    {visibleOthers.map((deck) => (
                      <SortableDeckCard
                        key={deck.id}
                        deck={deck}
                        isEditing={editingId === deck.id}
                        editName={editName}
                        onEditNameChange={setEditName}
                        onOpen={() => onOpenDeck(deck)}
                        onDelete={() => setConfirmDeleteId(deck.id)}
                        onDuplicate={() => duplicateDeck(deck)}
                        onExport={() => exportDeck(deck)}
                        onStartRename={() => startRename(deck)}
                        onConfirmRename={() => confirmRename(deck)}
                        onCancelRename={() => setEditingId(null)}
                        onToggleFavorite={() => toggleFavorite(deck)}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            </div>
          )}

          {/* No results after color filter */}
          {visibleFavs.length === 0 && visibleOthers.length === 0 && (
            <div className={styles.empty}>
              <p className="text-muted">{t("decklist.emptyFilter")}</p>
            </div>
          )}
        </div>
      )}

      {showImport && (
        <ImportModal onImported={handleImported} onClose={() => setShowImport(false)} />
      )}

      {confirmDeleteId !== null && (
        <ConfirmDialog
          message={t("decklist.deleteConfirm", { name: deleteTarget?.name ?? "ce deck" })}
          onConfirm={confirmDelete}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}
    </div>
  );
}

// ─── Sortable wrapper ─────────────────────────────────────────────────────────
function SortableDeckCard(props: DeckCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: props.deck.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    cursor: isDragging ? "grabbing" : "grab",
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <DeckCard {...props} />
    </div>
  );
}

// ─── Deck card ────────────────────────────────────────────────────────────────
interface DeckCardProps {
  deck: Deck;
  isEditing: boolean;
  editName: string;
  onEditNameChange: (v: string) => void;
  onOpen: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onStartRename: () => void;
  onConfirmRename: () => void;
  onCancelRename: () => void;
  onToggleFavorite: () => void;
}

function DeckCard({
  deck, isEditing, editName, onEditNameChange,
  onOpen, onDelete, onDuplicate, onExport,
  onStartRename, onConfirmRename, onCancelRename, onToggleFavorite,
}: DeckCardProps) {
  const t = useT();
  return (
    <div
      className={styles.deckCard}
      style={deck.cover_image_url ? { backgroundImage: `url(${deck.cover_image_url})` } : undefined}
    >
      <div className={styles.deckCardOverlay} />

      {/* Favorite star */}
      <button
        className={styles.favBtn}
        title={deck.is_favorite ? t("decklist.removeFromFav") : t("decklist.addToFav")}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onToggleFavorite(); }}
      >
        {deck.is_favorite ? "⭐" : "☆"}
      </button>

      <div className={styles.deckCardTop}>
        {isEditing ? (
          <input
            className={styles.renameInput}
            value={editName}
            onChange={(e) => onEditNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onConfirmRename();
              if (e.key === "Escape") onCancelRename();
            }}
            autoFocus
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <div
            className={styles.deckName}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onOpen}
            onDoubleClick={onStartRename}
            title={t("decklist.doubleClickRename")}
          >
            {deck.name}
            {(deck.format === "brawl" || deck.format === "historic_brawl") && (
              <i className="ms ms-commander" style={{ color: "#d4a017", marginLeft: 6, fontSize: "0.9em", verticalAlign: "middle" }} />
            )}
          </div>
        )}
        <div className={styles.deckMeta}>
          <span className={styles.deckFormat}>{deck.format}</span>
          {(() => {
            const target = (deck.format === "brawl" || deck.format === "historic_brawl") ? 100 : 60;
            return (
              <span
                className={`${styles.incompletBadge} ${deck.card_count >= target ? styles.completeBadge : ""}`}
                title={deck.card_count < target ? t("decklist.cardsMissing", { count: target - deck.card_count }) : t("decklist.deckComplete")}
              >
                {deck.card_count}/{target}
              </span>
            );
          })()}
        </div>

        {deck.color_identities.length > 0 && (
          <div className={styles.colorPips}>
            {deck.color_identities.map((c) => (
              <img key={c} src={`${SVG}/${c}.svg`} alt={c} width={16} height={16} className={styles.colorPip} />
            ))}
          </div>
        )}

        <div className={styles.deckDate}>
          {new Date(deck.updated_at).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" })}
        </div>
      </div>

      <div className={styles.deckActions}>
        {isEditing ? (
          <>
            <button className="btn-primary" onPointerDown={(e) => e.stopPropagation()} onClick={onConfirmRename}>✓</button>
            <button className="btn-ghost"   onPointerDown={(e) => e.stopPropagation()} onClick={onCancelRename}>✗</button>
          </>
        ) : (
          <>
            <button className="btn-primary"  onPointerDown={(e) => e.stopPropagation()} onClick={onOpen}>{t("decklist.open")}</button>
            <button className="btn-ghost"    onPointerDown={(e) => e.stopPropagation()} onClick={onExport}      title={t("decklist.export")}>⬇</button>
            <button className="btn-ghost"    onPointerDown={(e) => e.stopPropagation()} onClick={onDuplicate}   title={t("decklist.duplicate")}>⎘</button>
            <button className="btn-ghost"    onPointerDown={(e) => e.stopPropagation()} onClick={onStartRename} title={t("decklist.rename")}>✎</button>
            <button className={styles.deleteBtn} onPointerDown={(e) => e.stopPropagation()} onClick={onDelete}  title={t("decklist.delete")}>🗑</button>
          </>
        )}
      </div>
    </div>
  );
}

const FORMATS = [
  { value: "standard",       label: "Standard"       },
  { value: "historic",       label: "Historic"       },
  { value: "alchemy",        label: "Alchemy"        },
  { value: "pioneer",        label: "Pioneer"        },
  { value: "explorer",       label: "Explorer"       },
  { value: "brawl",          label: "Brawl"          },
  { value: "historic_brawl", label: "Historic Brawl" },
  { value: "timeless",       label: "Timeless"       },
];
