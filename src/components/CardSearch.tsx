import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Card, CardFilters } from "../types";
import CardDetail from "./CardDetail";
import styles from "./CardSearch.module.css";

interface SetInfo { code: string; count: number; }

interface Props {
  activeDeckId: number | null;
  onDeckUpdate?: () => void;
  onToast?: (msg: string, type?: "success" | "error" | "info") => void;
  displayLang?: string;
}

export default function CardSearch({ activeDeckId, onDeckUpdate, onToast, displayLang = "en" }: Props) {
  const [query, setQuery]         = useState("");
  const [results, setResults]     = useState<Card[]>([]);
  const [selected, setSelected]   = useState<Card | null>(null);
  const [loading, setLoading]     = useState(false);
  const [filters, setFilters]     = useState<CardFilters>({});
  const [sets, setSets]           = useState<SetInfo[]>([]);
  const [filterSet, setFilterSet] = useState("");
  const [sortBy, setSortBy]       = useState<"name" | "cmc" | "rarity">("name");
  const debounceRef               = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Charge la liste des sets au démarrage
  useEffect(() => {
    invoke<SetInfo[]>("get_sets").then(setSets).catch(() => {});
  }, []);

  const search = useCallback(async (q: string, f: CardFilters, set: string) => {
    setLoading(true);
    try {
      const activeFilters = { ...f };
      if (set) activeFilters.set_codes = [set];

      const cards = await invoke<Card[]>("search_cards", {
        query: q,
        limit: 80,
        filters: Object.keys(activeFilters).length ? activeFilters : null,
      });
      setResults(cards);
    } catch (err) {
      console.error("Erreur recherche :", err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Charge les premières cartes automatiquement à l'ouverture
  useEffect(() => {
    search("", {}, "");
  }, [search]);

  const handleInput = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(value, filters, filterSet), 250);
  };

  const handleFilterChange = (key: string, value: string) => {
    if (key === "set_code") {
      setFilterSet(value);
      search(query, filters, value.trim().toLowerCase());
    } else if (key === "color") {
      const nf = { ...filters, colors: value ? [value] : undefined };
      setFilters(nf); search(query, nf, filterSet);
    } else if (key === "rarity") {
      const nf = { ...filters, rarities: value ? [value] : undefined };
      setFilters(nf); search(query, nf, filterSet);
    } else if (key === "card_type") {
      const nf = { ...filters, card_types: value ? [value] : undefined };
      setFilters(nf); search(query, nf, filterSet);
    } else {
      const newFilters = { ...filters, [key]: value || undefined } as CardFilters;
      setFilters(newFilters);
      search(query, newFilters, filterSet);
    }
  };

  const clearFilters = () => {
    setFilters({});
    setFilterSet("");
    setSortBy("name");
    search(query, {}, "");
  };

  const addToDeck = async (card: Card, board: "main" | "sideboard" = "main") => {
    if (!activeDeckId) return;
    try {
      await invoke("add_card_to_deck", {
        deckId: activeDeckId, cardId: card.id, quantity: 1, board,
      });
      onDeckUpdate?.();
      onToast?.(`${card.name_en} ajouté`, "success");
    } catch (err) {
      onToast?.(`Erreur : ${err}`, "error");
    }
  };

  // Tri côté client
  const sortedResults = [...results].sort((a, b) => {
    if (sortBy === "cmc")    return (a.cmc ?? 0) - (b.cmc ?? 0);
    if (sortBy === "rarity") return rarityOrder(a.rarity) - rarityOrder(b.rarity);
    return a.name_en.localeCompare(b.name_en);
  });

  const hasFilters = Object.keys(filters).length > 0 || filterSet;

  return (
    <div className={styles.container}>
      {/* ── Barre de recherche ── */}
      <div className={styles.searchBar}>
        <input
          className={styles.searchInput}
          type="text"
          placeholder="Chercher une carte (EN ou FR)…"
          value={query}
          onChange={(e) => handleInput(e.target.value)}
          autoFocus
        />
      </div>

      {/* ── Filtres ── */}
      <div className={styles.filters}>
        <select onChange={(e) => handleFilterChange("rarity", e.target.value)} value={filters.rarities?.[0] ?? ""}>
          <option value="">Toutes raretés</option>
          <option value="common">Commune</option>
          <option value="uncommon">Peu commune</option>
          <option value="rare">Rare</option>
          <option value="mythic">Mythique</option>
        </select>

        <select onChange={(e) => handleFilterChange("color", e.target.value)} value={filters.colors?.[0] ?? ""}>
          <option value="">Toutes couleurs</option>
          <option value="W">☀ Blanc</option>
          <option value="U">💧 Bleu</option>
          <option value="B">💀 Noir</option>
          <option value="R">🔥 Rouge</option>
          <option value="G">🌲 Vert</option>
          <option value="C">◇ Incolore</option>
        </select>

        <select onChange={(e) => handleFilterChange("card_type", e.target.value)} value={filters.card_types?.[0] ?? ""}>
          <option value="">Tous types</option>
          <option value="Creature">Créatures</option>
          <option value="Instant">Instantanés</option>
          <option value="Sorcery">Rituels</option>
          <option value="Enchantment">Enchantements</option>
          <option value="Artifact">Artefacts</option>
          <option value="Planeswalker">Planeswalkers</option>
          <option value="Land">Terrains</option>
        </select>

        <select
          onChange={(e) => handleFilterChange("set_code", e.target.value)}
          value={filterSet}
          className={styles.setSelect}
        >
          <option value="">Tous sets</option>
          {sets.map((s) => (
            <option key={s.code} value={s.code}>
              {s.code.toUpperCase()} ({s.count})
            </option>
          ))}
        </select>

        <select onChange={(e) => setSortBy(e.target.value as typeof sortBy)} value={sortBy}>
          <option value="name">Trier : Nom</option>
          <option value="cmc">Trier : CMC</option>
          <option value="rarity">Trier : Rareté</option>
        </select>

        {hasFilters && (
          <button className={styles.clearFilters} onClick={clearFilters} title="Effacer les filtres">
            ✕ Filtres
          </button>
        )}
      </div>

      {/* ── Résultats + détail ── */}
      <div className={styles.body}>
        <div className={styles.grid}>
          {loading && <p className={styles.status}>Recherche…</p>}
          {!loading && results.length === 0 && query && (
            <p className={styles.status}>Aucun résultat pour « {query} »</p>
          )}
          {!loading && results.length === 0 && !query && (
            <p className={styles.status}>
              Tape un nom de carte en FR ou EN.<br />
              <span className="text-muted" style={{ fontSize: 12 }}>
                {results.length === 0 && "Utilise les filtres pour parcourir toute la collection."}
              </span>
            </p>
          )}
          {sortedResults.map((card) => (
            <CardTile
              key={card.id}
              card={card}
              selected={selected?.id === card.id}
              onClick={() => setSelected(card)}
              onAdd={activeDeckId ? () => addToDeck(card) : undefined}
              displayLang={displayLang}
            />
          ))}
          {!loading && results.length > 0 && (
            <p className={styles.resultCount}>{results.length} résultats</p>
          )}
        </div>

        {selected && (
          <div className={styles.detailPanel}>
            <CardDetail
              card={selected}
              onAddMain={activeDeckId ? () => addToDeck(selected, "main") : undefined}
              onAddSide={activeDeckId ? () => addToDeck(selected, "sideboard") : undefined}
              onClose={() => setSelected(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Tuile carte ───────────────────────────────────────────────────────────────
interface TileProps {
  card: Card; selected: boolean;
  onClick: () => void; onAdd?: () => void;
  displayLang?: string;
}

function CardTile({ card, selected, onClick, onAdd, displayLang = "en" }: TileProps) {
  const [hovered, setHovered] = useState(false);

  const isFr = displayLang === "fr";
  // Tile image : préfère la version FR si disponible et si la langue est FR
  const imgSrc = isFr
    ? (card.image_uri_fr ?? card.image_uri_small ?? card.image_uri_normal)
    : (card.image_uri_small ?? card.image_uri_normal);
  // Hover preview : même logique, taille normale
  const hoverSrc = isFr
    ? (card.image_uri_fr ?? card.image_uri_normal)
    : card.image_uri_normal;
  // Nom affiché : FR en premier si disponible
  const displayName  = isFr ? (card.name_fr ?? card.name_en) : card.name_en;
  const secondName   = isFr
    ? (card.name_fr ? card.name_en : null)          // sous-titre = EN quand FR actif
    : (card.name_fr && card.name_fr !== card.name_en ? card.name_fr : null); // sous-titre = FR quand EN actif

  return (
    <div
      className={`${styles.tile} ${selected ? styles.tileSelected : ""}`}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {imgSrc ? (
        <img className={styles.tileImg} src={imgSrc} alt={displayName} loading="lazy" />
      ) : (
        <div className={styles.tileNoImg}>{displayName}</div>
      )}

      <div className={styles.tileMeta}>
        <span className={`rarity-${card.rarity}`} style={{ fontSize: 11 }}>{displayName}</span>
        {secondName && (
          <span className="text-muted" style={{ fontSize: 10 }}>{secondName}</span>
        )}
      </div>

      {onAdd && (
        <button
          className={styles.tileAdd}
          onClick={(e) => { e.stopPropagation(); onAdd(); }}
          title="Ajouter au deck"
        >+</button>
      )}

      {/* Hover preview : image en grande taille */}
      {hovered && hoverSrc && (
        <div className={styles.hoverPreview}>
          <img src={hoverSrc} alt={displayName} />
        </div>
      )}
    </div>
  );
}

// ─── Utilitaires ──────────────────────────────────────────────────────────────
function rarityOrder(r: string | null) {
  return { common: 0, uncommon: 1, rare: 2, mythic: 3 }[r ?? ""] ?? 0;
}
