import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { invoke } from "@tauri-apps/api/core";
import type { Card, CardFilters, DeckWithCards } from "../types";
import { useT } from "../I18nContext";
import CardDetail from "./CardDetail";
import styles from "./FavoritesView.module.css";
import bStyles from "./IntegratedDeckBuilder.module.css";

const SVG = "https://svgs.scryfall.io/card-symbols";


// ─── Filter config (same as IntegratedDeckBuilder) ────────────────────────────

interface SetInfo { code: string; count: number; }

const COLOR_BTNS = [
  { code: "W", title: "Blanc" },
  { code: "U", title: "Bleu" },
  { code: "B", title: "Noir" },
  { code: "R", title: "Rouge" },
  { code: "G", title: "Vert" },
  { code: "C", title: "Incolore" },
];

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

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  onToast?: (msg: string, type?: "success" | "error" | "info") => void;
  displayLang: string;
  langCode?: string;
  imageLangCode?: string;
  favoriteIds: Set<string>;
  onContextMenu: (card: Card, x: number, y: number) => void;
  openDecks: DeckWithCards[];
  openCombos: Array<{ id: number; label: string }>;
}

// ─── Card Tile ────────────────────────────────────────────────────────────────

function FavCardTile({ card, displayLang, onContextMenu, onClick }: {
  card: Card;
  displayLang: string;
  onContextMenu: (card: Card, x: number, y: number) => void;
  onClick: () => void;
}) {
  const imgSrc = displayLang === "fr"
    ? (card.image_uri_fr ?? card.image_uri_normal ?? card.image_uri_small)
    : (card.image_uri_normal ?? card.image_uri_small);
  const name = displayLang === "fr" ? (card.name_fr ?? card.name_en) : card.name_en;

  return (
    <div
      className={styles.tile}
      onClick={onClick}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(card, e.clientX, e.clientY); }}
    >
      {imgSrc
        ? <img className={styles.tileImg} src={imgSrc} alt={name} loading="lazy" />
        : <div className={styles.tileNoImg}>{name}</div>
      }
      <div className={styles.tileMeta}>
        <span className={`rarity-${card.rarity}`} style={{ fontSize: 10 }}>{name}</span>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function FavoritesView({ onToast: _onToast, displayLang, langCode = "en", imageLangCode = "en", favoriteIds, onContextMenu }: Props) {
  const t = useT();
  const [query, setQuery]             = useState("");
  const [results, setResults]         = useState<Card[]>([]);
  const [loading, setLoading]         = useState(false);
  const [filters, setFilters]         = useState<CardFilters>({ sort_by: "name" });
  const [filterSets, setFilterSets]   = useState<string[]>([]);
  const [sets, setSets]               = useState<SetInfo[]>([]);
  const [setDates, setSetDates]       = useState<Record<string, string>>({});
  const [arenaSetCodes, setArenaSetCodes] = useState<Set<string>>(() => {
    try {
      const cached = localStorage.getItem("scryfall_arena_set_codes");
      return cached ? new Set(JSON.parse(cached) as string[]) : new Set();
    } catch { return new Set(); }
  });
  const [zoom, setZoom]               = useState(() => Number(localStorage.getItem("fav_zoom") ?? 100));
  const [detailCard, setDetailCard]   = useState<Card | null>(null);
  const [excludeAlchemy, setExcludeAlchemy] = useState(() =>
    localStorage.getItem("settings_exclude_alchemy") === "true"
  );
  const [containerWidth, setContainerWidth] = useState(600);
  const [setPickerOpen, setSetPickerOpen]   = useState(false);
  const [setNames, setSetNames]             = useState<Record<string, string>>({});
  const [setIcons, setSetIcons]             = useState<Record<string, string>>({});
  const debounceRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gridRef       = useRef<HTMLDivElement>(null);
  const containerRef  = useRef<HTMLDivElement>(null);
  const setPickerRef  = useRef<HTMLDivElement>(null);

  // Observe container width
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setContainerWidth(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Load sets once
  useEffect(() => {
    invoke<SetInfo[]>("get_sets").then(data => {
      setSets(data);
      const dates: Record<string, string> = {};
      data.forEach(s => { dates[s.code] = s.code; });
      setSetDates(dates);
    }).catch(console.error);
    // Set names + icons from Scryfall (same as IntegratedDeckBuilder)
    fetch("https://api.scryfall.com/sets")
      .then(r => r.json())
      .then(data => {
        const names: Record<string, string> = {};
        const icons: Record<string, string> = {};
        const dates2: Record<string, string> = {};
        const arenaCodes = new Set<string>();
        for (const s of data.data ?? []) {
          names[s.code] = s.name;
          if (s.icon_svg_uri) icons[s.code] = s.icon_svg_uri;
          if (s.released_at) dates2[s.code] = s.released_at;
          if (s.arena_code) arenaCodes.add(s.code);
        }
        setSetNames(names);
        setSetIcons(icons);
        setSetDates(dates2);
        localStorage.setItem("scryfall_arena_set_codes", JSON.stringify([...arenaCodes]));
        setArenaSetCodes(arenaCodes);
      })
      .catch(() => {});
  }, []);

  // Close set picker on outside click
  useEffect(() => {
    if (!setPickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (setPickerRef.current && !setPickerRef.current.contains(e.target as Node)) {
        setSetPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [setPickerOpen]);

  const search = useCallback(async (q: string, f: CardFilters, fSets: string[]) => {
    setLoading(true);
    try {
      const activeFilters: CardFilters = {
        ...f,
        favorites_only: true,
        set_codes: fSets.length ? fSets : undefined,
      };
      const cards = await invoke<Card[]>("search_cards", {
        query: q,
        limit: 500,
        filters: activeFilters,
        langCode,
        imageLangCode,
      });
      const seen = new Set<string>();
      setResults(cards.filter((c) => {
        const key = c.oracle_id ?? c.id;
        if (seen.has(key)) return false;
        seen.add(key); return true;
      }));
    } catch (err) {
      console.error("Erreur recherche favoris :", err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Reload when favoriteIds changes (e.g. a card removed)
  useEffect(() => {
    search(query, filters, filterSets);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [favoriteIds]);

  const handleInput = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => search(value, filters, filterSets), 250);
  };

  const toggleColor = (code: string) => {
    const cur = filters.colors ?? [];
    const next = cur.includes(code) ? cur.filter(c => c !== code) : [...cur, code];
    const nf = { ...filters, colors: next.length ? next : undefined };
    setFilters(nf); search(query, nf, filterSets);
  };
  const toggleMulticolor = () => {
    const nf = { ...filters, multicolor: !filters.multicolor || undefined };
    setFilters(nf); search(query, nf, filterSets);
  };
  const toggleRarity = (r: string) => {
    const cur = filters.rarities ?? [];
    const next = cur.includes(r) ? cur.filter(x => x !== r) : [...cur, r];
    const nf = { ...filters, rarities: next.length ? next : undefined };
    setFilters(nf); search(query, nf, filterSets);
  };
  const toggleType = (code: string) => {
    const cur = filters.card_types ?? [];
    const next = cur.includes(code) ? cur.filter(t => t !== code) : [...cur, code];
    const nf = { ...filters, card_types: next.length ? next : undefined };
    setFilters(nf); search(query, nf, filterSets);
  };
  const toggleCmc = (val: number) => {
    const cur = filters.cmc_values ?? [];
    const next = cur.includes(val) ? cur.filter(v => v !== val) : [...cur, val];
    const nf = { ...filters, cmc_values: next.length ? next : undefined };
    setFilters(nf); search(query, nf, filterSets);
  };
  const toggleSet = (code: string) => {
    const next = filterSets.includes(code) ? filterSets.filter(s => s !== code) : [...filterSets, code];
    setFilterSets(next); search(query, filters, next);
  };

  const hasFilters = (filters.colors?.length ?? 0) > 0 || filters.multicolor ||
    (filters.rarities?.length ?? 0) > 0 || (filters.card_types?.length ?? 0) > 0 ||
    (filters.cmc_values?.length ?? 0) > 0 || filterSets.length > 0;

  const toggleOwnedOnly = () => {
    const nf = { ...filters, owned_only: filters.owned_only ? undefined : true };
    setFilters(nf); search(query, nf, filterSets);
  };

  const clearFilters = () => {
    const nf: CardFilters = { sort_by: "name" };
    setFilters(nf); setFilterSets([]); search(query, nf, []);
  };

  const handleZoom = (val: number) => {
    setZoom(val); localStorage.setItem("fav_zoom", String(val));
  };

  const filteredResults = useMemo(
    () => excludeAlchemy ? results.filter(c => !c.name_en.startsWith("A-")) : results,
    [results, excludeAlchemy]
  );

  // Virtual grid
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

  const selColors   = filters.colors ?? [];
  const selRarities = filters.rarities ?? [];
  const sortedSets  = useMemo(() =>
    [...sets]
      .filter(s => arenaSetCodes.size === 0 || arenaSetCodes.has(s.code))
      .sort((a, b) => (setDates[b.code] ?? "").localeCompare(setDates[a.code] ?? "")),
  [sets, setDates, arenaSetCodes]);

  return (
    <div className={styles.container}>
      {/* ── Header ── */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <h2 className={styles.title}>⭐ {t("fav.title")}</h2>
          <span className={styles.count}>{t("view.cardCount", { count: filteredResults.length })}</span>
        </div>
      </div>

      {/* ── Search + zoom ── */}
      <div className={bStyles.searchRow}>
        <input
          className={`input ${bStyles.searchInput}`}
          type="text"
          placeholder={t("fav.searchPlaceholder")}
          value={query}
          onChange={e => handleInput(e.target.value)}
          autoFocus
        />
        <div className={bStyles.zoomWrap}>
          <span className={bStyles.zoomIcon}>⊞</span>
          <span className={bStyles.zoomTrack}>
            <input type="range" min={60} max={200} step={10}
              value={zoom} onChange={e => handleZoom(Number(e.target.value))}
              className={bStyles.zoomSlider}
            />
            <span className={bStyles.zoomThumb}
              style={{ left: `${((zoom - 60) / (200 - 60)) * 100}%` }} />
          </span>
        </div>
      </div>

      {/* ── Filter bar ── */}
      <div className={bStyles.filterBar}>
        {/* Colors */}
        <div className={bStyles.filterGroup}>
          {COLOR_BTNS.map(({ code }) => (
            <button key={code} title={t(`color.${code}`)}
              className={`${bStyles.colorBtn} ${selColors.includes(code) ? bStyles.filterActive : ""}`}
              onClick={() => toggleColor(code)}
            >
              <img src={`${SVG}/${code}.svg`} alt={code} width={20} height={20} />
            </button>
          ))}
          <button title={t("filter.multicolor")}
            className={`${bStyles.multicolorBtn} ${filters.multicolor ? bStyles.filterActive : ""}`}
            onClick={toggleMulticolor}
          />
        </div>

        {/* Types */}
        <div className={bStyles.filterGroup}>
          {TYPE_BTNS.map(({ code, ms }) => (
            <button key={code} title={t(`type.${code}`)}
              className={`${bStyles.typeBtn} ${code === "Land" ? bStyles.landBtn : ""} ${(filters.card_types ?? []).includes(code) ? bStyles.filterActive : ""}`}
              onClick={() => toggleType(code)}
            ><i className={`ms ms-${ms}`} /></button>
          ))}
        </div>

        {/* CMC */}
        <div className={bStyles.filterGroup}>
          {CMC_BTNS.map((v) => {
            const num = v === "7+" ? 7 : (v as number);
            const label = String(v);
            const active = (filters.cmc_values ?? []).includes(num);
            return (
              <button key={label} title={t("filter.cmc", { n: label })}
                className={`${bStyles.cmcBtn} ${active ? bStyles.filterActive : ""}`}
                onClick={() => toggleCmc(num)}
              >{label}</button>
            );
          })}
        </div>

        {/* Rarities */}
        <div className={bStyles.filterGroup}>
          {RARITY_BTNS.map(r => (
            <button key={r}
              title={t(`rarity.${r}`)}
              className={`${bStyles.rarityBtn} ${selRarities.includes(r) ? bStyles.filterActive : ""}`}
              onClick={() => toggleRarity(r)}
            >
              <i className="ms ms-rarity" style={{ color: RARITY_COLORS[r], fontSize: "1.1em" }} />
            </button>
          ))}
        </div>

        {/* Set picker */}
        <div className={bStyles.filterGroup}>
          <div className={bStyles.setPicker} ref={setPickerRef}>
            <button
              className={`${bStyles.setPickerBtn} ${filterSets.length > 0 ? bStyles.filterActive : ""}`}
              onClick={() => setSetPickerOpen(v => !v)}
              title={filterSets.length > 0 ? filterSets.map(c => setNames[c] ?? c.toUpperCase()).join(", ") : t("filter.allSets")}
            >
              {filterSets.length === 1 && setIcons[filterSets[0]] && (
                <img src={setIcons[filterSets[0]]} alt="" className={bStyles.setIcon} />
              )}
              <span className={bStyles.setPickerLabel}>
                {filterSets.length === 0 ? t("filter.set")
                  : filterSets.length === 1 ? (setNames[filterSets[0]] ?? filterSets[0].toUpperCase())
                  : t("filter.setsCount", { count: filterSets.length })}
              </span>
              <span className={bStyles.setPickerArrow}>▾</span>
            </button>
            {setPickerOpen && (
              <div className={bStyles.setPickerDropdown}>
                <div
                  className={`${bStyles.setPickerOption} ${filterSets.length === 0 ? bStyles.setPickerOptionActive : ""}`}
                  onClick={() => { setFilterSets([]); search(query, filters, []); setSetPickerOpen(false); }}
                >{t("filter.allSets")}</div>
                {sortedSets.map(s => {
                  const checked = filterSets.includes(s.code);
                  return (
                    <div
                      key={s.code}
                      className={`${bStyles.setPickerOption} ${checked ? bStyles.setPickerOptionActive : ""}`}
                      onClick={() => toggleSet(s.code)}
                    >
                      <span className={bStyles.setPickerCheck}>{checked ? "☑" : "☐"}</span>
                      {setIcons[s.code] && (
                        <img src={setIcons[s.code]} alt="" className={bStyles.setIcon} />
                      )}
                      <span>{setNames[s.code] ?? s.code.toUpperCase()}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Collection + Alchemy */}
        <div className={bStyles.filterGroup}>
          <button title={t("filter.ownedOnly")}
            className={`${bStyles.typeBtn} ${filters.owned_only ? bStyles.filterActive : ""}`}
            onClick={toggleOwnedOnly}
          >📦</button>
          <button title={t("filter.excludeAlchemy")}
            className={`${bStyles.typeBtn} ${excludeAlchemy ? bStyles.filterActive : ""}`}
            onClick={() => { const n = !excludeAlchemy; setExcludeAlchemy(n); localStorage.setItem("settings_exclude_alchemy", String(n)); }}
          >
            <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
              <text x="2" y="12" fontSize="11" fontWeight="700" fontFamily="monospace" fill="currentColor">A</text>
              <line x1="1" y1="2" x2="14" y2="13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {hasFilters && (
          <button className={bStyles.clearBtn} onClick={clearFilters} title={t("filter.clear")}>✕</button>
        )}
      </div>

      {/* ── Body ── */}
      <div className={styles.body} ref={containerRef}>
        {/* Grid */}
        <div className={styles.grid} ref={gridRef}>
          {loading && <p className={styles.status}>{t("view.searching")}</p>}
          {!loading && filteredResults.length === 0 && (
            <p className={styles.status}>
              {favoriteIds.size === 0
                ? t("fav.emptyNoFav")
                : query || hasFilters
                  ? t("view.noResults")
                  : t("fav.emptyNoMatch")}
            </p>
          )}
          {!loading && filteredResults.length > 0 && (
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
                    padding: "0 6px",
                  }}
                >
                  {vRows[vRow.index].map(card => (
                    <FavCardTile
                      key={card.id}
                      card={card}
                      displayLang={displayLang}
                      onContextMenu={onContextMenu}
                      onClick={() => {
                        setDetailCard(card);
                        invoke<Card | null>("get_card_by_id", { cardId: card.id })
                          .then(full => { if (full) setDetailCard(full); })
                          .catch(() => {});
                      }}
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Detail panel */}
        {detailCard && (
          <div className={styles.detailPanel}>
            <CardDetail
              card={detailCard}
              displayLang={displayLang}
              onClose={() => setDetailCard(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
