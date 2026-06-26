import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import {
  DndContext, DragEndEvent, DragStartEvent, DragOverlay,
  useDraggable, useDroppable,
  PointerSensor, useSensor, useSensors,
} from "@dnd-kit/core";
import type { Card, CardFilters, DeckCard, DeckWithCards } from "../types";
import CardDetail from "./CardDetail";
import DeckStats from "./DeckStats";
import ManaCost from "./ManaCost";
import { useT } from "../I18nContext";
import styles from "./IntegratedDeckBuilder.module.css";

const SVG = "https://svgs.scryfall.io/card-symbols";

// Normalise le nom d'une carte DFC : "A // B" → "A"
const frontFace = (name: string) => {
  const idx = name.indexOf(" // ");
  return idx >= 0 ? name.slice(0, idx) : name;
};

// ─── Static filter config ─────────────────────────────────────────────────────

interface SetInfo { code: string; count: number; }

interface ScryfallSet {
  code: string;
  set_type: string;
  released_at: string;
  arena_code?: string;
}

// Returns the set codes legal in a given format, or null (= no restriction)
function getFormatSetCodes(format: string, scryfallSets: ScryfallSet[]): string[] | null {
  const paperTypes = ["expansion", "core", "starter", "draft_innovation"];
  switch (format) {
    case "standard":
    case "brawl": {
      // Brawl utilise le même pool de sets que Standard
      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - 2);
      return scryfallSets
        .filter(s => paperTypes.includes(s.set_type) && new Date(s.released_at) >= cutoff)
        .map(s => s.code);
    }
    case "pioneer":
    case "explorer":
      return scryfallSets
        .filter(s => paperTypes.includes(s.set_type) && new Date(s.released_at) >= new Date("2012-10-05"))
        .map(s => s.code);
    case "alchemy":
      // Alchemy : sets Arena (Standard + sets numériques)
      return scryfallSets.filter(s => !!s.arena_code).map(s => s.code);
    case "historic":
    case "historic_brawl":
    case "timeless":
      // Formats « tout Arena » : aucune restriction de set.
      // La requête SQL filtre déjà sur arena_id IS NOT NULL, et restreindre
      // par arena_code écartait à tort ~8000 cartes Arena valides.
      return null;
    default:
      return null;
  }
}

// Formats disponibles sur MTG Arena uniquement
const FORMATS = [
  { value: "standard",      label: "Standard"       },
  { value: "historic",      label: "Historic"       },
  { value: "alchemy",       label: "Alchemy"        },
  { value: "pioneer",       label: "Pioneer"        },
  { value: "explorer",      label: "Explorer"       },
  { value: "brawl",         label: "Brawl"          },
  { value: "historic_brawl",label: "Historic Brawl" },
  { value: "timeless",      label: "Timeless"       },
];

// Formats de type Brawl : deck 100 cartes avec commandant
const BRAWL_FORMATS = new Set(["brawl", "historic_brawl"]);

const COLOR_BTNS = [
  { code: "W", title: "Blanc" },
  { code: "U", title: "Bleu" },
  { code: "B", title: "Noir" },
  { code: "R", title: "Rouge" },
  { code: "G", title: "Vert" },
  { code: "C", title: "Incolore" },
];

// ─── Inline SVG icons for card types ─────────────────────────────────────────


// Alchemy exclusion icon — "A" with diagonal strikethrough
const IcoNoAlchemy = () => (
  <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
    <text x="2" y="12" fontSize="11" fontWeight="700" fontFamily="monospace" fill="currentColor">A</text>
    <line x1="1" y1="2" x2="14" y2="13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
  </svg>
);

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


// ─── Commander Spellbook types ────────────────────────────────────────────────

interface CSComboUse  { card: { name: string }; quantity: number; }
interface CSComboProd { feature: { name: string }; }
interface CSComboRaw  { id: string; description: string; uses: CSComboUse[]; produces: CSComboProd[]; }

interface ComboEntry {
  id:               string;
  description:      string;
  produces:         string[];
  allCards:         string[];   // tous les noms requis
  inDeck:           string[];   // cartes déjà présentes dans le deck
  missingFromDeck:  string[];   // cartes sur Arena mais absentes du deck
  notOnArena:       string[];   // cartes non disponibles sur Arena
  isAlmost:         boolean;
  cardObjects:      Card[];     // objets Card (pour hover preview + add)
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  deckData: DeckWithCards;
  onChange: (updated: DeckWithCards) => void;
  onToast?: (msg: string, type?: "success" | "error" | "info" | "undo", onUndo?: () => void) => void;
  displayLang: string;
  langCode?: string;
  imageLangCode?: string;
  favoriteIds?: Set<string>;
  onContextMenu?: (card: Card, x: number, y: number) => void;
}

// ─── Session cache (in-memory, survives deck switches, cleared on app restart) ─

type FilterState = { query: string; filters: CardFilters; filterSets: string[] };
const _sessionCache = new Map<number, FilterState>();

// ─── Main component ───────────────────────────────────────────────────────────

