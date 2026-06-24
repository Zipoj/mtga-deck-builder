use rusqlite::{Connection, Result, params};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Chemin vers la base de données, partagé via l'état Tauri
pub struct DbPath(pub PathBuf);

/// Représentation d'une carte MTGA (côté Rust)
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Card {
    pub id: String,
    pub oracle_id: Option<String>,
    pub name_en: String,
    pub name_fr: Option<String>,
    pub mana_cost: Option<String>,
    pub cmc: f64,
    pub type_line: Option<String>,
    pub oracle_text: Option<String>,
    pub colors: Vec<String>,        // JSON array stocké en TEXT
    pub color_identity: Vec<String>,
    pub rarity: Option<String>,
    pub set_code: Option<String>,
    pub collector_number: Option<String>,
    pub image_uri_normal: Option<String>,
    pub image_uri_small: Option<String>,
    pub image_uri_art_crop: Option<String>,
    pub image_uri_fr: Option<String>,
    pub oracle_text_fr: Option<String>,
    pub type_line_fr: Option<String>,
    pub power: Option<String>,
    pub toughness: Option<String>,
    pub loyalty: Option<String>,
    pub keywords: Vec<String>,
    pub arena_id: Option<i64>,
    pub owned_quantity: Option<i64>,
    pub layout: Option<String>,
    pub image_uri_back: Option<String>,
}

/// Un deck sans ses cartes
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Deck {
    pub id: i64,
    pub name: String,
    pub format: String,
    pub description: String,
    pub created_at: String,
    pub updated_at: String,
    /// Nombre total de cartes dans le mainboard (0 si vide)
    pub card_count: i64,
    /// URL de l'image de couverture (art crop d'une carte choisie)
    pub cover_image_url: Option<String>,
    /// Identités de couleur du deck (W/U/B/R/G) déduites des cartes
    pub color_identities: Vec<String>,
    /// Deck mis en favori par l'utilisateur
    pub is_favorite: bool,
    /// Ordre d'affichage dans la liste
    pub sort_order: i64,
}

/// Une carte dans un deck (avec quantité et zone)
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DeckCard {
    pub card: Card,
    pub quantity: i32,
    pub board: String, // "main", "sideboard", "commander"
}

/// Un deck avec toutes ses cartes
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DeckWithCards {
    pub deck: Deck,
    pub cards: Vec<DeckCard>,
}

/// Statistiques de la base de données
#[derive(Debug, Serialize, Deserialize)]
pub struct DbStats {
    pub total_cards: i64,
    pub cards_with_fr: i64,
    pub cards_with_fr_images: i64,
    pub total_decks: i64,
    pub total_combos: i64,
}

