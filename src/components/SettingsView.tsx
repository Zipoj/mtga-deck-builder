import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useT } from "../I18nContext";
import styles from "./SettingsView.module.css";
import FlagSelect from "./FlagSelect";
import {
  COLOR_THEMES, FONT_THEMES, applyColorTheme, applyFontTheme,
  DEFAULT_COLOR_THEME, DEFAULT_FONT_THEME,
  CUSTOM_COLOR_THEME, CUSTOM_COLOR_ID, VAR_KEYS, VAR_LABEL_KEYS,
  getCustomColorVars, saveCustomColorVars,
} from "../themes";

const APP_VERSION = "1.0.0";

// ─── Langues disponibles ───────────────────────────────────────────────────────
// display = code court utilisé dans l'app (displayLang)
// mtga    = code MTGA utilisé pour la synchro des fichiers du jeu
// fi      = code ISO 3166-1 alpha-2 pour la lib flag-icons (classe CSS "fi fi-XX")
const LANGS = [
  { display: "fr",  mtga: "frFR", label: "Français",  flag: "🇫🇷", fi: "fr" },
  { display: "de",  mtga: "deDE", label: "Deutsch",   flag: "🇩🇪", fi: "de" },
  { display: "es",  mtga: "esES", label: "Español",   flag: "🇪🇸", fi: "es" },
  { display: "it",  mtga: "itIT", label: "Italiano",  flag: "🇮🇹", fi: "it" },
  { display: "pt",  mtga: "ptBR", label: "Português", flag: "🇧🇷", fi: "br" },
  { display: "ja",  mtga: "jaJP", label: "日本語",    flag: "🇯🇵", fi: "jp" },
  { display: "ko",  mtga: "koKR", label: "한국어",    flag: "🇰🇷", fi: "kr" },
  { display: "ru",  mtga: "ruRU", label: "Русский",   flag: "🇷🇺", fi: "ru" },
  { display: "zhs", mtga: "zhCN", label: "中文(简)",  flag: "🇨🇳", fi: "cn" },
  { display: "zht", mtga: "zhTW", label: "中文(繁)",  flag: "🇹🇼", fi: "tw" },
] as const;

// ─── Interfaces ────────────────────────────────────────────────────────────────
interface DetailedStats {
  total_cards:         number;
  cards_with_fr_names: number;
  cards_with_fr_images:number;
  total_combos:        number;
  total_decks:         number;
  db_size_mb:          number;
}

interface EnrichProgress {
  page:          number;
  total_updated: number;
  done:          boolean;
  error:         string | null;
}

interface ImportProgress {
  stage:          "fetch_url"|"download"|"parse"|"import"|"rebuild_fts"|"done";
  downloaded_mb:  number;
  total_mb:       number;
  cards_imported: number;
  done:           boolean;
  error:          string | null;
}

interface MtgaSyncProgress {
  stage:         string;
  cards_found:   number;
  cards_updated: number;
  done:          boolean;
  error:         string | null;
}

interface MtgaScanResult {
  data_dir:   string;
  loc_files:  string[];
  cards_file: string | null;
  ready:      boolean;
}

