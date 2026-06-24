const SVG = "https://svgs.scryfall.io/card-symbols";

interface Props {
  cost: string;
  size?: number;
}

export default function ManaCost({ cost, size = 13 }: Props) {
  const symbols = cost.match(/\{[^}]+\}/g) ?? [];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 1, flexShrink: 0 }}>
      {symbols.map((sym, i) => (
        <img
          key={i}
          src={`${SVG}/${sym.slice(1, -1)}.svg`}
          alt={sym}
          width={size}
          height={size}
          style={{ display: "inline-block", verticalAlign: "middle", borderRadius: "50%" }}
        />
      ))}
    </span>
  );
}