/// Initialise la DB : crée les tables si elles n'existent pas encore
pub fn init_db(db_path: &Path) -> Result<()> {
    let conn = Connection::open(db_path)?;

    conn.execute_batch("PRAGMA journal_mode=WAL;")?; // meilleure performance en lecture/écriture concurrente
    conn.execute_batch("PRAGMA foreign_keys=ON;")?;

    conn.execute_batch("
        -- Table principale des cartes
        CREATE TABLE IF NOT EXISTS cards (
            id               TEXT PRIMARY KEY,
            oracle_id        TEXT,
            name_en          TEXT NOT NULL,
            name_fr          TEXT,
            mana_cost        TEXT,
            cmc              REAL DEFAULT 0,
            type_line        TEXT,
            oracle_text      TEXT,
            colors           TEXT DEFAULT '[]',
            color_identity   TEXT DEFAULT '[]',
            rarity           TEXT,
            set_code         TEXT,
            collector_number TEXT,
            image_uri_normal TEXT,
            image_uri_small  TEXT,
            image_uri_art_crop TEXT,
            power            TEXT,
            toughness        TEXT,
            loyalty          TEXT,
            keywords         TEXT DEFAULT '[]',
            arena_id         INTEGER,
            released_at      TEXT
        );

        -- Index pour accélérer les recherches fréquentes
        CREATE INDEX IF NOT EXISTS idx_cards_oracle_id ON cards(oracle_id);
        CREATE INDEX IF NOT EXISTS idx_cards_rarity     ON cards(rarity);
        CREATE INDEX IF NOT EXISTS idx_cards_set        ON cards(set_code);
        CREATE INDEX IF NOT EXISTS idx_cards_cmc        ON cards(cmc);

        -- Recherche plein texte bilingue (FTS5)
        CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(
            name_en,
            name_fr,
            type_line,
            oracle_text,
            content='cards',
            content_rowid='rowid'
        );

        -- Trigger pour maintenir l'index FTS à jour à l'insertion
        CREATE TRIGGER IF NOT EXISTS cards_ai AFTER INSERT ON cards BEGIN
            INSERT INTO cards_fts(rowid, name_en, name_fr, type_line, oracle_text)
            VALUES (new.rowid, new.name_en, new.name_fr, new.type_line, new.oracle_text);
        END;

        -- Trigger à la suppression
        CREATE TRIGGER IF NOT EXISTS cards_ad AFTER DELETE ON cards BEGIN
            INSERT INTO cards_fts(cards_fts, rowid, name_en, name_fr, type_line, oracle_text)
            VALUES ('delete', old.rowid, old.name_en, old.name_fr, old.type_line, old.oracle_text);
        END;

        -- Trigger à la mise à jour
        CREATE TRIGGER IF NOT EXISTS cards_au AFTER UPDATE ON cards BEGIN
            INSERT INTO cards_fts(cards_fts, rowid, name_en, name_fr, type_line, oracle_text)
            VALUES ('delete', old.rowid, old.name_en, old.name_fr, old.type_line, old.oracle_text);
            INSERT INTO cards_fts(rowid, name_en, name_fr, type_line, oracle_text)
            VALUES (new.rowid, new.name_en, new.name_fr, new.type_line, new.oracle_text);
        END;

        -- Table des decks
        CREATE TABLE IF NOT EXISTS decks (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            format      TEXT DEFAULT 'standard',
            description TEXT DEFAULT '',
            created_at  TEXT DEFAULT (datetime('now')),
            updated_at  TEXT DEFAULT (datetime('now'))
        );

        -- Table des combos
        CREATE TABLE IF NOT EXISTS combos (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL DEFAULT '',
            cards       TEXT DEFAULT '[]',
            description TEXT DEFAULT '',
            tags        TEXT DEFAULT '',
            source      TEXT DEFAULT 'manual',
            created_at  TEXT DEFAULT (datetime('now'))
        );

        -- Table de liaison deck ↔ cartes
        CREATE TABLE IF NOT EXISTS deck_cards (
            deck_id  INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
            card_id  TEXT    NOT NULL REFERENCES cards(id),
            quantity INTEGER DEFAULT 1,
            board    TEXT    DEFAULT 'main',
            PRIMARY KEY (deck_id, card_id, board)
        );

        -- Table des favoris (cartes bookmarkées)
        CREATE TABLE IF NOT EXISTS favorites (
            card_id  TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
            added_at TEXT DEFAULT (datetime('now'))
        );
    ")?;

    // Table de configuration interne pour tracker l'état de l'index FTS5
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _config (key TEXT PRIMARY KEY, value TEXT);"
    )?;

    // Migrations — ALTER TABLE ne supporte pas IF NOT EXISTS, on ignore les erreurs
    let _ = conn.execute("ALTER TABLE cards ADD COLUMN image_uri_fr TEXT", []);
    let _ = conn.execute("ALTER TABLE cards ADD COLUMN oracle_text_fr TEXT", []);
    let _ = conn.execute("ALTER TABLE cards ADD COLUMN type_line_fr TEXT", []);
    let _ = conn.execute("ALTER TABLE decks ADD COLUMN cover_image_url TEXT", []);
    let _ = conn.execute("ALTER TABLE decks ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE decks ADD COLUMN sort_order  INTEGER NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE combos ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE cards ADD COLUMN released_at TEXT", []);
    // Cartes double-face / transform : layout Scryfall + image de la face arrière
    let _ = conn.execute("ALTER TABLE cards ADD COLUMN layout TEXT", []);
    let _ = conn.execute("ALTER TABLE cards ADD COLUMN image_uri_back TEXT", []);

    // ── Migration FTS5 v2 : ajout de oracle_text_fr dans l'index plein-texte ─
    // FTS5 ne supporte pas ALTER TABLE, on recrée la table virtuelle + triggers.
    let fts_v2: bool = conn.query_row(
        "SELECT value FROM _config WHERE key = 'fts_v2_built'",
        [],
        |r| r.get::<_, String>(0).map(|v| v == "1"),
    ).unwrap_or(false);

    if !fts_v2 {
        println!("[DB] Migration FTS5 v2 : ajout de oracle_text_fr…");
        conn.execute_batch("
            DROP TRIGGER IF EXISTS cards_ai;
            DROP TRIGGER IF EXISTS cards_ad;
            DROP TRIGGER IF EXISTS cards_au;
            DROP TABLE IF EXISTS cards_fts;

            CREATE VIRTUAL TABLE cards_fts USING fts5(
                name_en, name_fr, type_line, oracle_text, oracle_text_fr,
                content='cards', content_rowid='rowid'
            );

            CREATE TRIGGER cards_ai AFTER INSERT ON cards BEGIN
                INSERT INTO cards_fts(rowid, name_en, name_fr, type_line, oracle_text, oracle_text_fr)
                VALUES (new.rowid, new.name_en, new.name_fr, new.type_line, new.oracle_text, new.oracle_text_fr);
            END;

            CREATE TRIGGER cards_ad AFTER DELETE ON cards BEGIN
                INSERT INTO cards_fts(cards_fts, rowid, name_en, name_fr, type_line, oracle_text, oracle_text_fr)
                VALUES ('delete', old.rowid, old.name_en, old.name_fr, old.type_line, old.oracle_text, old.oracle_text_fr);
            END;

            CREATE TRIGGER cards_au AFTER UPDATE ON cards BEGIN
                INSERT INTO cards_fts(cards_fts, rowid, name_en, name_fr, type_line, oracle_text, oracle_text_fr)
                VALUES ('delete', old.rowid, old.name_en, old.name_fr, old.type_line, old.oracle_text, old.oracle_text_fr);
                INSERT INTO cards_fts(rowid, name_en, name_fr, type_line, oracle_text, oracle_text_fr)
                VALUES (new.rowid, new.name_en, new.name_fr, new.type_line, new.oracle_text, new.oracle_text_fr);
            END;

            INSERT INTO cards_fts(cards_fts) VALUES('rebuild');
        ")?;
        conn.execute(
            "INSERT OR REPLACE INTO _config (key, value) VALUES ('fts_v2_built', '1')",
            [],
        )?;
        conn.execute(
            "INSERT OR REPLACE INTO _config (key, value) VALUES ('fts_built', '1')",
            [],
        )?;
        println!("[DB] FTS5 v2 reconstruit.");
    }

    // Reconstruction FTS5 initiale (si DB peuplée avant que FTS n'existe)
    let cards_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM cards", [], |r| r.get(0),
    ).unwrap_or(0);

    let fts_built: bool = conn.query_row(
        "SELECT value FROM _config WHERE key = 'fts_built'",
        [],
        |r| r.get::<_, String>(0).map(|v| v == "1"),
    ).unwrap_or(false);

    if cards_count > 0 && !fts_built {
        println!("[DB] Reconstruction de l'index FTS5 ({} cartes)…", cards_count);
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")?;
        conn.execute(
            "INSERT OR REPLACE INTO _config (key, value) VALUES ('fts_built', '1')",
            [],
        )?;
        println!("[DB] Index FTS5 reconstruit.");
    }

    // ── card_translations : stockage multilingue sans re-sync ─────────────────
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS card_translations (
            card_id     TEXT NOT NULL,
            lang        TEXT NOT NULL,
            name        TEXT,
            oracle_text TEXT,
            type_line   TEXT,
            PRIMARY KEY (card_id, lang)
        );
        CREATE INDEX IF NOT EXISTS idx_ct_lang ON card_translations(lang);
    ")?;

    // Migration one-shot : copie les données frFR depuis les colonnes _fr
    let ct_migrated: bool = conn.query_row(
        "SELECT value FROM _config WHERE key = 'card_translations_migrated'",
        [], |r| r.get::<_, String>(0).map(|v| v == "1"),
    ).unwrap_or(false);

    if !ct_migrated {
        let fr_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM cards WHERE name_fr IS NOT NULL AND name_fr != ''",
            [], |r| r.get(0),
        ).unwrap_or(0);
        if fr_count > 0 {
            println!("[DB] Migration card_translations : copie {} entrées frFR…", fr_count);
            conn.execute_batch(
                "INSERT OR IGNORE INTO card_translations (card_id, lang, name, oracle_text, type_line)
                 SELECT id, 'frFR', name_fr, oracle_text_fr, type_line_fr
                 FROM cards WHERE name_fr IS NOT NULL AND name_fr != '';"
            )?;
            println!("[DB] Migration card_translations terminée.");
        }
        conn.execute(
            "INSERT OR REPLACE INTO _config (key, value) VALUES ('card_translations_migrated', '1')",
            [],
        )?;
    }

    // ── card_images : stockage multilingue des URLs d'images ──────────────────
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS card_images (
            oracle_id TEXT NOT NULL,
            lang      TEXT NOT NULL,
            uri       TEXT NOT NULL,
            PRIMARY KEY (oracle_id, lang)
        );
        CREATE INDEX IF NOT EXISTS idx_ci_lang ON card_images(lang);
    ")?;

    // Migration one-shot : copie les images frFR depuis image_uri_fr
    let ci_migrated: bool = conn.query_row(
        "SELECT value FROM _config WHERE key = 'card_images_migrated'",
        [], |r| r.get::<_, String>(0).map(|v| v == "1"),
    ).unwrap_or(false);

    if !ci_migrated {
        let fr_img_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM cards WHERE oracle_id IS NOT NULL AND image_uri_fr IS NOT NULL AND image_uri_fr != ''",
            [], |r| r.get(0),
        ).unwrap_or(0);
        if fr_img_count > 0 {
            println!("[DB] Migration card_images : copie {} images frFR…", fr_img_count);
            conn.execute_batch(
                "INSERT OR IGNORE INTO card_images (oracle_id, lang, uri)
                 SELECT oracle_id, 'frFR', image_uri_fr
                 FROM cards WHERE oracle_id IS NOT NULL AND image_uri_fr IS NOT NULL AND image_uri_fr != '';"
            )?;
            println!("[DB] Migration card_images terminée.");
        }
        conn.execute(
            "INSERT OR REPLACE INTO _config (key, value) VALUES ('card_images_migrated', '1')",
            [],
        )?;
    }

    Ok(())
}

