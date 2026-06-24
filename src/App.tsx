import { useState, useEffect, useRef, Component, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";

// ── Color-identity → mana font class ────────────────────────────────────────
const _CI_ORDER = ["W","U","B","R","G"];
const _CI_MAP: Record<string, string> = {
  "W":"w","U":"u","B":"b","R":"r","G":"g",
  "WU":"wu","WB":"wb","WR":"rw","WG":"gw",
  "UB":"ub","UR":"ur","UG":"gu","BR":"br","BG":"bg","RG":"rg",
  "WUB":"ubw","WUR":"urw","WUG":"wug","WBR":"rwb","WBG":"wbg","WRG":"gwr",
  "UBR":"bru","UBG":"bgu","URG":"gur","BRG":"rgb",
  "WUBR":"wubr","WUBG":"gwub","WURG":"rgwu","WBRG":"brgw","UBRG":"ubrg",
  "WUBRG":"5",
};
function deckCiClass(colors: string[]): string | null {
  if (!colors || colors.length === 0) return null;
  const key = [...colors].sort((a,b) => _CI_ORDER.indexOf(a) - _CI_ORDER.indexOf(b)).join("");
  return _CI_MAP[key] ?? null;
}
import { invoke } from "@tauri-apps/api/core";

// Minimal error boundary to surface React render crashes
class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(err: unknown) {
    return { error: String(err) };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, color: "#e74c3c", fontFamily: "monospace", background: "#1a1a2e", minHeight: "100vh" }}>
          <h2>Erreur React</h2>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{this.state.error}</pre>
          <button style={{ marginTop: 16, padding: "8px 16px", cursor: "pointer" }}
            onClick={() => this.setState({ error: null })}>Réessayer</button>
        </div>
      );
    }
    return this.props.children;
  }
}
import IntegratedDeckBuilder from "./components/IntegratedDeckBuilder";
import DeckList from "./components/DeckList";
import CombosView, { ComboCreator } from "./components/CombosView";
import FavoritesView from "./components/FavoritesView";
import CollectionView from "./components/CollectionView";
import CardContextMenu from "./components/CardContextMenu";
import SettingsView from "./components/SettingsView";
import ToastContainer from "./components/ToastContainer";
import { useToast } from "./hooks/useToast";
import { I18nProvider } from "./I18nContext";
import { translations, type UiLang } from "./i18n";
import type { Card, Combo, Deck, DeckWithCards, DbStats } from "./types";
import styles from "./App.module.css";

type View = "deck-builder" | "decks" | "combos" | "combo-creator" | "favorites" | "collection";

