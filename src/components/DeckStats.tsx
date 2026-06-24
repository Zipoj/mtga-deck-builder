import type { DeckCard } from "../types";
import ManaCurve from "./ManaCurve";
import { useT } from "../I18nContext";
import styles from "./DeckStats.module.css";

interface Props {
  cards: DeckCard[];
}

const COLOR_DOT: Record<string, string> = {
  W: "#f2f0d3", U: "#4a90d9", B: "#9b59b6",
  R: "#e05a3a", G: "#3ab87c", C: "#999",
};

export default function DeckStats({ cards }: Props) {
  const t = useT();
  const main = cards.filter((c) => c.board === "main");
  const side = cards.filter((c) => c.board === "sideboard");

  const totalMain = main.reduce((s, c) => s + c.quantity, 0);
  const totalSide = side.reduce((s, c) => s + c.quantity, 0);

  // Comptage par type de carte
  const counts = { creature: 0, instant: 0, sorcery: 0, enchantment: 0,
                   artifact: 0, planeswalker: 0, land: 0, other: 0 };

  for (const dc of main) {
    const t = dc.card.type_line?.toLowerCase() ?? "";
    const q = dc.quantity;
    if (t.includes("creature"))       counts.creature      += q;
    else if (t.includes("instant"))   counts.instant       += q;
    else if (t.includes("sorcery"))   counts.sorcery       += q;
    else if (t.includes("enchantment")) counts.enchantment += q;
    else if (t.includes("artifact"))  counts.artifact      += q;
    else if (t.includes("planeswalker")) counts.planeswalker += q;
    else if (t.includes("land"))      counts.land          += q;
    else                              counts.other         += q;
  }

  // Distribution de couleurs (en termes d'identité)
  const colorCounts: Record<string, number> = {};
  for (const dc of main) {
    for (const c of dc.card.color_identity) {
      colorCounts[c] = (colorCounts[c] ?? 0) + dc.quantity;
    }
    if (dc.card.color_identity.length === 0) {
      colorCounts["C"] = (colorCounts["C"] ?? 0) + dc.quantity;
    }
  }

  // Land count indépendant : inclut les cartes double-face (MDFC) qui ont "land"
  // dans leur type_line (ex: "Instant // Land", "Land Creature", etc.)
  const landCount = main.reduce((s, dc) => {
    const t = dc.card.type_line?.toLowerCase() ?? "";
    return t.includes("land") ? s + dc.quantity : s;
  }, 0);
  const landPct = totalMain > 0 ? Math.round((landCount / totalMain) * 100) : 0;

  const typeRows = [
    { tkey: "type.Creature",     key: "creature",      icon: "⚔" },
    { tkey: "type.Instant",      key: "instant",       icon: "⚡" },
    { tkey: "type.Sorcery",      key: "sorcery",       icon: "📜" },
    { tkey: "type.Enchantment",  key: "enchantment",   icon: "✨" },
    { tkey: "type.Artifact",     key: "artifact",      icon: "⚙" },
    { tkey: "type.Planeswalker", key: "planeswalker",  icon: "🌟" },
    { tkey: "type.Land",         key: "land",          icon: "🗺" },
  ] as const;

  return (
    <div className={styles.container}>
      {/* Compteurs principaux */}
      <div className={styles.totals}>
        <div className={styles.totalBox}>
          <span className={styles.totalNum}>{totalMain}</span>
          <span className={styles.totalLabel}>{t("stats.mainDeck")}</span>
        </div>
        {totalSide > 0 && (
          <div className={styles.totalBox}>
            <span className={styles.totalNum}>{totalSide}</span>
            <span className={styles.totalLabel}>{t("stats.sideboard")}</span>
          </div>
        )}
      </div>

      {/* % Terrains */}
      {landCount > 0 && (
        <div className={styles.landStatRow}>
          <span className={styles.landIcon}>🏔</span>
          <div className={styles.landBarWrap}>
            <div
              className={styles.landBarFill}
              style={{ width: `${landPct}%` }}
            />
          </div>
          <span className={styles.landFraction}>{landCount}/{totalMain}</span>
          <span className={styles.landPct}>{landPct}%</span>
        </div>
      )}

      {/* Courbe de mana */}
      <ManaCurve cards={main} />

      {/* Répartition par type */}
      <div className={styles.section}>
        <span className={styles.sectionTitle}>{t("stats.types")}</span>
        {typeRows.map(({ tkey, key, icon }) =>
          counts[key] > 0 ? (
            <div key={key} className={styles.typeRow}>
              <span className={styles.typeIcon}>{icon}</span>
              <span className={styles.typeLabel}>{t(tkey)}</span>
              <div className={styles.typeBar}>
                <div
                  className={styles.typeBarFill}
                  style={{ width: `${(counts[key] / totalMain) * 100}%` }}
                />
              </div>
              <span className={styles.typeCount}>{counts[key]}</span>
            </div>
          ) : null
        )}
      </div>

      {/* Couleurs */}
      {Object.keys(colorCounts).length > 0 && (
        <div className={styles.section}>
          <span className={styles.sectionTitle}>{t("stats.colors")}</span>
          <div className={styles.colorRow}>
            {Object.entries(colorCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([color, count]) => (
                <div key={color} className={styles.colorPip} title={t(`color.${color}`)}>
                  <div
                    className={styles.colorDot}
                    style={{ background: COLOR_DOT[color] ?? "#888" }}
                  />
                  <span className={styles.colorCount}>{count}</span>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* Avertissement taille deck : uniquement si sous le minimum (dépasser 60 est OK, max mémoire MTGA ≈ 250) */}
      {totalMain > 0 && totalMain < 60 && totalMain !== 40 && (
        <div className={styles.warning}>
          ⚠ {t("decklist.cardsMissing", { count: 60 - totalMain })} {t("stats.deckSizeStd")}
        </div>
      )}
    </div>
  );
}