export default function IntegratedDeckBuilder({ deckData, onChange, onToast, displayLang, langCode = "en", imageLangCode = "en", favoriteIds: _favoriteIds, onContextMenu }: Props) {
  const t = useT();
  const _deckId = deckData.deck.id;

  // ── Browser state ──────────────────────────────────────────────────────────
  // Always check session cache first (in-memory, works within the app session).
  // Then check localStorage only when the "persist_filters" setting is ON.
  const _initState = (() => {
    const cached = _sessionCache.get(_deckId);
    if (cached) return cached;
    if (localStorage.getItem("settings_persist_filters") === "true") {
      try { return JSON.parse(localStorage.getItem(`deck_state_${_deckId}`) ?? "null") as FilterState | null ?? undefined; }
      catch { return undefined; }
    }
    return undefined;
  })();

  const [query, setQuery]         = useState<string>(_initState?.query ?? "");
  const [results, setResults]     = useState<Card[]>([]);
  const [loading, setLoading]     = useState(false);
  const [filters, setFilters]     = useState<CardFilters>(_initState?.filters ?? { sort_by: "cmc" });
  const [sets, setSets]           = useState<SetInfo[]>([]);
  const [setNames, setSetNames]   = useState<Record<string, string>>({});
  const [setIcons, setSetIcons]   = useState<Record<string, string>>({});
  const [setDates, setSetDates]   = useState<Record<string, string>>({});
  const [setPickerOpen, setSetPickerOpen] = useState(false);
  const [filterSets, setFilterSets] = useState<string[]>(_initState?.filterSets ?? []);
  const setPickerRef              = useRef<HTMLDivElement>(null);
  const gridRef                   = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(600);
  const [zoom, setZoom]           = useState<number>(() =>
    Number(localStorage.getItem("card_zoom") ?? "120")
  );
  const [excludeAlchemy, setExcludeAlchemy] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Format restriction ──────────────────────────────────────────────────────
  const [scryfallSets, setScryfallSets] = useState<ScryfallSet[]>([]);
  const [overrideFormat, setOverrideFormat] = useState(false);
  // Refs so search() (useCallback []) can always read latest values
  const scryfallSetsRef  = useRef<ScryfallSet[]>([]);
  const overrideFormatRef = useRef(false);
  const deckFormatRef    = useRef(deckData.deck.format);
  // Keep refs in sync with state/props
  scryfallSetsRef.current  = scryfallSets;
  overrideFormatRef.current = overrideFormat;
  deckFormatRef.current    = deckData.deck.format;

  // ── Brawl refs (accessibles dans search() et addCardToBoard sans stale closure) ─
  const brawlModeRef             = useRef(false);
  const brawlHasCommanderRef     = useRef(false);
  const brawlCommanderColorsRef  = useRef<string[]>([]);
  const deckCardsRef             = useRef<import("../types").DeckCard[]>([]);

  // Persist filter state: always in session cache; localStorage only when setting is ON
  useEffect(() => {
    const state: FilterState = { query, filters, filterSets };
    _sessionCache.set(_deckId, state);
    if (localStorage.getItem("settings_persist_filters") === "true") {
      localStorage.setItem(`deck_state_${_deckId}`, JSON.stringify(state));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, filters, filterSets]);

  // ── Left panel ────────────────────────────────────────────────────────────
  const [detailCard, setDetailCard] = useState<Card | null>(null);

  // ── Deck column ───────────────────────────────────────────────────────────
  const [deckTab, setDeckTab]       = useState<"main" | "side" | "combos">("main");
  const [deckGroupMode, setDeckGroupMode] = useState<"type" | "cmc">("cmc");
  const [showStats, setShowStats]   = useState(false);

  // ── Combos (Commander Spellbook) ───────────────────────────────────────────
  const [comboEntries, setComboEntries]   = useState<ComboEntry[]>([]);
  const [comboLoading, setComboLoading]   = useState(false);
  const [comboError, setComboError]       = useState<string | null>(null);
  const [comboFetched, setComboFetched]   = useState(false);
  const [comboFilter, setComboFilter]     = useState<"all" | "complete" | "almost">("all");

  // ── Hover preview ─────────────────────────────────────────────────────────
  const [hoverCard, setHoverCard] = useState<Card | null>(null);
  const [hoverPos, setHoverPos]   = useState({ x: 0, y: 0 });

  // ── DnD ───────────────────────────────────────────────────────────────────
  const [draggingCard, setDraggingCard] = useState<Card | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  // ── Init ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    invoke<SetInfo[]>("get_sets").then(setSets).catch(() => {});
    // Restore previous search state or start fresh
    search(query, filters, filterSets);

    // Noms + icônes des sets depuis l'API Scryfall.
    // Cache localStorage : affichage instantané, puis rafraîchissement réseau en arrière-plan.
    const applySets = (names: Record<string, string>, icons: Record<string, string>,
                       dates: Record<string, string>, sfSets: ScryfallSet[]) => {
      setSetNames(names);
      setSetIcons(icons);
      setSetDates(dates);
      setScryfallSets(sfSets);
      const arenaCodes = sfSets.filter(s => !!s.arena_code).map(s => s.code);
      localStorage.setItem("scryfall_arena_set_codes", JSON.stringify(arenaCodes));
    };

    const cached = localStorage.getItem("scryfall_sets_cache");
    if (cached) {
      try {
        const c = JSON.parse(cached);
        applySets(c.names ?? {}, c.icons ?? {}, c.dates ?? {}, c.sfSets ?? []);
      } catch { /* cache corrompu : ignoré, le fetch le régénère */ }
    }

    fetch("https://api.scryfall.com/sets")
      .then((r) => r.json())
      .then((data) => {
        const names: Record<string, string> = {};
        const icons: Record<string, string> = {};
        const dates: Record<string, string> = {};
        const sfSets: ScryfallSet[] = [];
        for (const s of data.data ?? []) {
          names[s.code] = s.name;
          if (s.icon_svg_uri) icons[s.code] = s.icon_svg_uri;
          if (s.released_at) dates[s.code] = s.released_at;
          sfSets.push({ code: s.code, set_type: s.set_type ?? "", released_at: s.released_at ?? "", arena_code: s.arena_code });
        }
        applySets(names, icons, dates, sfSets);
        localStorage.setItem("scryfall_sets_cache", JSON.stringify({ names, icons, dates, sfSets }));
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close set picker on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (setPickerRef.current && !setPickerRef.current.contains(e.target as Node))
        setSetPickerOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);


  // Track grid container width for virtual column count
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    setContainerWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setContainerWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Search ────────────────────────────────────────────────────────────────
  const search = useCallback(async (q: string, f: CardFilters, sets: string[]) => {
    setLoading(true);
    try {
      const af: CardFilters = { ...f };
      // Apply format restriction unless overridden
      const formatCodes = overrideFormatRef.current
        ? null
        : getFormatSetCodes(deckFormatRef.current, scryfallSetsRef.current);
      // Si l'utilisateur a sélectionné des sets manuellement, on les utilise directement
      // (pas d'intersection avec le format — évite de renvoyer 0 résultats → retour de tout)
      const effectiveSets: string[] | undefined = sets.length > 0
        ? sets
        : (formatCodes ?? undefined);
      if (effectiveSets && effectiveSets.length > 0) af.set_codes = effectiveSets;
      // Brawl : filtres automatiques selon état du commandant
      if (brawlModeRef.current) {
        if (brawlHasCommanderRef.current) {
          // Commandant sélectionné → restreindre aux couleurs de son identité
          af.commander_colors = brawlCommanderColorsRef.current;
        } else {
          // Pas encore de commandant → afficher uniquement les légendaires
          af.legendary_only = true;
        }
      }
      const res = await invoke<Card[]>("search_cards", {
        query: q,
        limit: 99999,
        filters: af,
        langCode,
        imageLangCode,
      });
      // Dédoublonnage par oracle_id fait côté SQL (GROUP BY) — payload déjà unique
      setResults(res);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  }, []);

  const handleInput = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(value, filters, filterSets), 250);
  };

  // ── Filter toggles ────────────────────────────────────────────────────────

  const toggleColor = (code: string) => {
    const cur = filters.colors ?? [];
    const next = cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code];
    const nf = { ...filters, colors: next.length ? next : undefined };
    setFilters(nf);
    search(query, nf, filterSets);
  };

  const toggleMulticolor = () => {
    const nf = { ...filters, multicolor: filters.multicolor ? undefined : true };
    setFilters(nf);
    search(query, nf, filterSets);
  };

  const toggleRarity = (code: string) => {
    const cur = filters.rarities ?? [];
    const next = cur.includes(code) ? cur.filter((r) => r !== code) : [...cur, code];
    const nf = { ...filters, rarities: next.length ? next : undefined };
    setFilters(nf);
    search(query, nf, filterSets);
  };

  const toggleType = (code: string) => {
    const cur = filters.card_types ?? [];
    const next = cur.includes(code) ? cur.filter(t => t !== code) : [...cur, code];
    const nf = { ...filters, card_types: next.length ? next : undefined };
    setFilters(nf);
    search(query, nf, filterSets);
  };

  const toggleCmc = (val: typeof CMC_BTNS[number]) => {
    const num = val === "7+" ? 7 : (val as number);
    const cur = filters.cmc_values ?? [];
    const next = cur.includes(num) ? cur.filter((v) => v !== num) : [...cur, num];
    const nf = { ...filters, cmc_values: next.length ? next : undefined };
    setFilters(nf);
    search(query, nf, filterSets);
  };

  const setSort = (s: "name" | "cmc" | "rarity") => {
    const nf = { ...filters, sort_by: s };
    setFilters(nf);
    search(query, nf, filterSets);
  };

  const toggleOwnedOnly = () => {
    const nf = { ...filters, owned_only: filters.owned_only ? undefined : true };
    setFilters(nf);
    search(query, nf, filterSets);
  };

  const clearFilters = () => {
    const nf: CardFilters = { sort_by: "cmc" };
    setFilters(nf); setFilterSets([]);
    search(query, nf, []);
  };

  const handleFormatChange = async (newFormat: string) => {
    try {
      const updatedDeck = await invoke<import("../types").Deck>("rename_deck", {
        deckId: deck.id, name: deck.name, description: null, format: newFormat,
      });
      onChange({ ...deckData, deck: updatedDeck });
      // Reset format override so the new format restriction kicks in
      setOverrideFormat(false);
      overrideFormatRef.current = false;
      // Re-run search with new format
      search(query, filters, filterSets);
      onToast?.(t("deck.formatChanged", { format: newFormat }), "success");
    } catch (err) { onToast?.(t("toast.error", { msg: String(err) }), "error"); }
  };

  // ── Deck operations ───────────────────────────────────────────────────────
  const refresh = async () => {
    const updated = await invoke<DeckWithCards>("get_deck_with_cards", { deckId: deck.id, langCode, imageLangCode });
    onChange(updated);
  };

  const addCardToBoard = async (card: Card, board: "main" | "sideboard" | "commander" = "main") => {
    try {
      let targetBoard = board;
      const cardName = displayLang === "fr" ? (card.name_fr ?? card.name_en) : card.name_en;

      if (brawlModeRef.current) {
        // Singleton : une seule copie par carte en Brawl (sauf terrains de base)
        const isBasicLand = card.type_line?.includes("Basic Land") ?? false;
        if (!isBasicLand && deckCardsRef.current.some((dc) => dc.card.name_en === card.name_en)) {
          onToast?.(t("deck.cardAlreadyIn", { name: cardName }), "error");
          return;
        }
        // Pas encore de commandant → la carte glissée devient le commandant
        if (!brawlHasCommanderRef.current) {
          targetBoard = "commander";
        }
      }

      await invoke("add_card_to_deck", { deckId: deck.id, cardId: card.id, quantity: 1, board: targetBoard });
      refresh();
      onToast?.(t("deck.cardAdded", { name: cardName }), "success");
    } catch (err) { onToast?.(t("toast.error", { msg: String(err) }), "error"); }
  };

  const updateQty = async (dc: DeckCard, delta: number) => {
    const isBasicLand = dc.card.type_line?.includes("Basic Land") ?? false;
    if (delta > 0 && brawlModeRef.current && !isBasicLand) {
      const cardName = displayLang === "fr" ? (dc.card.name_fr ?? dc.card.name_en) : dc.card.name_en;
      onToast?.(t("deck.brawlSingleton", { name: cardName }), "error");
      return;
    }
    await invoke("update_card_quantity", {
      deckId: deck.id, cardId: dc.card.id, board: dc.board,
      quantity: dc.quantity + delta,
    });
    refresh();
  };

  const removeCard = async (dc: DeckCard) => {
    await invoke("remove_card_from_deck", { deckId: deck.id, cardId: dc.card.id, board: dc.board });
    refresh();
    if (detailCard?.id === dc.card.id) setDetailCard(null);
    const name = displayLang === "fr" ? (dc.card.name_fr ?? dc.card.name_en) : dc.card.name_en;
    // Undo : re-adds the card with its original quantity and board
    const undoFn = async () => {
      await invoke("add_card_to_deck", {
        deckId: deck.id, cardId: dc.card.id, quantity: dc.quantity, board: dc.board,
      });
      refresh();
    };
    onToast?.(t("deck.cardRemoved", { name }), "undo", undoFn);
  };

  const exportToMtga = async () => {
    const content = await invoke<string>("export_deck_mtga", { deckId: deck.id });
    await navigator.clipboard.writeText(content);
    onToast?.(t("deck.copiedClipboard"), "success");
  };

  // ── Artwork de couverture ─────────────────────────────────────────────────
  const setCoverImage = async (card: Card) => {
    const artUrl = card.image_uri_art_crop ?? card.image_uri_normal;
    if (!artUrl) return;
    try {
      await invoke("set_deck_cover", { deckId: deck.id, coverImageUrl: artUrl });
      refresh();
      const name = displayLang === "fr" ? (card.name_fr ?? card.name_en) : card.name_en;
      onToast?.(t("deck.artworkSet", { name }), "success");
    } catch (err) { onToast?.(t("toast.error", { msg: String(err) }), "error"); }
  };

  const clearCoverImage = async () => {
    try {
      await invoke("set_deck_cover", { deckId: deck.id, coverImageUrl: null });
      refresh();
      onToast?.(t("deck.artworkCleared"), "info");
    } catch (err) { onToast?.(t("toast.error", { msg: String(err) }), "error"); }
  };

  // ── Fetch combos from Commander Spellbook ─────────────────────────────────
  const fetchCombos = async () => {
    setComboLoading(true);
    setComboError(null);
    try {
      // Cartes non-terrain du deck principal (noms uniques)
      const nonLandNames = [...new Set(
        main
          .filter((dc) => !dc.card.type_line?.toLowerCase().includes("land"))
          .map((dc) => dc.card.name_en)
      )];
      if (nonLandNames.length === 0) {
        setComboEntries([]);
        setComboFetched(true);
        return;
      }

      // Requête CS : tous les combos impliquant AU MOINS UNE carte du deck
      // (pas find-my-combos qui exige d'avoir déjà toutes les cartes)
      const queryNames = nonLandNames.slice(0, 40); // évite les URLs trop longues
      const q = queryNames.map((n) => `card:"${n}"`).join(" OR ");
      const url =
        `https://backend.commanderspellbook.com/api/v2/variants/` +
        `?q=${encodeURIComponent(q)}&limit=200`;

      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      const rawCombos: CSComboRaw[] = data.results ?? [];
      if (rawCombos.length === 0) {
        setComboEntries([]);
        setComboFetched(true);
        return;
      }

      // Collecte tous les noms canoniques à vérifier dans la DB
      const nameSet = new Set<string>();
      for (const combo of rawCombos) {
        for (const use of combo.uses ?? []) {
          if (use.card?.name) nameSet.add(frontFace(use.card.name));
        }
      }

      const arenaCards = await invoke<Card[]>("get_cards_by_names", {
        names: Array.from(nameSet),
        langCode,
        imageLangCode,
      });
      const arenaSet = new Set(arenaCards.map((c) => c.name_en));
      const deckSet  = new Set(nonLandNames);

      const isOnArena = (csName: string) => arenaSet.has(frontFace(csName));
      const isInDeck  = (csName: string) =>
        deckSet.has(csName) || deckSet.has(frontFace(csName));

      const entries: ComboEntry[] = rawCombos
        .map((combo) => {
          const allCards = (combo.uses ?? [])
            .map((u) => u.card?.name)
            .filter(Boolean) as string[];
          const notOnArena     = allCards.filter((n) => !isOnArena(n));
          const inDeck         = allCards.filter((n) => isInDeck(n));
          const missingFromDeck = allCards.filter((n) => isOnArena(n) && !isInDeck(n));
          const produces       = (combo.produces ?? [])
            .map((p) => p.feature?.name ?? "")
            .filter(Boolean);
          const isAlmost = inDeck.length < allCards.length;
          const cardObjects = allCards
            .map((n) => arenaCards.find(
              (c) => c.name_en === frontFace(n) || c.name_en === n
            ))
            .filter((c): c is Card => c != null);
          return {
            id: combo.id,
            description: combo.description ?? "",
            produces,
            allCards,
            inDeck,
            missingFromDeck,
            notOnArena,
            isAlmost,
            cardObjects,
          };
        })
        // Filtre : toutes les cartes du combo doivent être disponibles sur Arena
        .filter((c) => c.notOnArena.length === 0)
        // Tri : combos complets d'abord, puis par nombre de cartes déjà dans le deck
        .sort((a, b) => {
          if (!a.isAlmost && b.isAlmost) return -1;
          if (a.isAlmost && !b.isAlmost) return 1;
          return b.inDeck.length - a.inDeck.length;
        });

      setComboEntries(entries);
      setComboFetched(true);
    } catch (err) {
      setComboError(t("deck.combosLoadError", { msg: String(err) }));
    } finally {
      setComboLoading(false);
    }
  };

  // ── DnD : zones de dépôt ─────────────────────────────────────────────────
  // Zone artwork dans le header
  const { setNodeRef: setArtworkDropRef, isOver: isArtworkOver } =
    useDroppable({ id: "deck-artwork" });
  // Toute la liste du deck (seul droppable pour les cartes)
  const { setNodeRef: setDeckDropRef, isOver: isDeckDropOver } =
    useDroppable({ id: "deck-drop" });

  // Refs DOM pour les zones de drop (vérification manuelle des rects au drop)
  const deckPanelDomRef  = useRef<HTMLDivElement | null>(null);
  const artworkZoneDomRef = useRef<HTMLDivElement | null>(null);
  const dragCardRef = useRef<Card | null>(null);
  const dropListenerRef = useRef<((e: PointerEvent) => void) | null>(null);

  // ── DnD handlers ─────────────────────────────────────────────────────────
  const handleDragStart = (event: DragStartEvent) => {
    const card = (event.active.data.current?.card as Card) ?? null;
    dragCardRef.current = card;
    setDraggingCard(card);
    setHoverCard(null);
    if (!card) return;

    // Listener capture sur document : détecte le drop AVANT tout le reste
    const onUp = (e: PointerEvent) => {
      document.removeEventListener("pointerup", onUp, true);
      dropListenerRef.current = null;
      const c = dragCardRef.current;
      if (!c) return;
      const { clientX: x, clientY: y } = e;
      const inRect = (el: HTMLElement | null) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      };
      if (inRect(artworkZoneDomRef.current)) {
        setCoverImage(c);
      } else if (inRect(deckPanelDomRef.current)) {
        addCardToBoard(c, deckTab === "side" ? "sideboard" : "main");
      }
    };
    dropListenerRef.current = onUp;
    document.addEventListener("pointerup", onUp, true);
  };

  const handleDragEnd = (_event: DragEndEvent) => {
    if (dropListenerRef.current) {
      document.removeEventListener("pointerup", dropListenerRef.current, true);
      dropListenerRef.current = null;
    }
    dragCardRef.current = null;
    setDraggingCard(null);
  };

  // ── Hover handlers ────────────────────────────────────────────────────────
  const handleHover = useCallback((card: Card, x: number, y: number) => {
    setHoverCard(card); setHoverPos({ x, y });
  }, []);
  const handleHoverEnd = useCallback(() => setHoverCard(null), []);

  // ── Computed ─────────────────────────────────────────────────────────────
  const { deck, cards } = deckData;
  const main      = cards.filter((c) => c.board === "main");
  const side      = cards.filter((c) => c.board === "sideboard");
  const commander = cards.filter((c) => c.board === "commander");
  const totalMain = main.reduce((s, c) => s + c.quantity, 0);
  const totalSide = side.reduce((s, c) => s + c.quantity, 0);

  // Brawl : mise à jour des refs en top de render
  const isBrawlFormat = BRAWL_FORMATS.has(deck.format);
  const deckSizeTarget = isBrawlFormat ? 100 : 60;
  const brawlCommanderCard = isBrawlFormat && commander.length > 0 ? commander[0].card : null;
  brawlModeRef.current            = isBrawlFormat;
  brawlHasCommanderRef.current    = isBrawlFormat && commander.length > 0;
  brawlCommanderColorsRef.current = brawlCommanderCard?.color_identity ?? [];
  deckCardsRef.current            = cards;

  // Re-lancer la recherche quand l'état du commandant change en Brawl
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!isBrawlFormat) return;
    search(query, filters, filterSets);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brawlCommanderCard?.id, isBrawlFormat]);

  const hasFilters = (filters.colors?.length ?? 0) > 0 || filters.multicolor ||
    (filters.rarities?.length ?? 0) > 0 || (filters.card_types?.length ?? 0) > 0 ||
    (filters.cmc_values?.length ?? 0) > 0 || filterSets.length > 0;

  // Filtre alchemy côté client (noms commençant par "A-")
  const filteredResults = useMemo(
    () => excludeAlchemy ? results.filter((c) => !c.name_en.startsWith("A-")) : results,
    [results, excludeAlchemy]
  );

  const filteredCombos = useMemo(() =>
    comboEntries.filter((e) =>
      comboFilter === "all"      ? true :
      comboFilter === "complete" ? !e.isAlmost :
      e.isAlmost
    ),
  [comboEntries, comboFilter]);

  const handleZoom = (val: number) => {
    setZoom(val); localStorage.setItem("card_zoom", String(val));
  };

  // Sets triés par date de sortie Arena (plus récent en premier), filtrés sur les sets Arena uniquement
  const sortedSets = useMemo(() => {
    // La liste vient déjà de `get_sets`, qui ne renvoie que les sets présents sur
    // Arena (cartes avec arena_id, ≥10). On ne re-filtre PAS par le champ Scryfall
    // `arena_code` : beaucoup de sets pourtant jouables sur Arena (Final Fantasy,
    // les commandants, les sets Alchemy…) n'en ont pas, et étaient donc masqués à
    // tort de la liste déroulante.
    return [...sets]
      .sort((a, b) => (setDates[b.code] ?? "").localeCompare(setDates[a.code] ?? ""));
  }, [sets, setDates]);

  // ── Virtual grid ──────────────────────────────────────────────────────────
  // Columns = how many tiles fit side-by-side given container width + zoom
  const COLS   = Math.max(1, Math.floor((containerWidth - 12) / (zoom + 8)));
  // Largeur réelle d'une carte : les colonnes (1fr) s'étirent pour remplir la grille,
  // donc colW ≥ zoom. On base la hauteur de ligne dessus pour éviter l'overlap des noms.
  // containerWidth inclut le padding .grid (10px ×2) ; gap inter-colonnes = 8px.
  const colW   = Math.max(1, (containerWidth - 20 - (COLS - 1) * 8) / COLS);
  // Hauteur de ligne : image (colW * 88/63) + bande nom (~28px) + gap (8px)
  const ROW_H  = Math.ceil(colW * (88 / 63)) + 36;
  const vRows  = useMemo(() => {
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

  // DragOverlay image
  const dragImg = draggingCard
    ? (displayLang === "fr"
        ? (draggingCard.image_uri_fr ?? draggingCard.image_uri_normal ?? draggingCard.image_uri_small)
        : (draggingCard.image_uri_normal ?? draggingCard.image_uri_small))
    : null;

  // Hover preview position (300px wide, flip si trop à droite)
  const PW = 300;
  const previewLeft = hoverPos.x + 20 + PW > window.innerWidth
    ? hoverPos.x - PW - 8 : hoverPos.x + 20;
  const previewTop = Math.max(8, Math.min(hoverPos.y - 30, window.innerHeight - 430));

  const hoverImg = hoverCard
    ? (displayLang === "fr"
        ? (hoverCard.image_uri_fr ?? hoverCard.image_uri_normal ?? hoverCard.image_uri_small)
        : (hoverCard.image_uri_normal ?? hoverCard.image_uri_small))
    : null;

  const selColors   = filters.colors ?? [];
  const selRarities = filters.rarities ?? [];

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => { dragCardRef.current = null; setDraggingCard(null); }}
      autoScroll={false}
    >
      <div className={styles.container}>

        {/* ── Header ── */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <h1 className={styles.deckName}>{deck.name}</h1>
            <select
              className={styles.formatSelect}
              value={deck.format}
              onChange={(e) => handleFormatChange(e.target.value)}
              title={t("deck.formatTitle")}
            >
              {FORMATS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
            <span className={styles.count}>
              {t("view.cardCount", { count: totalMain })}{totalSide > 0 ? t("deck.sideSuffix", { count: totalSide }) : ""}
            </span>
          </div>
          <div className={styles.headerActions}>
            <button className={`btn-ghost ${showStats ? styles.activeBtn : ""}`}
              onClick={() => setShowStats((v) => !v)}>{t("deck.stats")}</button>
            <button className="btn-ghost" onClick={exportToMtga}>{t("deck.exportMtga")}</button>
            {/* Artwork drop zone — dans le header, hors de la colonne deck */}
            <div
              ref={(el) => { setArtworkDropRef(el); artworkZoneDomRef.current = el; }}
              className={`${styles.artworkZone} ${draggingCard ? styles.artworkZoneDragging : ""} ${isArtworkOver ? styles.artworkZoneOver : ""}`}
              title={t("deck.artworkZone")}
            >
              {deck.cover_image_url
                ? <img src={deck.cover_image_url} alt="" className={styles.artworkZoneThumb} />
                : <span className={styles.artworkZoneIcon}>🖼</span>}
              {isArtworkOver && <span className={styles.artworkZoneLabel}>✓</span>}
              {deck.cover_image_url && (
                <button
                  className={styles.artworkZoneClear}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); clearCoverImage(); }}
                  title={t("deck.clearArtwork")}
                >×</button>
              )}
            </div>
          </div>
        </div>

        {showStats && cards.length > 0 && (
          <div className={styles.statsBar}><DeckStats cards={cards} /></div>
        )}

        {/* ── Body ── */}
        <div className={styles.body}>

          {/* ─── LEFT : browser (toujours visible) ─── */}
          <div className={styles.browserPanel}>
            {/* Search + zoom */}
            <div className={styles.searchRow}>
              <input
                className={styles.searchInput}
                type="text"
                placeholder={t("combo.searchCard")}
                value={query}
                onChange={(e) => handleInput(e.target.value)}
                autoFocus
              />
              <div className={styles.zoomWrap}>
                <span className={styles.zoomIcon}>⊞</span>
                <span className={styles.zoomTrack}>
                  <input type="range" min="80" max="240" value={zoom}
                    className={styles.zoomSlider}
                    onChange={(e) => handleZoom(Number(e.target.value))} />
                  <span className={styles.zoomThumb}
                    style={{ left: `${((zoom - 80) / (240 - 80)) * 100}%` }} />
                </span>
              </div>
            </div>



            {/* Icon filter bar */}
            <div className={styles.filterBar}>
              {/* Color SVG circles + multicolor */}
              <div className={styles.filterGroup}>
                {COLOR_BTNS.map((c) => (
                  <button
                    key={c.code}
                    className={`${styles.colorBtn} ${selColors.includes(c.code) ? styles.filterActive : ""}`}
                    title={t(`color.${c.code}`)}
                    onClick={() => toggleColor(c.code)}
                  >
                    <img src={`${SVG}/${c.code}.svg`} alt={c.code} width={20} height={20} />
                  </button>
                ))}
                {/* Multicolor button */}
                <button
                  className={`${styles.multicolorBtn} ${filters.multicolor ? styles.filterActive : ""}`}
                  title={t("filter.multicolor")}
                  onClick={toggleMulticolor}
                />
              </div>

              {/* Types */}
              <div className={styles.filterGroup}>
                {TYPE_BTNS.map((tb) => (
                  <button
                    key={tb.code}
                    className={`${styles.typeBtn} ${tb.code === "Land" ? styles.landBtn : ""} ${(filters.card_types ?? []).includes(tb.code) ? styles.filterActive : ""}`}
                    title={t(`type.${tb.code}`)}
                    onClick={() => toggleType(tb.code)}
                  ><i className={`ms ms-${tb.ms}`} /></button>
                ))}
              </div>

              {/* CMC */}
              <div className={styles.filterGroup}>
                {CMC_BTNS.map((n) => {
                  const num = n === "7+" ? 7 : (n as number);
                  const active = (filters.cmc_values ?? []).includes(num);
                  return (
                    <button
                      key={n}
                      className={`${styles.cmcBtn} ${active ? styles.filterActive : ""}`}
                      title={n === "7+" ? t("combo.cmcGte") : t("combo.cmcEq", { n: String(n) })}
                      onClick={() => toggleCmc(n)}
                    >{n}</button>
                  );
                })}
              </div>

              {/* Rarity — icônes mana font */}
              <div className={styles.filterGroup}>
                {RARITY_BTNS.map((code) => (
                  <button
                    key={code}
                    className={`${styles.rarityBtn} ${selRarities.includes(code) ? styles.filterActive : ""}`}
                    title={t(`rarity.${code}`)}
                    onClick={() => toggleRarity(code)}
                  >
                    <i className="ms ms-rarity" style={{ color: RARITY_COLORS[code], fontSize: "1.1em" }} />
                  </button>
                ))}
              </div>

              {/* Set + sort + clear */}
              <div className={styles.filterGroup}>
                {/* Multi-select set picker with icons */}
                <div className={styles.setPicker} ref={setPickerRef}>
                  <button
                    className={`${styles.setPickerBtn} ${filterSets.length > 0 ? styles.filterActive : ""}`}
                    onClick={() => setSetPickerOpen((v) => !v)}
                    title={filterSets.length > 0 ? filterSets.map(c => setNames[c] ?? c.toUpperCase()).join(", ") : t("filter.allSets")}
                  >
                    {filterSets.length === 1 && setIcons[filterSets[0]] && (
                      <img src={setIcons[filterSets[0]]} alt="" className={styles.setIcon} />
                    )}
                    <span className={styles.setPickerLabel}>
                      {filterSets.length === 0 ? t("filter.set")
                        : filterSets.length === 1 ? (setNames[filterSets[0]] ?? filterSets[0].toUpperCase())
                        : t("filter.setsCount", { count: filterSets.length })}
                    </span>
                    <span className={styles.setPickerArrow}>▾</span>
                  </button>
                  {setPickerOpen && (
                    <div className={styles.setPickerDropdown}>
                      <div
                        className={`${styles.setPickerOption} ${filterSets.length === 0 ? styles.setPickerOptionActive : ""}`}
                        onClick={() => { setFilterSets([]); search(query, filters, []); }}
                      >{t("filter.allSets")}</div>
                      {sortedSets.map((s) => {
                        const checked = filterSets.includes(s.code);
                        const toggle = () => {
                          const next = checked
                            ? filterSets.filter((c) => c !== s.code)
                            : [...filterSets, s.code];
                          setFilterSets(next);
                          search(query, filters, next);
                        };
                        return (
                          <div
                            key={s.code}
                            className={`${styles.setPickerOption} ${checked ? styles.setPickerOptionActive : ""}`}
                            onClick={toggle}
                          >
                            <span className={styles.setPickerCheck}>{checked ? "☑" : "☐"}</span>
                            {setIcons[s.code] && (
                              <img src={setIcons[s.code]} alt="" className={styles.setIcon} />
                            )}
                            <span>{setNames[s.code] ?? s.code.toUpperCase()}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
                <select className={styles.compactSelect} value={filters.sort_by ?? "cmc"}
                  onChange={(e) => setSort(e.target.value as "name" | "cmc" | "rarity")}>
                  <option value="cmc">{t("combo.sortCmc")}</option>
                  <option value="name">{t("combo.sortAz")}</option>
                  <option value="rarity">{t("combo.sortRarity")}</option>
                </select>
                {hasFilters && (
                  <button className={styles.clearBtn} onClick={clearFilters} title={t("combo.clear")}>✕</button>
                )}
              </div>
              {/* Collection + Alchemy */}
              <div className={styles.filterGroup}>
                <button
                  className={`${styles.typeBtn} ${filters.owned_only ? styles.filterActive : ""}`}
                  title={t("filter.ownedOnly")}
                  onClick={toggleOwnedOnly}
                >📦</button>
                <button
                  className={`${styles.typeBtn} ${excludeAlchemy ? styles.filterActive : ""}`}
                  title={t("filter.excludeAlchemy")}
                  onClick={() => setExcludeAlchemy((v) => !v)}
                ><IcoNoAlchemy /></button>
              </div>
            </div>

            {/* Card grid — virtualized for performance */}
            <div className={styles.grid} ref={gridRef}>
              {loading && <p className={styles.status}>{t("view.searching")}</p>}
              {!loading && filteredResults.length === 0 && (
                <p className={styles.status}>
                  {query ? t("combo.noResultFor", { query }) : (excludeAlchemy && results.length > 0 ? t("combo.allAlchemy") : t("deck.loadingShort"))}
                </p>
              )}
              {!loading && filteredResults.length > 0 && (
                <>
                  <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
                    {rowVirtualizer.getVirtualItems().map((vRow) => (
                      <div
                        key={vRow.index}
                        style={{
                          position: "absolute",
                          top: 0,
                          transform: `translateY(${vRow.start}px)`,
                          left: 0, right: 0,
                          display: "grid",
                          gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`,
                          gap: "8px",
                        }}
                      >
                        {vRows[vRow.index].map((card) => (
                          <DraggableCardTile
                            key={card.id}
                            card={card}
                            displayLang={displayLang}
                            isDraggingAny={!!draggingCard}
                            onAdd={() => addCardToBoard(card, "main")}
                            onHover={handleHover}
                            onHoverEnd={handleHoverEnd}
                            onContextMenu={onContextMenu}
                            onClick={() => {
                              setDetailCard(card);
                              setHoverCard(null);
                              // Charge oracle_text / oracle_text_fr (absents du payload search)
                              invoke<Card | null>("get_card_by_id", { cardId: card.id })
                                .then(full => { if (full) setDetailCard(full); })
                                .catch(() => {});
                            }}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                  <p className={styles.resultCount}>{t("combo.resultCount", { count: filteredResults.length })}{excludeAlchemy && results.length !== filteredResults.length ? t("combo.alchemyExcluded", { count: results.length - filteredResults.length }) : ""}</p>
                </>
              )}
            </div>
          </div>

          {/* ─── CENTER : fiche détail (colonne optionnelle) ─── */}
          {detailCard && (
            <div className={styles.detailPanel}>
              <CardDetail
                card={detailCard}
                displayLang={displayLang}
                setIconUrl={detailCard.set_code ? (setIcons[detailCard.set_code] ?? null) : null}
                onAddMain={() => addCardToBoard(detailCard, "main")}
                onAddSide={() => addCardToBoard(detailCard, "sideboard")}
                onClose={() => setDetailCard(null)}
              />
            </div>
          )}

          {/* ─── RIGHT : deck column ─── */}
          <div
            className={styles.deckPanel}
            ref={(el) => { setDeckDropRef(el); deckPanelDomRef.current = el; }}
          >

            <div className={styles.deckTabBar}>
              <button
                className={`${styles.deckTab} ${deckTab === "main" ? styles.deckTabActive : ""}`}
                onClick={() => setDeckTab("main")}
              >⚔ Main <span className={styles.deckTabCount}>{totalMain}/{deckSizeTarget}</span></button>
              <button
                className={`${styles.deckTab} ${deckTab === "side" ? styles.deckTabActive : ""}`}
                onClick={() => setDeckTab("side")}
              >🛡 Side <span className={styles.deckTabCount}>{totalSide}</span></button>
              <button
                className={`${styles.deckTab} ${deckTab === "combos" ? styles.deckTabActive : ""}`}
                onClick={() => setDeckTab("combos")}
                title={t("deck.combosTitle")}
              >⚡ Combos {comboFetched && comboEntries.length > 0 && (
                <span className={styles.deckTabCount}>{comboEntries.filter(c => !c.isAlmost).length}</span>
              )}</button>
              <button
                className={`${styles.groupModeBtn} ${deckGroupMode === "cmc" ? styles.groupModeBtnActive : ""}`}
                onClick={() => setDeckGroupMode(m => m === "type" ? "cmc" : "type")}
                title={deckGroupMode === "type" ? t("deck.viewByCmc") : t("deck.viewByType")}
              >{deckGroupMode === "type" ? t("deck.byType") : t("deck.byCmc")}</button>
            </div>

            <div
              className={`${styles.deckList} ${draggingCard ? styles.deckListDragging : ""} ${isDeckDropOver ? styles.deckListOver : ""}`}
            >
              {deckTab === "main" && (
                <>
                  {commander.length > 0 && (
                    <>
                      <DroppableSection title={t("deck.commander")} icon={<i className="ms ms-commander" style={{ color: "#d4a017", fontSize: "1.3em" }} />}
                        cards={commander} displayLang={displayLang}
                        onSelect={(dc) => setDetailCard(dc.card)}
                        onQty={updateQty} onRemove={removeCard}
                        onHover={handleHover} onHoverEnd={handleHoverEnd}
                        groupMode="flat" onContextMenu={onContextMenu} />
                      <hr className={styles.commanderSep} />
                    </>
                  )}
                  <DroppableSection title="" icon=""
                    cards={main} displayLang={displayLang}
                    onSelect={(dc) => setDetailCard(dc.card)}
                    onQty={updateQty} onRemove={removeCard}
                    onHover={handleHover} onHoverEnd={handleHoverEnd}
                    groupMode={deckGroupMode} onContextMenu={onContextMenu} />
                  {main.length === 0 && (
                    <p className={styles.deckEmpty}>{t("deck.emptyMain")}</p>
                  )}
                </>
              )}
              {deckTab === "side" && (
                <>
                  <DroppableSection title="" icon=""
                    cards={side} displayLang={displayLang}
                    onSelect={(dc) => setDetailCard(dc.card)}
                    onQty={updateQty} onRemove={removeCard}
                    onHover={handleHover} onHoverEnd={handleHoverEnd}
                    groupMode={deckGroupMode} onContextMenu={onContextMenu} />
                  {side.length === 0 && (
                    <p className={styles.deckEmpty}>{t("deck.emptySide")}</p>
                  )}
                </>
              )}

              {deckTab === "combos" && (
                <div className={styles.comboPanel}>
                  {!comboFetched ? (
                    <div className={styles.comboInit}>
                      <p className={styles.comboHint}>{t("deck.comboHint")}</p>
                      <button
                        className="btn-primary"
                        onClick={fetchCombos}
                        disabled={comboLoading || main.length === 0}
                      >
                        {comboLoading ? t("deck.loadingShort") : t("deck.comboAnalyze")}
                      </button>
                      {main.length === 0 && (
                        <p className={styles.comboWarn}>{t("deck.comboAddFirst")}</p>
                      )}
                    </div>
                  ) : comboError ? (
                    <div className={styles.comboError}>
                      <p>{comboError}</p>
                      <button className="btn-ghost" onClick={fetchCombos}>{t("deck.retry")}</button>
                    </div>
                  ) : comboLoading ? (
                    <p className={styles.comboLoading}>{t("deck.comboAnalyzing")}</p>
                  ) : (
                    <>
                      {/* ── Filter bar ── */}
                      <div className={styles.comboFilterBar}>
                        {(["all", "complete", "almost"] as const).map((f) => (
                          <button
                            key={f}
                            className={`${styles.comboFilterBtn} ${comboFilter === f ? styles.comboFilterActive : ""}`}
                            onClick={() => setComboFilter(f)}
                          >
                            {f === "all"      && t("deck.comboFilterAll", { count: comboEntries.length })}
                            {f === "complete" && `✓ ${comboEntries.filter(c => !c.isAlmost).length}`}
                            {f === "almost"   && `~ ${comboEntries.filter(c => c.isAlmost).length}`}
                          </button>
                        ))}
                        <button
                          className={styles.comboRefreshBtn}
                          title={t("deck.comboRerun")}
                          onClick={() => { setComboFetched(false); setComboEntries([]); setComboError(null); setComboFilter("all"); }}
                        >↺</button>
                      </div>

                      {filteredCombos.length === 0 && (
                        <p className={styles.comboEmpty}>{t("deck.comboNoneCategory")}</p>
                      )}
                      {filteredCombos.map((entry) => (
                        <ComboEntryCard
                          key={entry.id}
                          entry={entry}
                          displayLang={displayLang}
                          onAddCard={(card) => addCardToBoard(card, "main")}
                          onSelect={(card) => setDetailCard(card)}
                          onHover={handleHover}
                          onHoverEnd={handleHoverEnd}
                        />
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── DragOverlay ── */}
      <DragOverlay dropAnimation={null}>
        {dragImg && (
          <img src={dragImg} alt=""
            style={{ width: zoom, borderRadius: 8, opacity: 0.92, pointerEvents: "none" }} />
        )}
      </DragOverlay>

      {/* ── Global hover preview (300px, fixed) ── */}
      {hoverImg && !draggingCard && (
        <div style={{
          position: "fixed", left: previewLeft, top: previewTop,
          zIndex: 9999, pointerEvents: "none",
          filter: "drop-shadow(0 8px 28px rgba(0,0,0,0.85))",
        }}>
          <img src={hoverImg} alt={hoverCard?.name_en}
            style={{ width: PW, borderRadius: 14, display: "block" }} />
        </div>
      )}
    </DndContext>
  );
}

// ─── DraggableCardTile ────────────────────────────────────────────────────────

function DraggableCardTile({
  card, displayLang, isDraggingAny, onAdd, onHover, onHoverEnd, onClick, onContextMenu,
}: {
  card: Card; displayLang: string; isDraggingAny: boolean;
  onAdd: () => void;
  onHover: (card: Card, x: number, y: number) => void;
  onHoverEnd: () => void;
  onClick: () => void;
  onContextMenu?: (card: Card, x: number, y: number) => void;
}) {
  const t = useT();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: card.id, data: { card },
  });
  const imgSrc = displayLang === "fr"
    ? (card.image_uri_fr ?? card.image_uri_normal ?? card.image_uri_small)
    : (card.image_uri_normal ?? card.image_uri_small);
  const name = displayLang === "fr" ? (card.name_fr ?? card.name_en) : card.name_en;

  return (
    <div
      ref={setNodeRef}
      className={styles.tile}
      style={{ opacity: isDragging ? 0 : 1, touchAction: "none" }}
      onClick={onClick}
      onContextMenu={onContextMenu ? (e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(card, e.clientX, e.clientY); } : undefined}
      onMouseEnter={(e) => { if (!isDraggingAny) onHover(card, e.clientX, e.clientY); }}
      onMouseLeave={onHoverEnd}
      {...listeners}
      {...attributes}
    >
      {imgSrc
        ? <img className={styles.tileImg} src={imgSrc} alt={name} loading="lazy" />
        : <div className={styles.tileNoImg}>{name}</div>
      }
      {card.owned_quantity != null && (
        <div style={{
          position: "absolute", bottom: 28, right: 4,
          background: "rgba(0,0,0,0.75)", color: "#fff",
          fontSize: 10, fontWeight: 700, borderRadius: 4,
          padding: "1px 5px", pointerEvents: "none",
        }}>×{card.owned_quantity}</div>
      )}
      <div className={styles.tileMeta}>
        <span className={`rarity-${card.rarity}`} style={{ fontSize: 10 }}>{name}</span>
      </div>
      <button
        className={styles.tileAdd}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onAdd(); }}
        title={t("deck.addMain")}
      >+</button>
    </div>
  );
}

// ─── DroppableSection ─────────────────────────────────────────────────────────

function DroppableSection({ title, icon, cards, displayLang, onSelect, onQty, onRemove, onHover, onHoverEnd, groupMode, onContextMenu }: {
  title: string; icon: React.ReactNode; cards: DeckCard[];
  displayLang: string;
  onSelect: (dc: DeckCard) => void;
  onQty: (dc: DeckCard, delta: number) => void;
  onRemove: (dc: DeckCard) => void;
  onHover: (card: Card, x: number, y: number) => void;
  onHoverEnd: () => void;
  groupMode: "type" | "cmc" | "flat";
  onContextMenu?: (card: Card, x: number, y: number) => void;
}) {
  const t = useT();
  const total  = cards.reduce((s, c) => s + c.quantity, 0);

  const renderRow = (dc: DeckCard) => (
    <CardRow
      key={`${dc.card.id}-${dc.board}`}
      dc={dc} displayLang={displayLang}
      onSelect={() => onSelect(dc)}
      onInc={() => onQty(dc, +1)}
      onDec={() => dc.quantity === 1 ? onRemove(dc) : onQty(dc, -1)}
      onRemove={() => onRemove(dc)}
      onHover={onHover}
      onHoverEnd={onHoverEnd}
      onContextMenu={onContextMenu}
    />
  );

  return (
    <div className={styles.section}>
      {(title || icon) && (
        <div className={styles.sectionHeader}>
          <span>{icon} {title}</span>
          <span className={styles.sectionCount}>{total}</span>
        </div>
      )}
      {cards.length === 0 && (
        <div className={styles.dropHint}>{t("deck.sectionEmpty")}</div>
      )}

      {groupMode === "flat" && cards.map(renderRow)}

      {groupMode === "cmc" && flatByCmc(cards).map(renderRow)}

      {groupMode === "type" && groupByType(cards).map(([groupKey, groupCards]) => (
        <div key={groupKey} className={styles.typeGroup}>
          <div className={styles.typeGroupLabel}>
            {t(`type.${groupKey}`)} ({groupCards.reduce((s, c) => s + c.quantity, 0)})
          </div>
          {groupCards.map(renderRow)}
        </div>
      ))}
    </div>
  );
}

// ─── CardRow ─────────────────────────────────────────────────────────────────

function CardRow({ dc, displayLang, onSelect, onInc, onDec, onRemove, onHover, onHoverEnd, onContextMenu }: {
  dc: DeckCard; displayLang: string;
  onSelect: () => void; onInc: () => void; onDec: () => void; onRemove: () => void;
  onHover: (card: Card, x: number, y: number) => void;
  onHoverEnd: () => void;
  onContextMenu?: (card: Card, x: number, y: number) => void;
}) {
  const name = displayLang === "fr" ? (dc.card.name_fr ?? dc.card.name_en) : dc.card.name_en;
  const alt  = displayLang === "fr" ? dc.card.name_en : (dc.card.name_fr ?? "");

  return (
    <div
      className={styles.cardRow}
      onContextMenu={onContextMenu ? (e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(dc.card, e.clientX, e.clientY); } : undefined}
    >
      {/* Qty — always visible */}
      <span className={styles.qty}>{dc.quantity}</span>
      {/* +/- controls — hover only */}
      <div className={styles.qtyControls} onClick={(e) => e.stopPropagation()}>
        <button className={styles.qtyBtn} onClick={onDec}>−</button>
        <button className={styles.qtyBtn} onClick={onInc}>+</button>
      </div>
      {/* Card frame — full border, triggers hover preview */}
      <div
        className={styles.cardFrame}
        style={{ borderColor: ciColor(dc.card.color_identity) }}
        onMouseEnter={(e) => onHover(dc.card, e.clientX, e.clientY)}
        onMouseLeave={onHoverEnd}
        onClick={onSelect}
      >
        <RarityGem rarity={dc.card.rarity} />
        <span className={styles.cardName}>
          {name}
          {alt && alt !== name && <span className={styles.altName}> · {alt}</span>}
        </span>
        {dc.card.mana_cost && (
          <ManaCost cost={dc.card.mana_cost} size={11} />
        )}
      </div>
      {/* Delete button — no hover effect */}
      <button className={styles.removeBtn}
        onClick={(e) => { e.stopPropagation(); onRemove(); }}>×</button>
    </div>
  );
}

// ─── ComboEntryCard ───────────────────────────────────────────────────────────

function ComboEntryCard({
  entry, displayLang, onAddCard, onSelect, onHover, onHoverEnd,
}: {
  entry: ComboEntry;
  displayLang: string;
  onAddCard: (card: Card) => void;
  onSelect: (card: Card) => void;
  onHover: (card: Card, x: number, y: number) => void;
  onHoverEnd: () => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = React.useState(false);
  return (
    <div className={`${styles.comboEntry} ${entry.isAlmost ? styles.comboAlmost : ""}`}>
      {/* Header: produces + missing badge */}
      <div className={styles.comboEntryHeader}>
        <span className={styles.comboProduces}>
          {entry.produces.slice(0, 3).join(" · ") || t("deck.comboFallback")}
        </span>
        {entry.isAlmost && (
          <span className={styles.comboBadge}>
            +{entry.missingFromDeck.length}
          </span>
        )}
      </div>

      {/* Card rows — like the deck column */}
      <div className={styles.comboCardRows}>
        {entry.allCards.map((cardName) => {
          const isIn   = entry.inDeck.includes(cardName);
          const cardObj = entry.cardObjects.find(
            (c) => c.name_en === cardName || c.name_en === frontFace(cardName)
          );
          const displayName = displayLang === "fr" && cardObj
            ? (cardObj.name_fr ?? cardObj.name_en) : cardName;
          return (
            <div
              key={cardName}
              className={`${styles.comboCardRow} ${isIn ? styles.comboCardRowIn : styles.comboCardRowMissing}`}
              onClick={cardObj ? () => onSelect(cardObj) : undefined}
              onMouseEnter={cardObj ? (e) => onHover(cardObj, e.clientX, e.clientY) : undefined}
              onMouseLeave={cardObj ? onHoverEnd : undefined}
            >
              {cardObj && <RarityGem rarity={cardObj.rarity} />}
              <span className={styles.comboCardName}>{displayName}</span>
              {cardObj?.mana_cost && <ManaCost cost={cardObj.mana_cost} size={10} />}
              {isIn
                ? <span className={styles.comboCardCheck}>✓</span>
                : cardObj && (
                  <button
                    className={styles.comboAddBtn}
                    onClick={() => onAddCard(cardObj)}
                    title={t("deck.addMain")}
                  >+</button>
                )
              }
            </div>
          );
        })}
      </div>

      {/* Description (collapsible) */}
      {entry.description && (
        <button
          className={styles.comboDescToggle}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "▾" : "▸"} {t("deck.description")}
        </button>
      )}
      {expanded && entry.description && (
        <p className={styles.comboDescText}>{entry.description}</p>
      )}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Color identity → left-border color for deck column rows
const CI_BORDER: Record<string, string> = {
  W: "#f2e4bc", U: "#1a6fb5", B: "#8888aa", R: "#c94d2f", G: "#2d7a4f",
};
function ciColor(ci: string[]): string {
  if (ci.length === 0) return "#8888a0";   // colorless/artifact — silver
  if (ci.length > 1) return "#d4af37";
  return CI_BORDER[ci[0]] ?? "#8888a0";
}

// Small colored diamond icon matching official MTG rarity colors
// Common = hollow (outline + dark center) to differentiate from uncommon
function RarityGem({ rarity }: { rarity: string }) {
  const isCommon = rarity === "common";
  const fill = isCommon       ? "#0d0d1a"
             : rarity === "uncommon" ? "#9eb8d9"
             : rarity === "rare"     ? "#d4af37"
             : rarity === "mythic"   ? "#e8612c"
             : "#8888a0";
  return (
    <svg width="9" height="9" viewBox="0 0 10 10"
      style={{ flexShrink: 0, display: "inline-block", marginRight: 2 }}>
      <polygon points="5,0 10,5 5,10 0,5"
        fill={fill}
        stroke={isCommon ? "#9090a0" : "none"}
        strokeWidth={isCommon ? "1.5" : "0"} />
    </svg>
  );
}

const TYPE_ORDER  = ["Creature","Planeswalker","Instant","Sorcery","Enchantment","Artifact","Land","Other"];

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
    group.sort((a, b) =>
      (a.card.cmc ?? 0) - (b.card.cmc ?? 0) || a.card.name_en.localeCompare(b.card.name_en)
    );
  }
  return TYPE_ORDER.filter((ty) => map.has(ty)).map((ty) => [ty, map.get(ty)!]);
}

function flatByCmc(cards: DeckCard[]): DeckCard[] {
  const isLand = (dc: DeckCard) => getTypeGroup(dc.card.type_line) === "Land";
  const nonLands = cards.filter(dc => !isLand(dc));
  const lands    = cards.filter(dc =>  isLand(dc));
  nonLands.sort((a, b) =>
    (a.card.cmc ?? 0) - (b.card.cmc ?? 0) || a.card.name_en.localeCompare(b.card.name_en)
  );
  lands.sort((a, b) => a.card.name_en.localeCompare(b.card.name_en));
  return [...nonLands, ...lands];
}