export default function App() {
  const [view, setView]             = useState<View>("decks");
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Supporte plusieurs decks ouverts simultanément
  const [openDecks, setOpenDecks]   = useState<DeckWithCards[]>([]);
  const [activeDeckId, setActiveDeckId] = useState<number | null>(null);
  // Supporte plusieurs créateurs de combos ouverts simultanément
  const [openCombos, setOpenCombos] = useState<Array<{
    id: number; label: string; editCombo?: Combo; pendingAdd?: Card[];
  }>>([]);
  const [activeComboId, setActiveComboId] = useState<number | null>(null);
  const comboCounterRef = useRef(0);
  const activeDeck = openDecks.find(d => d.deck.id === activeDeckId) ?? null;
  const [dbStats, setDbStats]       = useState<DbStats | null>(null);
  // localeEnabled = true → affiche les traductions/images localisées
  //                false → tout en anglais
  // displayLang   = "fr" si localeEnabled, "en" sinon (convention interne : "fr" = "locale actif")
  // textLangCode  = code MTGA de la langue texte choisie dans les Paramètres ("frFR", "koKR"…)
  // activeLangCode = textLangCode si locale actif, "en" sinon → passé aux commandes Rust pour JOIN
  const LANG_TO_MTGA: Record<string, string> = {
    "fr":"frFR","de":"deDE","es":"esES","it":"itIT",
    "pt":"ptBR","ja":"jaJP","ko":"koKR","ru":"ruRU","zhs":"zhCN","zht":"zhTW",
  };
  // Codes ISO 3166-1 alpha-2 pour la librairie flag-icons (pas des emojis)
  const LANG_FLAG_ICON: Record<string, string> = {
    "fr":"fr","de":"de","es":"es","it":"it",
    "pt":"br","ja":"jp","ko":"kr","ru":"ru","zhs":"cn","zht":"tw",
  };
  const [localeEnabled, setLocaleEnabled] = useState<boolean>(() =>
    localStorage.getItem("locale_enabled") === "true"
  );
  const [textLangCode, setTextLangCode] = useState<string>(() =>
    localStorage.getItem("text_lang") ?? "fr"
  );
  const [imageLangCode, setImageLangCode] = useState<string>(() =>
    localStorage.getItem("image_lang") ?? "fr"
  );
  const displayLang        = localeEnabled ? "fr" : "en";
  const activeLangCode     = localeEnabled ? (LANG_TO_MTGA[textLangCode] ?? "frFR") : "en";
  const activeImageLangCode = localeEnabled ? (LANG_TO_MTGA[imageLangCode] ?? "frFR") : "en";
  // Langue de l'interface : réglage indépendant choisi dans les Paramètres (défaut anglais).
  // N'a AUCUN lien avec le toggle LOC, qui ne concerne que les cartes (texte + images + descriptions).
  const [uiLang, setUiLang] = useState<UiLang>(() =>
    (localStorage.getItem("ui_lang") ?? "en") as UiLang
  );
  const t = (key: string, vars?: Record<string, string | number>): string => {
    const dict = translations[uiLang] ?? translations.en;
    const str = dict[key] ?? translations.en[key] ?? key;
    return vars ? str.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`)) : str;
  };
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    localStorage.getItem("sidebar_collapsed") === "true"
  );
  // ── Favoris ───────────────────────────────────────────────────────────────
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set());
  // ── Context menu ──────────────────────────────────────────────────────────
  const [contextMenu, setContextMenu] = useState<{ card: Card; x: number; y: number } | null>(null);

  const { toasts, toast, dismiss }  = useToast();

  const toggleSidebar = () => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    localStorage.setItem("sidebar_collapsed", String(next));
  };

  useEffect(() => {
    invoke<DbStats>("get_db_stats").then(setDbStats).catch(console.error);
    invoke<string[]>("get_favorites")
      .then(ids => setFavoriteIds(new Set(ids)))
      .catch(console.error);
  }, []);

  // Rafraîchit les favoris quand l'addon Firefox en ajoute un via l'API
  useEffect(() => {
    const unsub = listen("favorite-added", () => {
      invoke<string[]>("get_favorites")
        .then(ids => setFavoriteIds(new Set(ids)))
        .catch(console.error);
    });
    return () => { unsub.then(fn => fn()); };
  }, []);

  const refreshStats = () => {
    invoke<DbStats>("get_db_stats").then(setDbStats).catch(console.error);
  };

  // ── Favorites toggle ──────────────────────────────────────────────────────
  const toggleFavorite = async (card: Card) => {
    const isFav = favoriteIds.has(card.id);
    try {
      await invoke(isFav ? "remove_favorite" : "add_favorite", { cardId: card.id });
      setFavoriteIds(prev => {
        const s = new Set(prev);
        isFav ? s.delete(card.id) : s.add(card.id);
        return s;
      });
      toast(isFav ? t("toast.removedFromFav") : t("toast.addedToFav"), "success");
    } catch (err) {
      toast(t("toast.favError", { msg: String(err) }), "error");
    }
  };

  // ── Context menu handler ──────────────────────────────────────────────────
  const handleCardContextMenu = (card: Card, x: number, y: number) => {
    setContextMenu({ card, x, y });
  };

  // ── Deck management ───────────────────────────────────────────────────────
  const openDeck = async (deck: Deck) => {
    if (openDecks.some(d => d.deck.id === deck.id)) {
      setActiveDeckId(deck.id);
      setView("deck-builder");
      return;
    }
    try {
      const deckData = await invoke<DeckWithCards>("get_deck_with_cards", { deckId: deck.id, langCode: activeLangCode, imageLangCode: activeImageLangCode });
      setOpenDecks(prev => [...prev, deckData]);
      setActiveDeckId(deck.id);
      setView("deck-builder");
    } catch (err) {
      toast(t("toast.error", { msg: String(err) }), "error");
    }
  };

  const closeDeck = (deckId: number) => {
    const remaining = openDecks.filter(d => d.deck.id !== deckId);
    setOpenDecks(remaining);
    if (activeDeckId === deckId) {
      if (remaining.length > 0) {
        setActiveDeckId(remaining[remaining.length - 1].deck.id);
      } else {
        setActiveDeckId(null);
        setView("decks");
      }
    }
  };

  const reloadOpenDeck = async (deckId: number) => {
    try {
      const deckData = await invoke<DeckWithCards>("get_deck_with_cards", { deckId, langCode: activeLangCode, imageLangCode: activeImageLangCode });
      setOpenDecks(prev => prev.map(d => d.deck.id === deckId ? deckData : d));
    } catch (err) {
      console.error("reloadOpenDeck error:", err);
    }
  };

  const updateOpenDeck = (updated: DeckWithCards) => {
    setOpenDecks(prev => prev.map(d => d.deck.id === updated.deck.id ? updated : d));
  };

  // ── Combo management ──────────────────────────────────────────────────────
  const openNewCombo = (editCombo?: Combo, initialCard?: Card) => {
    comboCounterRef.current += 1;
    const id = comboCounterRef.current;
    const label = editCombo
      ? `✏ ${editCombo.name}`
      : initialCard
        ? (displayLang === "fr" ? (initialCard.name_fr ?? initialCard.name_en) : initialCard.name_en)
        : `Combo (${id})`;
    const pendingAdd = initialCard ? [initialCard] : undefined;
    setOpenCombos(prev => [...prev, { id, label, editCombo, pendingAdd }]);
    setActiveComboId(id);
    setView("combo-creator");
  };

  const closeCombo = (id: number) => {
    const remaining = openCombos.filter(c => c.id !== id);
    setOpenCombos(remaining);
    if (activeComboId === id) {
      if (remaining.length > 0) {
        setActiveComboId(remaining[remaining.length - 1].id);
      } else {
        setActiveComboId(null);
        setView("combos");
      }
    }
  };

  const handleLocaleToggle = () => {
    const next = !localeEnabled;
    setLocaleEnabled(next);
    localStorage.setItem("locale_enabled", String(next));
  };

  // Shared props for all card-browsing views
  const contextMenuProps = {
    favoriteIds,
    onContextMenu: handleCardContextMenu,
  };

  return (
    <I18nProvider lang={uiLang}>
    <div className={styles.layout}>
      {/* ── Sidebar ── */}
      <aside className={`${styles.sidebar} ${sidebarCollapsed ? styles.sidebarCollapsed : ""}`}>
        <div className={styles.logo}>
          <img src="/lotus.png" alt="" className={styles.logoIcon} />
          <span className={styles.logoText}>MTGA Builder</span>
          <button
            className={styles.collapseBtn}
            onClick={toggleSidebar}
            title={sidebarCollapsed ? t("sidebar.expand") : t("sidebar.collapse")}
          >{sidebarCollapsed ? "›" : "‹"}</button>
        </div>

        <nav className={styles.nav}>
          {/* ── Boutons principaux (hauteur fixe) ── */}
          <div className={styles.navMain}>
            <button
              className={`${styles.navItem} ${view === "decks" ? styles.navActive : ""}`}
              onClick={() => setView("decks")}
              title={t("nav.myDecks")}
            ><span className={styles.navIcon}><img src="/deck.png" alt="" className={styles.navIconImg} /></span><span className={styles.navLabel}> {t("nav.myDecks")}</span></button>
            <button
              className={`${styles.navItem} ${view === "combos" ? styles.navActive : ""}`}
              onClick={() => setView("combos")}
              title={t("nav.combos")}
            ><span className={styles.navIcon}><img src="/combo.png" alt="" className={`${styles.navIconImg} ${styles.navIconCombo}`} /></span><span className={styles.navLabel}> {t("nav.combos")}</span></button>
            <button
              className={`${styles.navItem} ${view === "favorites" ? styles.navActive : ""}`}
              onClick={() => setView("favorites")}
              title={t("nav.favorites")}
            ><span className={styles.navIcon}><img src="/star.png" alt="" className={styles.navIconImg} /></span><span className={styles.navLabel}> {t("nav.favorites")}</span></button>
            <button
              className={`${styles.navItem} ${view === "collection" ? styles.navActive : ""}`}
              onClick={() => setView("collection")}
              title={t("nav.collection")}
            ><span className={styles.navIcon}><img src="/collec.png" alt="" className={styles.navIconImg} /></span><span className={styles.navLabel}> {t("nav.collection")}</span></button>
          </div>

          {/* ── Zone open items : moitié restante divisée en deux ── */}
          {(openDecks.length > 0 || openCombos.length > 0) && (
            <>
              <hr className={styles.navSeparator} />
              <div className={styles.navOpenItems}>
                {openDecks.length > 0 && (
                  <div className={styles.navOpenSection}>
                    <div className={styles.deckNavDivider}>{t("nav.decksInProgress")}</div>
                    {openDecks.map(od => (
                      <div key={od.deck.id} className={styles.openDeckRow}>
                        <button
                          className={`${styles.navItem} ${styles.openDeckBtn} ${activeDeckId === od.deck.id && view === "deck-builder" ? styles.navActive : ""}`}
                          onClick={() => { setActiveDeckId(od.deck.id); setView("deck-builder"); }}
                          title={od.deck.name}
                        >
                          <span className={styles.navIcon}>
                            {(() => {
                              const cls = deckCiClass(od.deck.color_identities);
                              return <i className={`ms ms-ci ms-ci-${cls ?? "c"}`} style={{ fontSize: "1.1em" }} />;
                            })()}
                          </span>
                          <span className={`${styles.navLabel} ${styles.deckNavName}`}>{od.deck.name}</span>
                        </button>
                        <button
                          className={styles.openDeckCloseBtn}
                          onClick={() => closeDeck(od.deck.id)}
                          title={t("nav.close")}
                        >×</button>
                      </div>
                    ))}
                  </div>
                )}
                {openCombos.length > 0 && (
                  <div className={styles.navOpenSection}>
                    <div className={styles.deckNavDivider}>{t("nav.combosInProgress")}</div>
                    {openCombos.map(oc => (
                      <div key={oc.id} className={styles.openDeckRow}>
                        <button
                          className={`${styles.navItem} ${styles.openDeckBtn} ${activeComboId === oc.id && view === "combo-creator" ? styles.navActive : ""}`}
                          onClick={() => { setActiveComboId(oc.id); setView("combo-creator"); }}
                          title={oc.label}
                        >
                          <span className={styles.navIcon}><i className="ms ms-ability-copy" /></span>
                          <span className={`${styles.navLabel} ${styles.deckNavName}`}>{oc.label}</span>
                        </button>
                        <button
                          className={styles.openDeckCloseBtn}
                          onClick={() => closeCombo(oc.id)}
                          title={t("nav.close")}
                        >×</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </nav>

        {/* Stats DB */}
        <div className={styles.dbStats}>
          {dbStats !== null ? (
            dbStats.total_cards === 0 ? (
              <p className={styles.dbWarning}>
                ⚠ {t("stats.emptyDb")}
              </p>
            ) : (
              <>
                <div className={styles.statRow}>
                  <span>{t("stats.cards")}</span>
                  <span className={styles.statValue}>{dbStats.total_cards.toLocaleString()}</span>
                </div>
                <div className={styles.statRow}>
                  <span>{t("stats.locNames")}</span>
                  <span className={styles.statValue}>{dbStats.cards_with_fr.toLocaleString()}</span>
                </div>
                <div className={styles.statRow}>
                  <span>{t("stats.decks")}</span>
                  <span className={styles.statValue}>{dbStats.total_decks}</span>
                </div>
                <div className={styles.statRow}>
                  <span>{t("stats.combos")}</span>
                  <span className={styles.statValue}>{dbStats.total_combos}</span>
                </div>
              </>
            )
          ) : (
            <p className={styles.statLoading}>{t("stats.loading")}</p>
          )}
        </div>

        {/* Toggle localisation ON/OFF */}
        <div className={styles.langToggleBlock}>
          <span className={styles.langSelectLabel}>{t("sidebar.language")}</span>
          <button
            className={`${styles.langToggleBtn} ${localeEnabled ? styles.langToggleBtnOn : ""}`}
            onClick={handleLocaleToggle}
            title={localeEnabled ? t("sidebar.switchToEn") : t("sidebar.switchToLoc")}
          >
            {localeEnabled ? (
              <>
                <span className={`fi fi-${LANG_FLAG_ICON[textLangCode] ?? "un"}`}
                  style={{ marginRight: 4, borderRadius: 2 }} />
                LOC
              </>
            ) : (
              <>
                <span className="fi fi-gb" style={{ marginRight: 4, borderRadius: 2 }} />
                EN
              </>
            )}
          </button>
        </div>

        {/* Paramètres */}
        <button
          className={`${styles.navItem} ${settingsOpen ? styles.navActive : ""}`}
          onClick={() => setSettingsOpen((v) => !v)}
          style={{ marginTop: 4 }}
          title={t("nav.settings")}
        ><span className={styles.navIcon}>⚙</span><span className={styles.navLabel}> {t("nav.settings")}</span></button>

        <div className={styles.apiInfo}>
          <span className={styles.apiDot} />
          <span className={styles.navLabel}>API :7891</span>
        </div>
      </aside>

      {/* ── Contenu ── */}
      <main className={styles.main}>
        {view === "decks" && (
          <DeckList onOpenDeck={openDeck} onDeckChange={refreshStats} onToast={toast} />
        )}
        {view === "deck-builder" && activeDeck && (
          <ErrorBoundary>
            <IntegratedDeckBuilder
              key={activeDeck.deck.id}
              deckData={activeDeck}
              onChange={updateOpenDeck}
              onToast={toast}
              displayLang={displayLang}
              langCode={activeLangCode}
              imageLangCode={activeImageLangCode}
              {...contextMenuProps}
            />
          </ErrorBoundary>
        )}
        {view === "combos" && (
          <CombosView
            onToast={toast}
            displayLang={displayLang}
            langCode={activeLangCode}
            imageLangCode={activeImageLangCode}
            onNewCombo={openNewCombo}
            onOpenCombo={openNewCombo}
            openDecks={openDecks}
            onDeckUpdated={reloadOpenDeck}
            {...contextMenuProps}
          />
        )}
        {view === "combo-creator" && activeComboId !== null && (
          <ComboCreator
            key={activeComboId}
            onClose={() => closeCombo(activeComboId)}
            onToast={toast}
            displayLang={displayLang}
            langCode={activeLangCode}
            imageLangCode={activeImageLangCode}
            editCombo={openCombos.find(c => c.id === activeComboId)?.editCombo}
            pendingAdd={openCombos.find(c => c.id === activeComboId)?.pendingAdd}
            {...contextMenuProps}
          />
        )}
        {view === "favorites" && (
          <FavoritesView
            onToast={toast}
            displayLang={displayLang}
            langCode={activeLangCode}
            imageLangCode={activeImageLangCode}
            openDecks={openDecks}
            openCombos={openCombos}
            {...contextMenuProps}
          />
        )}

        {view === "collection" && (
          <CollectionView
            onToast={toast}
            displayLang={displayLang}
            langCode={activeLangCode}
            imageLangCode={activeImageLangCode}
            openDecks={openDecks}
            openCombos={openCombos}
            {...contextMenuProps}
          />
        )}

        {/* Settings overlay — par-dessus la vue courante */}
        {settingsOpen && (
          <div className={styles.settingsOverlay}>
            <SettingsView
              onToast={toast}
              onClose={() => {
                setSettingsOpen(false);
                // Re-lire les langues au cas où elles ont changé dans les Paramètres
                setTextLangCode(localStorage.getItem("text_lang") ?? "fr");
                setImageLangCode(localStorage.getItem("image_lang") ?? "fr");
                setUiLang((localStorage.getItem("ui_lang") ?? "en") as UiLang);
                refreshStats();
              }}
              onUiLangChange={(lang) => setUiLang(lang as UiLang)}
              onStatsRefresh={refreshStats}
            />
          </div>
        )}
      </main>

      {/* ── Context menu global ── */}
      {contextMenu && (
        <CardContextMenu
          card={contextMenu.card}
          x={contextMenu.x}
          y={contextMenu.y}
          isFavorite={favoriteIds.has(contextMenu.card.id)}
          openDecks={openDecks}
          openCombos={openCombos}
          displayLang={displayLang}
          onAddFavorite={() => { toggleFavorite(contextMenu.card); setContextMenu(null); }}
          onRemoveFavorite={() => { toggleFavorite(contextMenu.card); setContextMenu(null); }}
          onCreateCombo={(card) => { openNewCombo(undefined, card); setContextMenu(null); }}
          onSendToDeck={async (deckId) => {
            try {
              await invoke("add_card_to_deck", { deckId, cardId: contextMenu.card.id, quantity: 1, board: "main" });
              const deckName = openDecks.find(d => d.deck.id === deckId)?.deck.name ?? "deck";
              toast(t("toast.cardSentToDeck", { name: deckName }), "success");
            } catch (err) {
              toast(t("toast.error", { msg: String(err) }), "error");
            }
            setContextMenu(null);
          }}
          onSendToCombo={(comboId) => {
            setOpenCombos(prev => prev.map(c =>
              c.id === comboId
                ? { ...c, pendingAdd: [...(c.pendingAdd ?? []), contextMenu.card] }
                : c
            ));
            const comboLabel = openCombos.find(c => c.id === comboId)?.label ?? "combo";
            toast(t("toast.cardSentToCombo", { name: comboLabel }), "success");
            setContextMenu(null);
          }}
          onClose={() => setContextMenu(null)}
        />
      )}

      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
    </I18nProvider>
  );
}
