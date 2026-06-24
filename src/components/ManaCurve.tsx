import type { DeckCard } from "../types";
import styles from "./ManaCurve.module.css";

interface Props {
  cards: DeckCard[];
}

const MAX_CMC_SHOWN = 8; // 8+ regroupés ensemble

export default function ManaCurve({ cards }: Props) {
  // Exclut les terrains (CMC 0 ET type "Land") du calcul
  const nonLands = cards.filter(
    (dc) => !dc.card.type_line?.toLowerCase().includes("land")
  );

  // Compte les cartes par CMC (pondéré par quantité)
  const buckets: number[] = Array(MAX_CMC_SHOWN + 1).fill(0);
  for (const dc of nonLands) {
    const cmc = Math.min(Math.floor(dc.card.cmc ?? 0), MAX_CMC_SHOWN);
    buckets[cmc] += dc.quantity;
  }

  const maxCount = Math.max(...buckets, 1);
  const avgCmc = nonLands.length
    ? nonLands.reduce((s, dc) => s + (dc.card.cmc ?? 0) * dc.quantity, 0) /
      nonLands.reduce((s, dc) => s + dc.quantity, 0)
    : 0;

  const labels = ["0", "1", "2", "3", "4", "5", "6", "7+"];

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.title}>Courbe de mana</span>
        <span className={styles.avg}>CMC moy. {avgCmc.toFixed(2)}</span>
      </div>
      <div className={styles.bars}>
        {buckets.map((count, cmc) => (
          <div key={cmc} className={styles.column}>
            <span className={styles.count}>{count > 0 ? count : ""}</span>
            <div
              className={styles.bar}
              style={{ height: `${(count / maxCount) * 100}%` }}
              title={`CMC ${labels[cmc]} : ${count} carte${count > 1 ? "s" : ""}`}
            />
            <span className={styles.label}>{labels[cmc]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