interface Props {
  onToast?:        (msg: string, type?: "success"|"error"|"info") => void;
  onClose?:        () => void;
  onStatsRefresh?: () => void;
  onUiLangChange?: (lang: string) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function SettingsView({ onToast, onClose, onStatsRefresh, onUiLangChange }: Props) {
  const t = useT();
  // Langue pour les images Scryfall (code court : "fr", "ja"…)
  const [imageLang, setImageLang] = useState<string>(() =>
    localStorage.getItem("image_lang") ?? "fr"
  );
  // Langue pour les traductions MTGA (code court : "fr", "ko"…)
  const [textLang, setTextLang] = useState<string>(() =>
    localStorage.getItem("text_lang") ?? "fr"
  );
  // Langue de l'interface (indépendante des cartes ; défaut anglais)
  const [uiLang, setUiLang] = useState<string>(() =>
    localStorage.getItem("ui_lang") ?? "en"
  );

  const handleImageLangChange = (lang: string) => {
    setImageLang(lang);
    localStorage.setItem("image_lang", lang);
  };
  const handleTextLangChange = (lang: string) => {
    setTextLang(lang);
    localStorage.setItem("text_lang", lang);
  };
  const handleUiLangChange = (lang: string) => {
    setUiLang(lang);
    localStorage.setItem("ui_lang", lang);
    onUiLangChange?.(lang);  // mise à jour live de l'interface
  };
  // ── Thèmes (couleur + police) : aperçu live + persistance ──
  const [colorTheme, setColorTheme] = useState<string>(() =>
    localStorage.getItem("color_theme") ?? DEFAULT_COLOR_THEME
  );
  const [fontTheme, setFontTheme] = useState<string>(() =>
    localStorage.getItem("font_theme") ?? DEFAULT_FONT_THEME
  );
  const [customVars, setCustomVars] = useState<Record<string, string>>(() => getCustomColorVars());
  const handleColorThemeChange = (id: string) => {
    setColorTheme(id);
    localStorage.setItem("color_theme", id);
    applyColorTheme(id);  // aperçu instantané
  };
  const handleCustomVarChange = (key: string, value: string) => {
    const next = { ...customVars, [key]: value };
    setCustomVars(next);
    saveCustomColorVars(next);
    if (colorTheme === CUSTOM_COLOR_ID) applyColorTheme(CUSTOM_COLOR_ID);  // aperçu live
  };
  const handleFontThemeChange = (id: string) => {
    setFontTheme(id);
    localStorage.setItem("font_theme", id);
    applyFontTheme(id);   // aperçu instantané
  };
  // Options du sélecteur de langue d'interface : anglais + les 10 langues localisées
  const UI_LANG_OPTIONS = [
    { value: "en", label: "English", fi: "gb" },
    ...LANGS.map(l => ({ value: l.display, label: l.label, fi: l.fi })),
  ];

  // Code MTGA dérivé de la langue texte (ex: "ko" → "koKR")
  const mtgaCode    = LANGS.find(l => l.display === textLang)?.mtga  ?? "frFR";
  const imageLangMeta = LANGS.find(l => l.display === imageLang);
  const textLangMeta  = LANGS.find(l => l.display === textLang);

  // Stats
  const [stats, setStats] = useState<DetailedStats | null>(null);
  // Compteur d'images localisées pour la langue d'image sélectionnée
  const [locImg, setLocImg] = useState<{ count: number; total: number } | null>(null);

  // Scryfall import
  const [importing, setImporting]   = useState(false);
  const [importProg, setImportProg] = useState<ImportProgress | null>(null);
  const importUnlistenRef           = useRef<UnlistenFn | null>(null);

  // FR image enrichment
  const [enriching, setEnriching] = useState(false);
  const [progress, setProgress]   = useState<EnrichProgress | null>(null);
  const unlistenRef               = useRef<UnlistenFn | null>(null);

  // MTGA local sync
  const [mtgaPath, setMtgaPath]         = useState<string>(() =>
    localStorage.getItem("mtga_data_path") ?? ""
  );
  const [mtgaScan, setMtgaScan]         = useState<MtgaScanResult | null>(null);
  const [mtgaScanning, setMtgaScanning] = useState(false);
  const [mtgaSyncing, setMtgaSyncing]   = useState(false);
  const [mtgaProgress, setMtgaProgress] = useState<MtgaSyncProgress | null>(null);
  const mtgaUnlistenRef                 = useRef<UnlistenFn | null>(null);

  // Collection
  const [collReading, setCollReading] = useState(false);
  const [collInfo, setCollInfo]       = useState<{ total_unique: number } | null>(null);

  // Behavior
  const [persistFilters, setPersistFilters] = useState(() =>
    localStorage.getItem("settings_persist_filters") === "true"
  );

  // ── Data loaders ────────────────────────────────────────────────────────────
  const loadStats = async () => {
    try {
      const s = await invoke<DetailedStats>("get_detailed_stats");
      setStats(s);
    } catch (err) {
      onToast?.(t("toast.error", { msg: String(err) }), "error");
    }
  };

  useEffect(() => { loadStats(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Charge le nombre d'images localisées pour la langue d'image sélectionnée
  const loadLocImg = async (mtgaCode: string) => {
    try {
      const r = await invoke<{ count: number; total: number }>("get_localized_image_count", { langCode: mtgaCode });
      setLocImg(r);
    } catch { setLocImg(null); }
  };
  useEffect(() => {
    if (imageLangMeta) loadLocImg(imageLangMeta.mtga);
  }, [imageLang]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Event listeners ─────────────────────────────────────────────────────────
  useEffect(() => {
    let fn: UnlistenFn | null = null;
    listen<EnrichProgress>("enrich-fr-progress", (e) => {
      setProgress(e.payload);
      if (e.payload.done) {
        setEnriching(false);
        if (e.payload.error) onToast?.(t("toast.error", { msg: e.payload.error }), "error");
        else { onToast?.(t("set.imagesDownloaded", { count: e.payload.total_updated }), "success"); loadStats(); onStatsRefresh?.(); if (imageLangMeta) loadLocImg(imageLangMeta.mtga); }
      }
    }).then(f => { fn = f; unlistenRef.current = f; });
    return () => { fn?.(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let fn: UnlistenFn | null = null;
    listen<ImportProgress>("import-progress", (e) => {
      setImportProg(e.payload);
      if (e.payload.done) {
        setImporting(false);
        if (e.payload.error) onToast?.(t("toast.error", { msg: e.payload.error }), "error");
        else { onToast?.(t("set.cardsImportedToast", { count: e.payload.cards_imported.toLocaleString() }), "success"); loadStats(); onStatsRefresh?.(); }
      }
    }).then(f => { fn = f; importUnlistenRef.current = f; });
    return () => { fn?.(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let fn: UnlistenFn | null = null;
    listen<MtgaSyncProgress>("mtga-sync-progress", (e) => {
      setMtgaProgress(e.payload);
      if (e.payload.done) {
        setMtgaSyncing(false);
        if (e.payload.error) onToast?.(t("toast.error", { msg: e.payload.error }), "error");
        else {
          onToast?.(t("set.translationsUpdated", { count: e.payload.cards_updated.toLocaleString() }), "success");
          loadStats();
          onStatsRefresh?.();
        }
      }
    }).then(f => { fn = f; mtgaUnlistenRef.current = f; });
    return () => { fn?.(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Handlers ─────────────────────────────────────────────────────────────────
  const handleImport = async () => {
    setImporting(true); setImportProg(null);
    try { await invoke("import_cards_from_scryfall"); }
    catch (err) { setImporting(false); onToast?.(t("toast.error", { msg: String(err) }), "error"); }
  };

  const handleEnrich = async () => {
    setEnriching(true); setProgress(null);
    const mtgaLangCode = LANGS.find(l => l.display === imageLang)?.mtga ?? "frFR";
    try { await invoke("enrich_loc_images", { langCode: mtgaLangCode }); }
    catch (err) { setEnriching(false); onToast?.(t("toast.error", { msg: String(err) }), "error"); }
  };

  const saveMtgaPath = (val: string) => {
    setMtgaPath(val);
    localStorage.setItem("mtga_data_path", val);
    setMtgaScan(null);
    setMtgaProgress(null);
  };

  const handleBrowse = async () => {
    const selected = await openDialog({ directory: true, multiple: false, title: t("set.mtgaFolderTitle") });
    if (selected && typeof selected === "string") saveMtgaPath(selected);
  };

  const handleMtgaScan = async () => {
    if (!mtgaPath.trim()) return;
    setMtgaScanning(true); setMtgaScan(null);
    try {
      const result = await invoke<MtgaScanResult>("scan_mtga_folder", { folderPath: mtgaPath.trim() });
      setMtgaScan(result);
    } catch (err) {
      onToast?.(`${err}`, "error");
    } finally { setMtgaScanning(false); }
    // (erreur scan affichée brute : message backend)
  };

  const handleMtgaSync = async () => {
    if (!mtgaPath.trim() || mtgaSyncing) return;
    setMtgaSyncing(true); setMtgaProgress(null);
    try { await invoke("sync_loc_from_mtga", { folderPath: mtgaPath.trim(), langCode: mtgaCode }); }
    catch { setMtgaSyncing(false); }
  };

  const handleReadCollection = async () => {
    setCollReading(true); setCollInfo(null);
    try {
      const result = await invoke<{ cards: Record<string, number>; total_unique: number }>(
        "read_collection_from_memory", {}
      );
      const saved = await invoke<number>("save_collection", { cardsJson: JSON.stringify(result.cards) });
      setCollInfo({ total_unique: saved });
      onToast?.(t("set.collectionDone", { count: saved.toLocaleString() }), "success");
    } catch (err) {
      onToast?.(`${err}`, "error");
    } finally { setCollReading(false); }
  };

  const handleTogglePersist = (on: boolean) => {
    setPersistFilters(on);
    localStorage.setItem("settings_persist_filters", String(on));
    if (!on) Object.keys(localStorage).filter(k => k.startsWith("deck_state_")).forEach(k => localStorage.removeItem(k));
  };

  // ── Labels / progress helpers ────────────────────────────────────────────────
  const importStageLabel = () => {
    if (!importProg) return t("prog.init");
    switch (importProg.stage) {
      case "fetch_url":   return t("prog.fetchUrl");
      case "download":    return t("prog.download", { dl: importProg.downloaded_mb.toFixed(0), total: importProg.total_mb > 0 ? importProg.total_mb.toFixed(0) : "?" });
      case "parse":       return t("prog.parse");
      case "import":      return t("prog.import", { count: importProg.cards_imported.toLocaleString() });
      case "rebuild_fts": return t("prog.rebuildFts");
      case "done":        return t("prog.importDone", { count: importProg.cards_imported.toLocaleString() });
      default:            return t("prog.inProgress");
    }
  };

  const importPct = () => {
    if (!importProg || importProg.total_mb === 0) return 5;
    switch (importProg.stage) {
      case "fetch_url":   return 2;
      case "download":    return Math.max(5, Math.min(50, (importProg.downloaded_mb / importProg.total_mb) * 50));
      case "parse":       return 55;
      case "import":      return 60 + Math.min(30, (importProg.cards_imported / 25000) * 30);
      case "rebuild_fts": return 93;
      case "done":        return 100;
      default:            return 5;
    }
  };

  const mtgaSyncLabel = () => {
    if (!mtgaProgress) return t("prog.init");
    switch (mtgaProgress.stage) {
      case "scan":   return t("prog.syncScan");
      case "parse":  return t("prog.syncParse");
      case "update": {
        const { cards_found: f, cards_updated: u } = mtgaProgress;
        return f > 0 && u > 0
          ? t("prog.syncUpdate", { done: u.toLocaleString(), total: f.toLocaleString() })
          : t("prog.syncUpdateFound", { count: f.toLocaleString() });
      }
      case "done":   return t("prog.syncDone", { count: mtgaProgress.cards_updated.toLocaleString() });
      case "error":  return t("prog.syncError", { msg: String(mtgaProgress.error) });
      default:       return t("prog.inProgress");
    }
  };

  const mtgaSyncPct = () => {
    if (!mtgaProgress) return 5;
    switch (mtgaProgress.stage) {
      case "scan":   return 10;
      case "parse":  return 35;
      case "update": {
        const { cards_found: f, cards_updated: d } = mtgaProgress;
        return f > 0 && d > 0 ? 35 + Math.round((d / f) * 60) : 40;
      }
      case "done":   return 100;
      default:       return 5;
    }
  };

  // Langues disponibles dans les fichiers MTGA scannés (toutes par défaut)
  const availableMtgaCodes = mtgaScan
    ? new Set(LANGS.filter(l => mtgaScan.loc_files.some(f => f.includes(`_${l.mtga}_`))).map(l => l.mtga))
    : null; // null = pas encore scanné → on affiche toutes

  const locImgPct = locImg && locImg.total > 0
    ? ((locImg.count / locImg.total) * 100).toFixed(1) : "0.0";

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className={styles.container}>

      {/* Header */}
      <div className={styles.header}>
        <h2 className={styles.title}>⚙ {t("set.title")}</h2>
        {onClose && (
          <button className={styles.closeBtn} onClick={onClose} title={t("set.close")}>✕</button>
        )}
      </div>

      <div className={styles.content}>

        {/* ── 1. Langue de l'application ── */}
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{t("set.appLang")}</h3>
          <div className={styles.appLangRow}>
            <FlagSelect
              value={uiLang}
              options={UI_LANG_OPTIONS}
              onChange={handleUiLangChange}
            />
          </div>
        </section>

        {/* ── 2. Base de données Scryfall ── */}
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{t("set.scryfallDb")}</h3>

          {/* Stats */}
          {stats ? (
            <div className={styles.statsGrid}>
              <StatRow label={t("set.cardsMtga")} value={stats.total_cards.toLocaleString()} />
              <StatRow label={t("set.decks")}     value={stats.total_decks.toLocaleString()} />
              <StatRow label={t("set.combos")}    value={stats.total_combos.toLocaleString()} />
              <StatRow label={t("set.dbSize")}    value={`${stats.db_size_mb.toFixed(1)} MB`} />
            </div>
          ) : (
            <p className={styles.loading}>{t("set.loading")}</p>
          )}

          {/* Import */}
          <div className={styles.importRow}>
            <div className={styles.importMeta}>
              <span className={styles.importMetaItem}>~350 MB</span>
              <span className={styles.importMetaItem}>{t("set.connectionReq")}</span>
            </div>
            <button className="btn-primary" onClick={handleImport} disabled={importing || enriching}>
              {importing ? t("set.importing") : t("set.updateDb")}
            </button>
          </div>

          {(importing || importProg?.done) && (
            <div className={styles.enrichProgress}>
              <div className={styles.enrichProgressBar}>
                <div className={styles.enrichProgressFill} style={{ width: `${importPct()}%` }} />
              </div>
              <span className={styles.enrichProgressText}>{importStageLabel()}</span>
            </div>
          )}

          {/* Images localisées */}
          <div className={styles.mtgaSubSection}>
            <h4 className={styles.mtgaSubTitle}>{t("set.localizedImages")}</h4>
            <p className={styles.sectionDesc}>{t("set.localizedImagesDesc")}</p>

            <div className={styles.langDropdownRow}>
              <FlagSelect
                value={imageLang}
                options={LANGS.map(l => ({ value: l.display, label: l.label, fi: l.fi }))}
                onChange={handleImageLangChange}
              />

              {locImg && locImg.count > 0 ? (
                <div className={styles.langDropdownStatus}>
                  <div className={styles.progressBar} style={{ marginBottom: 3 }}>
                    <div className={styles.progressFill} style={{ width: `${locImgPct}%` }} />
                  </div>
                  <span className={styles.langStat}>
                    {t("set.images")} : {locImgPct}%
                    &nbsp;({locImg.count.toLocaleString()} / {locImg.total.toLocaleString()})
                  </span>
                </div>
              ) : (
                <span className={styles.langDropdownHint}>
                  {t("set.downloadImagesHint", { lang: imageLangMeta?.label ?? imageLang })}
                </span>
              )}
            </div>

            <div className={styles.langDropdownActions}>
              <button
                className="btn-primary"
                onClick={handleEnrich}
                disabled={enriching || importing}
              >
                {enriching ? t("set.downloading") : (
                  <>{t("set.downloadImages")} <span className={`fi fi-${imageLangMeta?.fi ?? "un"}`}
                    style={{ marginLeft: 4, borderRadius: 2 }} /> {imageLangMeta?.label ?? ""}</>
                )}
              </button>
            </div>

            {(enriching || progress?.done) && progress && (
              <div className={styles.enrichProgress}>
                <div className={styles.enrichProgressBar}>
                  <div
                    className={styles.enrichProgressFill}
                    style={{ width: progress.done ? "100%" : `${Math.min(progress.page * 2, 95)}%` }}
                  />
                </div>
                <span className={styles.enrichProgressText}>
                  {progress.done
                    ? t("prog.imageDone", { count: progress.total_updated.toLocaleString() })
                    : t("prog.imagePage", { page: progress.page, count: progress.total_updated.toLocaleString() })}
                </span>
              </div>
            )}
          </div>
        </section>

        {/* ── 3. Données MTGA locales ── */}
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{t("set.mtgaData")}</h3>
          <p className={styles.sectionDesc}>{t("set.mtgaDataDesc")}</p>

          <div className={styles.infoBox}>
            <p style={{ margin: 0 }}>
              <strong>{t("set.folderToSet")}</strong> (📁) :<br />
              <span style={{ marginTop: 4, display: "block" }}>
                Steam (2024+)&nbsp;: <code style={{ fontSize: 11 }}>…\Steam\steamapps\common\MTGA\MTGA_Data\Downloads\Raw</code><br />
                Standalone&nbsp;: <code style={{ fontSize: 11 }}>…\Wizards of the Coast\MTGA\MTGA_Data\Downloads\Raw</code>
              </span>
              <span style={{ marginTop: 4, display: "block", opacity: 0.7 }}>
                {t("set.oldVersion")} <code style={{ fontSize: 11 }}>Raw</code> {t("set.by")} <code style={{ fontSize: 11 }}>Data</code>
              </span>
            </p>
          </div>

          {/* Path picker */}
          <div className={styles.pathRow}>
            <input
              className={styles.pathInput}
              type="text"
              placeholder={t("set.pathPlaceholder")}
              value={mtgaPath}
              onChange={e => saveMtgaPath(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleMtgaScan(); }}
            />
            <button className="btn-ghost" onClick={handleBrowse} title={t("set.chooseFolder")}>📁</button>
            <button
              className="btn-ghost"
              onClick={handleMtgaScan}
              disabled={mtgaScanning || !mtgaPath.trim()}
            >
              {mtgaScanning ? "…" : t("set.scan")}
            </button>
          </div>

          {/* Scan result */}
          {mtgaScan && (
            <div className={`${styles.scanResult} ${mtgaScan.ready ? styles.scanOk : styles.scanWarn}`}>
              {mtgaScan.ready ? (
                <>
                  <span className={styles.scanIcon}>✓</span>
                  <div className={styles.scanInfo}>
                    <span className={styles.scanPath}>{mtgaScan.data_dir}</span>
                    <span className={styles.scanDetail}>
                      {mtgaScan.cards_file} · {t("set.langsDetected", { count: mtgaScan.loc_files.length })}
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <span className={styles.scanIcon}>⚠</span>
                  <div className={styles.scanInfo}>
                    <span>{t("set.filesNotFound")}</span>
                    <span className={styles.scanDetail}>{t("set.navigateRaw")}</span>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Traductions */}
          <div className={styles.mtgaSubSection}>
            <h4 className={styles.mtgaSubTitle}>{t("set.translations")}</h4>
            <p className={styles.sectionDesc}>{t("set.translationsDesc")}</p>
            <div className={styles.langDropdownRow}>
              <FlagSelect
                value={textLang}
                options={LANGS.map(l => {
                  const available = !availableMtgaCodes || availableMtgaCodes.has(l.mtga);
                  return {
                    value: l.display,
                    label: l.label,
                    fi: l.fi,
                    disabled: !available,
                    hint: available ? undefined : t("set.notDetected"),
                  };
                })}
                onChange={handleTextLangChange}
              />
            </div>
            <div className={styles.langDropdownActions}>
              <button
                className="btn-primary"
                onClick={handleMtgaSync}
                disabled={mtgaSyncing || !mtgaPath.trim()}
              >
                {mtgaSyncing ? t("set.syncing") : (
                  <>{t("set.sync")} <span className={`fi fi-${textLangMeta?.fi ?? "un"}`}
                    style={{ marginLeft: 4, borderRadius: 2 }} /> {textLangMeta?.label ?? ""}</>
                )}
              </button>
            </div>

            {(mtgaSyncing || mtgaProgress?.done) && (
              <div className={styles.enrichProgress}>
                <div className={styles.enrichProgressBar}>
                  <div className={styles.enrichProgressFill} style={{ width: `${mtgaSyncPct()}%` }} />
                </div>
                <span className={styles.enrichProgressText}>{mtgaSyncLabel()}</span>
              </div>
            )}
          </div>
        </section>

        {/* ── 4. Ma collection ── */}
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{t("set.myCollection")}</h3>
          <div className={styles.infoBox}>
            <p style={{ margin: 0 }}>
              <strong>{t("set.collectionPrereq")}</strong> {t("set.collectionMtgaRunning")}<br />
              {t("set.collectionSteps")}<br />
              <span style={{ marginTop: 4, display: "block", opacity: 0.8 }}>
                {t("set.collectionReadsMemory")}
              </span>
            </p>
          </div>
          <div className={styles.collRow}>
            {collInfo && (
              <span className={styles.collInfo}>
                {t("set.cardsImported", { count: collInfo.total_unique.toLocaleString() })}
              </span>
            )}
            <button
              className="btn-primary"
              onClick={handleReadCollection}
              disabled={collReading}
              style={{ flexShrink: 0 }}
            >
              {collReading ? t("set.reading") : t("set.syncCollection")}
            </button>
          </div>
        </section>

        {/* ── 5. Comportement ── */}
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{t("set.behavior")}</h3>
          <div className={styles.toggleRow}>
            <div className={styles.toggleInfo}>
              <span className={styles.toggleLabel}>{t("set.persistFilters")}</span>
              <span className={styles.toggleDesc}>
                {persistFilters ? t("set.persistFiltersOn") : t("set.persistFiltersOff")}
              </span>
            </div>
            <button
              className={`${styles.toggle} ${persistFilters ? styles.toggleOn : ""}`}
              onClick={() => handleTogglePersist(!persistFilters)}
              title={persistFilters ? t("set.disable") : t("set.enable")}
            >
              <span className={styles.toggleThumb} />
            </button>
          </div>
        </section>

        {/* ── 6. Thèmes ── */}
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{t("set.themes")}</h3>
          <p className={styles.sectionDesc}>{t("set.themesDesc")}</p>

          {/* Thème couleur — pastilles */}
          <label className={styles.themeLabel}>{t("set.themeColor")}</label>
          <div className={styles.themeSwatchRow}>
            {COLOR_THEMES.map((th) => (
              <button
                key={th.id}
                type="button"
                className={`${styles.themeSwatch} ${colorTheme === th.id ? styles.themeSwatchActive : ""}`}
                title={t(th.nameKey)}
                onClick={() => handleColorThemeChange(th.id)}
                style={{ background: th.vars["--bg-secondary"], borderColor: th.vars["--border"] }}
              >
                <span className={styles.themeSwatchDot} style={{ background: th.vars["--accent"] }} />
                <span className={styles.themeSwatchName} style={{ color: th.vars["--text-primary"] }}>{t(th.nameKey)}</span>
              </button>
            ))}
            {/* Thème perso */}
            <button
              type="button"
              className={`${styles.themeSwatch} ${colorTheme === CUSTOM_COLOR_ID ? styles.themeSwatchActive : ""}`}
              title={t(CUSTOM_COLOR_THEME.nameKey)}
              onClick={() => handleColorThemeChange(CUSTOM_COLOR_ID)}
              style={{ background: customVars["--bg-secondary"], borderColor: customVars["--border"] }}
            >
              <span className={styles.themeSwatchDot} style={{ background: customVars["--accent"] }} />
              <span className={styles.themeSwatchName} style={{ color: customVars["--text-primary"] }}>{t(CUSTOM_COLOR_THEME.nameKey)}</span>
            </button>
          </div>

          {/* Éditeur de couleurs — visible uniquement quand le thème perso est sélectionné */}
          {colorTheme === CUSTOM_COLOR_ID && (
            <div className={styles.themeCustomGrid}>
              {VAR_KEYS.map((key) => (
                <label key={key} className={styles.themeCustomRow}>
                  <input
                    type="color"
                    className={styles.themeCustomColor}
                    value={customVars[key] ?? "#000000"}
                    onChange={(e) => handleCustomVarChange(key, e.target.value)}
                  />
                  <span className={styles.themeCustomLabel}>{t(VAR_LABEL_KEYS[key])}</span>
                </label>
              ))}
            </div>
          )}

          {/* Thème police */}
          <label className={styles.themeLabel}>{t("set.themeFont")}</label>
          <div className={styles.themeFontRow}>
            {FONT_THEMES.map((ft) => (
              <button
                key={ft.id}
                type="button"
                className={`${styles.themeFontBtn} ${fontTheme === ft.id ? styles.themeFontBtnActive : ""}`}
                onClick={() => handleFontThemeChange(ft.id)}
                style={{ fontFamily: ft.family }}
              >
                {ft.nameKey ? t(ft.nameKey) : ft.label}
              </button>
            ))}
          </div>
        </section>

        {/* ── 7. À propos ── */}
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{t("set.about")}</h3>
          <div className={styles.aboutVersion}>
            <span className={styles.aboutAppName}>MTGA Deck Builder</span>
            <span className={styles.aboutVersionBadge}>v{APP_VERSION}</span>
          </div>
        </section>

      </div>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.statRow}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
    </div>
  );
}
