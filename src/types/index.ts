// ─── Types partagés entre tous les composants ─────────────────────────────────

export interface Card {
  id: string;
  oracle_id: string | null;
  name_en: string;
  name_fr: string | null;
  mana_cost: string | null;
  cmc: number;
  type_line: string | null;
  oracle_text: string | null;
  colors: string[];
  color_identity: string[];
  rarity: "common" | "uncommon" | "rare" | "mythic" | string;
  set_code: string | null;
  collector_number: string | null;
  image_uri_normal: string | null;
  image_uri_small: string | null;
  image_uri_art_crop: string | null;
  image_uri_fr: string | null;
  image_uri_back: string | null;
  layout: string | null;
  oracle_text_fr: string | null;
  type_line_fr: string | null;
  power: string | null;
  toughness: string | null;
  loyalty: string | null;
  keywords: string[];
  arena_id: number | null;
  owned_quantity?: number | null;
}

export interface Deck {
  id: number;
  name: string;
  format: string;
  description: string;
  created_at: string;
  updated_at: string;
  card_count: number;
  cover_image_url: string | null;
  color_identities: string[];
  is_favorite?: boolean;
  sort_order?: number;
}

export interface DeckCard {
  card: Card;
  quantity: number;
  board: "main" | "sideboard" | "commander";
}

export interface DeckWithCards {
  deck: Deck;
  cards: DeckCard[];
}

export interface DbStats {
  total_cards: number;
  cards_with_fr: number;
  cards_with_fr_images: number;
  total_decks: number;
  total_combos: number;
}

export interface CardFilters {
  colors?: string[];       // multi-sélection couleurs (OR logic), "C" = incolore
  multicolor?: boolean;    // uniquement cartes multicolores
  rarities?: string[];     // multi-sélection raretés (OR logic)
  card_types?: string[];   // multi-sélection types (OR logic)
  cmc_values?: number[];   // CMC exacts sélectionnés ; 7 = "≥ 7"
  set_codes?: string[];     // multi-sélection sets (OR logic)
  favorites_only?: boolean; // uniquement les cartes en favoris
  owned_only?: boolean;     // uniquement les cartes possédées (table collection MTGA)
  sort_by?: "name" | "cmc" | "rarity";
  legendary_only?: boolean;        // uniquement cartes légendaires (sélection commandant Brawl)
  commander_colors?: string[];     // color identity du commandant — filtre exclusif Brawl
}

// Symboles de mana → Unicode ou emoji
export const MANA_SYMBOLS: Record<string, string> = {
  W: "☀",
  U: "💧",
  B: "💀",
  R: "🔥",
  G: "🌲",
  C: "◇",
};

export const COLOR_NAMES: Record<string, string> = {
  W: "Blanc",
  U: "Bleu",
  B: "Noir",
  R: "Rouge",
  G: "Vert",
  C: "Incolore",
};

export const RARITY_COLORS: Record<string, string> = {
  common: "#c8c8c8",
  uncommon: "#b0c4de",
  rare: "#d4af37",
  mythic: "#ff6b35",
};

export type BoardType = "main" | "sideboard" | "commander";

export interface Combo {
  id: number;
  name: string;
  cards: string[];       // noms EN des cartes
  description: string;
  tags: string;
  source: string;        // "manual" | "commanderspellbook"
  created_at: string;
  is_favorite?: boolean;
}