/// Ouvre une connexion à la DB (à appeler depuis chaque commande)
pub fn open(db_path: &Path) -> Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.execute_batch("PRAGMA foreign_keys=ON;")?;
    Ok(conn)
}

/// Construit un objet Card depuis une Row rusqlite
pub fn row_to_card(row: &rusqlite::Row) -> rusqlite::Result<Card> {
    let colors_str: String = row.get("colors").unwrap_or_else(|_| "[]".to_string());
    let color_identity_str: String = row.get("color_identity").unwrap_or_else(|_| "[]".to_string());
    let keywords_str: String = row.get("keywords").unwrap_or_else(|_| "[]".to_string());
    // Colonnes localisées injectées par LEFT JOIN card_translations (optionnelles)
    // Priorité : name_loc > name_fr (colonne de compatibilité frFR dans cards)
    let name_loc:        Option<String> = row.get("name_loc").unwrap_or(None);
    let oracle_text_loc: Option<String> = row.get("oracle_text_loc").unwrap_or(None);
    let type_line_loc:   Option<String> = row.get("type_line_loc").unwrap_or(None);
    // Image localisée injectée par LEFT JOIN card_images (optionnelle)
    // Priorité : image_loc > image_uri_fr (colonne de compatibilité frFR dans cards)
    let image_loc: Option<String> = row.get("image_loc").unwrap_or(None);

    Ok(Card {
        id:               row.get("id")?,
        oracle_id:        row.get("oracle_id")?,
        name_en:          row.get("name_en")?,
        name_fr:          name_loc.or_else(|| row.get("name_fr").unwrap_or(None)),
        mana_cost:        row.get("mana_cost")?,
        cmc:              row.get("cmc").unwrap_or(0.0),
        type_line:        row.get("type_line")?,
        oracle_text:      row.get("oracle_text")?,
        colors:           serde_json::from_str(&colors_str).unwrap_or_default(),
        color_identity:   serde_json::from_str(&color_identity_str).unwrap_or_default(),
        rarity:           row.get("rarity")?,
        set_code:         row.get("set_code")?,
        collector_number: row.get("collector_number")?,
        image_uri_normal: row.get("image_uri_normal")?,
        image_uri_small:  row.get("image_uri_small")?,
        image_uri_art_crop: row.get("image_uri_art_crop")?,
        image_uri_fr:     image_loc.or_else(|| row.get("image_uri_fr").unwrap_or(None)),
        oracle_text_fr:   oracle_text_loc.or_else(|| row.get("oracle_text_fr").unwrap_or(None)),
        type_line_fr:     type_line_loc.or_else(|| row.get("type_line_fr").unwrap_or(None)),
        power:            row.get("power")?,
        toughness:        row.get("toughness")?,
        loyalty:          row.get("loyalty")?,
        keywords:         serde_json::from_str(&keywords_str).unwrap_or_default(),
        arena_id:         row.get("arena_id")?,
        owned_quantity:   row.get("owned_quantity").unwrap_or(None),
        layout:           row.get("layout").unwrap_or(None),
        image_uri_back:   row.get("image_uri_back").unwrap_or(None),
    })
}

/// Recherche des cartes par nom (EN ou FR) avec FTS5, avec filtres multi-sélection
pub fn search_cards_query(
    conn: &Connection,
    query: &str,
    limit: i32,
    filters: &CardFilters,
    lang_code: &str,
    image_lang_code: &str,
) -> Result<Vec<Card>> {
    let query_trimmed = query.trim();

    // LEFT JOIN card_translations pour remplir les colonnes localisées (name_loc, type_line_loc)
    // lang_code sanitisé (alphanum seulement) pour interpolation SQL sûre
    let safe_lang: String = lang_code.chars().filter(|c| c.is_alphanumeric()).collect();
    let lang_join = format!(
        "LEFT JOIN card_translations ct ON c.id = ct.card_id AND ct.lang = '{safe_lang}'"
    );
    // LEFT JOIN card_images pour remplir image_loc (image dans la langue choisie)
    let safe_img_lang: String = image_lang_code.chars().filter(|c| c.is_alphanumeric()).collect();
    let img_join = format!(
        "LEFT JOIN card_images ci ON c.oracle_id = ci.oracle_id AND ci.lang = '{safe_img_lang}'"
    );

    // Couleurs valides (protection contre injection SQL)
    const VALID_COLORS: &[&str] = &["W", "U", "B", "R", "G", "C"];
    const VALID_RARITIES: &[&str] = &["common", "uncommon", "rare", "mythic"];

    let mut conditions = Vec::new();

    // ── Filtre couleurs : multi-sélection OR, "C" = incolore ────────────────
    if let Some(ref colors) = filters.colors {
        let valid: Vec<&str> = colors.iter()
            .filter_map(|c| VALID_COLORS.iter().find(|&&v| v == c.as_str()).copied())
            .collect();
        if !valid.is_empty() {
            let conds: Vec<String> = valid.iter().map(|c| {
                if *c == "C" {
                    // Incolore : color_identity est un tableau JSON vide
                    "json_array_length(c.color_identity) = 0".to_string()
                } else {
                    format!("c.color_identity LIKE '%\"{}\"%%'", c)
                }
            }).collect();
            conditions.push(format!("({})", conds.join(" OR ")));
        }
    }

    // ── Filtre multicolore (au moins 2 couleurs dans color_identity) ─────────
    if let Some(true) = filters.multicolor {
        conditions.push("json_array_length(c.color_identity) >= 2".to_string());
    }

    // ── Filtre raretés : multi-sélection OR ─────────────────────────────────
    if let Some(ref rarities) = filters.rarities {
        let valid: Vec<&str> = rarities.iter()
            .filter_map(|r| VALID_RARITIES.iter().find(|&&v| v == r.as_str()).copied())
            .collect();
        if !valid.is_empty() {
            let list: Vec<String> = valid.iter().map(|r| format!("'{}'", r)).collect();
            conditions.push(format!("c.rarity IN ({})", list.join(",")));
        }
    }

    // ── Filtre types multi-sélection (logique OR) + exclusion terrains par défaut ─────
    match filters.card_types.as_deref() {
        Some(types) if !types.is_empty() => {
            let parts: Vec<String> = types.iter().map(|t| {
                match t.as_str() {
                    "Land"      => "c.type_line LIKE '%Land%'".to_string(),
                    "Commander" => "(c.type_line LIKE '%Legendary%Creature%' OR c.type_line LIKE '%Legendary%Planeswalker%')".to_string(),
                    "Battle"    => "c.type_line LIKE '%Battle%'".to_string(),
                    other       => format!("c.type_line LIKE '%{}%'", other.replace('\'', "''")),
                }
            }).collect();
            conditions.push(format!("({})", parts.join(" OR ")));
        }
        _ => {
            // Pas de filtre type → exclure les terrains par défaut (comportement MTGA)
            conditions.push("(c.type_line IS NULL OR c.type_line NOT LIKE '%Land%')".to_string());
        }
    }

    // ── Filtre CMC multi-valeurs : valeur exacte ou ≥ 7 si val == 7 ─────────
    if let Some(ref cmc_vals) = filters.cmc_values {
        if !cmc_vals.is_empty() {
            let parts: Vec<String> = cmc_vals.iter().map(|&c| {
                if c >= 7 {
                    "c.cmc >= 7".to_string()
                } else {
                    format!("c.cmc = {}", c)
                }
            }).collect();
            conditions.push(format!("({})", parts.join(" OR ")));
        }
    }

    // ── Filtre sets (multi-sélection) ────────────────────────────────────────
    if let Some(ref set_codes) = filters.set_codes {
        if !set_codes.is_empty() {
            let placeholders: Vec<String> = set_codes
                .iter()
                .map(|s| format!("'{}'", s.replace('\'', "''")))
                .collect();
            conditions.push(format!("c.set_code IN ({})", placeholders.join(", ")));
        }
    }

    // ── Filtre favoris seulement ─────────────────────────────────────────────
    if let Some(true) = filters.favorites_only {
        conditions.push("c.id IN (SELECT card_id FROM favorites)".to_string());
    }

    // ── Filtre collection MTGA (cartes possédées) ────────────────────────────
    if let Some(true) = filters.owned_only {
        conditions.push("EXISTS (SELECT 1 FROM collection col WHERE col.arena_id = c.arena_id)".to_string());
    }

    // ── Filtre légendaire (mode Brawl : sélection commandant) ────────────────
    if let Some(true) = filters.legendary_only {
        conditions.push("c.type_line LIKE '%Legendary%'".to_string());
    }

    // ── Filtre identité de couleur du commandant (Brawl) ─────────────────────
    // Logique exclusive : card.color_identity ⊆ commander_colors (incolore toujours OK)
    if let Some(ref cmd_colors) = filters.commander_colors {
        const REAL_COLORS: &[&str] = &["W", "U", "B", "R", "G"];
        let valid: Vec<&str> = cmd_colors.iter()
            .filter_map(|c| REAL_COLORS.iter().find(|&&v| v == c.as_str()).copied())
            .collect();
        if valid.is_empty() {
            // Commandant incolore : uniquement les cartes incolores
            conditions.push("json_array_length(c.color_identity) = 0".to_string());
        } else {
            let allowed: Vec<String> = valid.iter().map(|c| format!("'{}'", c)).collect();
            conditions.push(format!(
                "NOT EXISTS (SELECT 1 FROM json_each(c.color_identity) ci_chk \
                 WHERE ci_chk.value NOT IN ({}))",
                allowed.join(",")
            ));
        }
    }

    let extra_where = if conditions.is_empty() {
        String::new()
    } else {
        format!("AND {}", conditions.join(" AND "))
    };

    // ── Clause ORDER BY ──────────────────────────────────────────────────────
    // Ordre couleur WUBRG : W=1, U=2, B=3, R=4, G=5, Multicolore=6, Incolore=7, Terrain=8
    let color_order = "CASE \
        WHEN c.type_line LIKE '%Land%' THEN 8 \
        WHEN json_array_length(c.color_identity) = 0 THEN 7 \
        WHEN json_array_length(c.color_identity) >= 2 THEN 6 \
        WHEN c.color_identity LIKE '%\"W\"%' THEN 1 \
        WHEN c.color_identity LIKE '%\"U\"%' THEN 2 \
        WHEN c.color_identity LIKE '%\"B\"%' THEN 3 \
        WHEN c.color_identity LIKE '%\"R\"%' THEN 4 \
        WHEN c.color_identity LIKE '%\"G\"%' THEN 5 \
        ELSE 7 END";

    let order_clause = match filters.sort_by.as_deref().unwrap_or("cmc") {
        "name" => "c.name_en ASC".to_string(),
        "rarity" => format!(
            "CASE c.rarity WHEN 'common' THEN 1 WHEN 'uncommon' THEN 2 \
             WHEN 'rare' THEN 3 WHEN 'mythic' THEN 4 ELSE 5 END ASC, \
             c.cmc ASC, {} ASC, c.name_en ASC",
            color_order
        ),
        // "cmc" = défaut MTGA : couleur WUBRG d'abord, puis CMC croissant, puis nom
        _ => format!("{} ASC, c.cmc ASC, c.name_en ASC", color_order),
    };

    // Filtre Arena uniquement : seules les cartes avec un arena_id sont affichées
    let arena_filter = "AND c.arena_id IS NOT NULL";

    // Colonnes explicites pour la recherche : oracle_text et oracle_text_fr omis (NULL)
    // pour réduire le payload IPC (~60% plus léger). Ces champs sont chargés séparément
    // par get_card_by_id uniquement quand une carte est ouverte dans CardDetail.
    // Quantité possédée : subquery seulement quand owned_only = true (zéro overhead sinon)
    let owned_qty_expr = if filters.owned_only == Some(true) {
        "(SELECT col.quantity FROM collection col WHERE col.arena_id = c.arena_id)"
    } else {
        "NULL"
    };
    let slim = format!("c.id, c.oracle_id, c.name_en, c.name_fr, c.mana_cost, c.cmc, \
        c.type_line, NULL AS oracle_text, c.colors, c.color_identity, \
        c.rarity, c.set_code, c.collector_number, \
        c.image_uri_normal, c.image_uri_small, c.image_uri_art_crop, \
        c.power, c.toughness, c.loyalty, c.keywords, c.arena_id, \
        c.image_uri_fr, NULL AS oracle_text_fr, c.type_line_fr, \
        c.layout, c.image_uri_back, \
        {} AS owned_quantity, \
        COALESCE(ct.name, c.name_fr) AS name_loc, \
        COALESCE(ct.type_line, c.type_line_fr) AS type_line_loc, \
        ci.uri AS image_loc", owned_qty_expr);

    let cards = if query_trimmed.is_empty() {
        let sql = format!(
            "SELECT {} FROM cards c {} {} WHERE 1=1 {} {} \
             GROUP BY COALESCE(c.oracle_id, c.id) ORDER BY {} LIMIT ?1",
            slim, lang_join, img_join, arena_filter, extra_where, order_clause
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows: Vec<Card> = stmt.query_map(params![limit], |row| row_to_card(row))?
            .collect::<Result<Vec<_>>>()?;
        rows
    } else {
        // Recherche FTS5 (préfixe) : "arcbound*"
        let fts_query = format!("{}*", query_trimmed.replace('"', "\"\""));
        let sql_fts = format!(
            "SELECT {} FROM cards c
             JOIN cards_fts fts ON c.rowid = fts.rowid
             {} {}
             WHERE cards_fts MATCH ?1 {} {}
             GROUP BY COALESCE(c.oracle_id, c.id)
             ORDER BY {}
             LIMIT ?2",
            slim, lang_join, img_join, arena_filter, extra_where, order_clause
        );
        let mut stmt = conn.prepare(&sql_fts)?;
        let fts_rows: Vec<Card> = stmt
            .query_map(params![fts_query, limit], |row| row_to_card(row))?
            .collect::<Result<Vec<_>>>()?;

        if !fts_rows.is_empty() {
            fts_rows
        } else {
            // Fallback LIKE : sous-chaîne dans name_en OU name_fr
            let like_pat = format!("%{}%", query_trimmed.replace('\'', "''"));
            let sql_like = format!(
                "SELECT {} FROM cards c
                 {} {}
                 WHERE (c.name_en LIKE ?1 OR c.name_fr LIKE ?1 OR ct.name LIKE ?1) {} {}
                 ORDER BY {}
                 LIMIT ?2",
                slim, lang_join, img_join, arena_filter, extra_where, order_clause
            );
            let mut stmt2 = conn.prepare(&sql_like)?;
            let like_rows: Vec<Card> = stmt2
                .query_map(params![like_pat, limit], |row| row_to_card(row))?
                .collect::<Result<Vec<_>>>()?;
            like_rows
        }
    };

    Ok(cards)
}

/// Filtres optionnels pour la recherche de cartes
#[derive(Debug, Deserialize, Default)]
pub struct CardFilters {
    /// Multi-sélection couleurs (logique OR). "C" = incolore (color_identity vide).
    pub colors:     Option<Vec<String>>,
    /// Si true : uniquement les cartes avec 2+ couleurs dans color_identity.
    pub multicolor: Option<bool>,
    /// Multi-sélection raretés (logique OR).
    pub rarities:   Option<Vec<String>>,
    pub card_types: Option<Vec<String>>,
    /// CMC exact multi-sélection ; valeur 7 = "≥ 7"
    pub cmc_values: Option<Vec<i32>>,
    pub set_codes:  Option<Vec<String>>,
    /// Si true : uniquement les cartes dans les favoris
    pub favorites_only: Option<bool>,
    /// Tri : "cmc" (défaut), "name", "rarity"
    pub sort_by:    Option<String>,
    /// Si true : uniquement les cartes légendaires (pour sélection commandant en Brawl)
    pub legendary_only: Option<bool>,
    /// Color identity du commandant : restreint aux cartes légales dans son deck
    /// (color_identity de la carte ⊆ ces couleurs, incolore toujours autorisé)
    pub commander_colors: Option<Vec<String>>,
    /// Si true : uniquement les cartes présentes dans la table collection (MTGA sync)
    pub owned_only: Option<bool>,
}
