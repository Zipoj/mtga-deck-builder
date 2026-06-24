use crate::database::{self, Deck, DeckCard, DeckWithCards, DbPath};
use rusqlite::params;
use tauri::State;

/// Crée un nouveau deck vide
#[tauri::command]
pub fn create_deck(
    db: State<DbPath>,
    name: String,
    format: Option<String>,
    description: Option<String>,
) -> Result<Deck, String> {
    let conn = database::open(&db.0).map_err(|e| e.to_string())?;
    let format = format.unwrap_or_else(|| "standard".to_string());
    let description = description.unwrap_or_default();

    conn.execute(
        "INSERT INTO decks (name, format, description) VALUES (?1, ?2, ?3)",
        params![name, format, description],
    )
    .map_err(|e| e.to_string())?;

    let id = conn.last_insert_rowid();
    get_deck_by_id(&conn, id).map_err(|e| e.to_string())
}

/// Liste tous les decks (sans les cartes)
#[tauri::command]
pub fn get_decks(db: State<DbPath>) -> Result<Vec<Deck>, String> {
    let conn = database::open(&db.0).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT d.id, d.name, d.format, d.description, d.created_at, d.updated_at,
                    COALESCE(SUM(dc.quantity), 0) as card_count,
                    d.cover_image_url,
                    COALESCE(
                      (SELECT json_group_array(ci_val) FROM (
                        SELECT DISTINCT ji.value as ci_val
                        FROM deck_cards dc2
                        JOIN cards c2 ON c2.id = dc2.card_id
                        CROSS JOIN json_each(c2.color_identity) ji
                        WHERE dc2.deck_id = d.id AND dc2.board = 'main'
                          AND ji.value IN ('W','U','B','R','G')
                        ORDER BY CASE ji.value WHEN 'W' THEN 1 WHEN 'U' THEN 2
                          WHEN 'B' THEN 3 WHEN 'R' THEN 4 WHEN 'G' THEN 5 END
                      )), '[]'
                    ) as color_identities,
                    d.is_favorite, d.sort_order
             FROM decks d
             LEFT JOIN deck_cards dc ON dc.deck_id = d.id AND dc.board = 'main'
             GROUP BY d.id
             ORDER BY d.sort_order ASC, d.id ASC",
        )
        .map_err(|e| e.to_string())?;

    let decks = stmt
        .query_map([], |row| {
            let ci_str: String = row.get(8).unwrap_or_else(|_| "[]".to_string());
            let is_fav: i64 = row.get(9).unwrap_or(0);
            Ok(Deck {
                id: row.get(0)?,
                name: row.get(1)?,
                format: row.get(2)?,
                description: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                card_count: row.get(6)?,
                cover_image_url: row.get(7)?,
                color_identities: serde_json::from_str(&ci_str).unwrap_or_default(),
                is_favorite: is_fav != 0,
                sort_order: row.get(10).unwrap_or(0),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    Ok(decks)
}

/// Récupère un deck avec toutes ses cartes
#[tauri::command]
pub fn get_deck_with_cards(
    db: State<DbPath>,
    deck_id: i64,
    lang_code: Option<String>,
    image_lang_code: Option<String>,
) -> Result<DeckWithCards, String> {
    let conn = database::open(&db.0).map_err(|e| e.to_string())?;
    let deck = get_deck_by_id(&conn, deck_id).map_err(|e| e.to_string())?;
    let lang = lang_code.unwrap_or_else(|| "en".to_string());
    let safe_lang: String = lang.chars().filter(|c| c.is_alphanumeric()).collect();
    let img_lang = image_lang_code.unwrap_or_else(|| "en".to_string());
    let safe_img_lang: String = img_lang.chars().filter(|c| c.is_alphanumeric()).collect();

    let sql = format!(
        "SELECT c.*, \
         COALESCE(ct.name, c.name_fr) AS name_loc, \
         COALESCE(ct.type_line, c.type_line_fr) AS type_line_loc, \
         ci.uri AS image_loc, \
         dc.quantity, dc.board \
         FROM deck_cards dc \
         JOIN cards c ON c.id = dc.card_id \
         LEFT JOIN card_translations ct ON c.id = ct.card_id AND ct.lang = '{safe_lang}' \
         LEFT JOIN card_images ci ON c.oracle_id = ci.oracle_id AND ci.lang = '{safe_img_lang}' \
         WHERE dc.deck_id = ?1 \
         ORDER BY dc.board, c.cmc, c.name_en"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| e.to_string())?;

    let cards = stmt
        .query_map(params![deck_id], |row| {
            let card = database::row_to_card(row)?;
            let quantity: i32 = row.get("quantity")?;
            let board: String = row.get("board")?;
            Ok(DeckCard { card, quantity, board })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    Ok(DeckWithCards { deck, cards })
}

/// Supprime un deck (cascade sur deck_cards)
#[tauri::command]
pub fn delete_deck(db: State<DbPath>, deck_id: i64) -> Result<(), String> {
    let conn = database::open(&db.0).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM decks WHERE id = ?1", params![deck_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Ajoute ou met à jour la quantité d'une carte dans un deck
#[tauri::command]
pub fn add_card_to_deck(
    db: State<DbPath>,
    deck_id: i64,
    card_id: String,
    quantity: Option<i32>,
    board: Option<String>,
) -> Result<(), String> {
    let conn = database::open(&db.0).map_err(|e| e.to_string())?;
    let quantity = quantity.unwrap_or(1);
    let board = board.unwrap_or_else(|| "main".to_string());

    // INSERT OR REPLACE pour gérer les doublons (même carte, même zone)
    conn.execute(
        "INSERT INTO deck_cards (deck_id, card_id, quantity, board)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(deck_id, card_id, board)
         DO UPDATE SET quantity = quantity + excluded.quantity",
        params![deck_id, card_id, quantity, board],
    )
    .map_err(|e| e.to_string())?;

    touch_deck(&conn, deck_id).map_err(|e| e.to_string())?;
    Ok(())
}

/// Retire une carte d'un deck
#[tauri::command]
pub fn remove_card_from_deck(
    db: State<DbPath>,
    deck_id: i64,
    card_id: String,
    board: Option<String>,
) -> Result<(), String> {
    let conn = database::open(&db.0).map_err(|e| e.to_string())?;
    let board = board.unwrap_or_else(|| "main".to_string());

    conn.execute(
        "DELETE FROM deck_cards WHERE deck_id = ?1 AND card_id = ?2 AND board = ?3",
        params![deck_id, card_id, board],
    )
    .map_err(|e| e.to_string())?;

    touch_deck(&conn, deck_id).map_err(|e| e.to_string())?;
    Ok(())
}

/// Met à jour la quantité d'une carte dans un deck
#[tauri::command]
pub fn update_card_quantity(
    db: State<DbPath>,
    deck_id: i64,
    card_id: String,
    board: Option<String>,
    quantity: i32,
) -> Result<(), String> {
    let conn = database::open(&db.0).map_err(|e| e.to_string())?;
    let board = board.unwrap_or_else(|| "main".to_string());

    if quantity <= 0 {
        // Quantité à 0 = suppression de la carte
        conn.execute(
            "DELETE FROM deck_cards WHERE deck_id = ?1 AND card_id = ?2 AND board = ?3",
            params![deck_id, card_id, board],
        )
        .map_err(|e| e.to_string())?;
    } else {
        conn.execute(
            "UPDATE deck_cards SET quantity = ?4
             WHERE deck_id = ?1 AND card_id = ?2 AND board = ?3",
            params![deck_id, card_id, board, quantity],
        )
        .map_err(|e| e.to_string())?;
    }

    touch_deck(&conn, deck_id).map_err(|e| e.to_string())?;
    Ok(())
}

/// Exporte un deck au format texte MTGA
/// Format : "N Nom de la carte (SET) NUMERO"
/// Exemple : "4 Lightning Bolt (M21) 150"
#[tauri::command]
pub fn export_deck_mtga(db: State<DbPath>, deck_id: i64) -> Result<String, String> {
    let _conn = database::open(&db.0).map_err(|e| e.to_string())?;
    let deck_data = get_deck_with_cards(db, deck_id, None, None)?;

    let mut output = String::new();

    // Mainboard
    let main: Vec<&DeckCard> = deck_data.cards.iter().filter(|c| c.board == "main").collect();
    if !main.is_empty() {
        for dc in &main {
            output.push_str(&format_card_line(dc));
        }
        output.push('\n');
    }

    // Sideboard
    let side: Vec<&DeckCard> = deck_data.cards.iter().filter(|c| c.board == "sideboard").collect();
    if !side.is_empty() {
        output.push_str("Sideboard\n");
        for dc in &side {
            output.push_str(&format_card_line(dc));
        }
        output.push('\n');
    }

    // Commander
    let commander: Vec<&DeckCard> = deck_data.cards.iter().filter(|c| c.board == "commander").collect();
    if !commander.is_empty() {
        output.push_str("Commander\n");
        for dc in &commander {
            output.push_str(&format_card_line(dc));
        }
    }

    Ok(output.trim_end().to_string())
}

/// Importe un deck depuis le format texte MTGA
/// Retourne le deck créé avec ses cartes
#[tauri::command]
pub fn import_deck_mtga(
    db: State<DbPath>,
    content: String,
    deck_name: Option<String>,
) -> Result<Deck, String> {
    let conn = database::open(&db.0).map_err(|e| e.to_string())?;
    let name = deck_name.unwrap_or_else(|| "Deck importé".to_string());

    // Crée le deck
    conn.execute(
        "INSERT INTO decks (name, format, description) VALUES (?1, 'standard', 'Importé depuis MTGA')",
        params![name],
    )
    .map_err(|e| e.to_string())?;

    let deck_id = conn.last_insert_rowid();
    let mut current_board = "main".to_string();

    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() { continue; }

        // Détection des sections
        match line.to_lowercase().as_str() {
            "sideboard" => { current_board = "sideboard".to_string(); continue; }
            "commander"  => { current_board = "commander".to_string(); continue; }
            "deck"       => { current_board = "main".to_string(); continue; }
            _ => {}
        }

        // Format : "N Nom de la carte (SET) NUMERO"
        // ou plus simplement : "N Nom de la carte"
        if let Some((qty, card_name)) = parse_mtga_line(line) {
            // Recherche par nom EN (insensible à la casse) ou FR
            let card_id: Option<String> = conn
                .query_row(
                    "SELECT id FROM cards
                     WHERE LOWER(name_en) = LOWER(?1)
                        OR LOWER(name_fr) = LOWER(?1)
                     LIMIT 1",
                    params![card_name],
                    |r| r.get(0),
                )
                .ok();

            if let Some(id) = card_id {
                conn.execute(
                    "INSERT INTO deck_cards (deck_id, card_id, quantity, board)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(deck_id, card_id, board)
                     DO UPDATE SET quantity = excluded.quantity",
                    params![deck_id, id, qty, current_board],
                )
                .map_err(|e| e.to_string())?;
            }
            // Si la carte n'est pas trouvée, on l'ignore silencieusement
            // (les cartes non-MTGA ou mal orthographiées sont courantes)
        }
    }

    get_deck_by_id(&conn, deck_id).map_err(|e| e.to_string())
}

/// Renomme un deck
#[tauri::command]
pub fn rename_deck(
    db: State<DbPath>,
    deck_id: i64,
    name: String,
    description: Option<String>,
    format: Option<String>,
) -> Result<Deck, String> {
    let conn = database::open(&db.0).map_err(|e| e.to_string())?;

    match (description, format) {
        (Some(desc), Some(fmt)) => {
            conn.execute(
                "UPDATE decks SET name = ?1, description = ?2, format = ?3, updated_at = datetime('now') WHERE id = ?4",
                params![name, desc, fmt, deck_id],
            ).map_err(|e| e.to_string())?;
        }
        (Some(desc), None) => {
            conn.execute(
                "UPDATE decks SET name = ?1, description = ?2, updated_at = datetime('now') WHERE id = ?3",
                params![name, desc, deck_id],
            ).map_err(|e| e.to_string())?;
        }
        (None, Some(fmt)) => {
            conn.execute(
                "UPDATE decks SET name = ?1, format = ?2, updated_at = datetime('now') WHERE id = ?3",
                params![name, fmt, deck_id],
            ).map_err(|e| e.to_string())?;
        }
        (None, None) => {
            conn.execute(
                "UPDATE decks SET name = ?1, updated_at = datetime('now') WHERE id = ?2",
                params![name, deck_id],
            ).map_err(|e| e.to_string())?;
        }
    }

    get_deck_by_id(&conn, deck_id).map_err(|e| e.to_string())
}

/// Duplique un deck (copie complète avec toutes ses cartes)
#[tauri::command]
pub fn duplicate_deck(
    db: State<DbPath>,
    deck_id: i64,
) -> Result<Deck, String> {
    let conn = database::open(&db.0).map_err(|e| e.to_string())?;

    // Récupère le deck source
    let source = get_deck_by_id(&conn, deck_id).map_err(|e| e.to_string())?;

    // Crée un nouveau deck avec le même nom + " (copie)"
    conn.execute(
        "INSERT INTO decks (name, format, description) VALUES (?1, ?2, ?3)",
        params![format!("{} (copie)", source.name), source.format, source.description],
    ).map_err(|e| e.to_string())?;
    let new_id = conn.last_insert_rowid();

    // Copie toutes les cartes
    conn.execute(
        "INSERT INTO deck_cards (deck_id, card_id, quantity, board)
         SELECT ?1, card_id, quantity, board FROM deck_cards WHERE deck_id = ?2",
        params![new_id, deck_id],
    ).map_err(|e| e.to_string())?;

    get_deck_by_id(&conn, new_id).map_err(|e| e.to_string())
}

// ─── Fonctions utilitaires privées ────────────────────────────────────────────

fn get_deck_by_id(conn: &rusqlite::Connection, id: i64) -> rusqlite::Result<Deck> {
    conn.query_row(
        "SELECT d.id, d.name, d.format, d.description, d.created_at, d.updated_at,
                COALESCE(SUM(dc.quantity), 0) as card_count,
                d.cover_image_url,
                COALESCE(
                  (SELECT json_group_array(ci_val) FROM (
                    SELECT DISTINCT ji.value as ci_val
                    FROM deck_cards dc2
                    JOIN cards c2 ON c2.id = dc2.card_id
                    CROSS JOIN json_each(c2.color_identity) ji
                    WHERE dc2.deck_id = d.id AND dc2.board = 'main'
                      AND ji.value IN ('W','U','B','R','G')
                    ORDER BY CASE ji.value WHEN 'W' THEN 1 WHEN 'U' THEN 2
                      WHEN 'B' THEN 3 WHEN 'R' THEN 4 WHEN 'G' THEN 5 END
                  )), '[]'
                ) as color_identities,
                d.is_favorite, d.sort_order
         FROM decks d
         LEFT JOIN deck_cards dc ON dc.deck_id = d.id AND dc.board = 'main'
         WHERE d.id = ?1
         GROUP BY d.id",
        params![id],
        |row| {
            let ci_str: String = row.get(8).unwrap_or_else(|_| "[]".to_string());
            let is_fav: i64 = row.get(9).unwrap_or(0);
            Ok(Deck {
                id: row.get(0)?,
                name: row.get(1)?,
                format: row.get(2)?,
                description: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                card_count: row.get(6)?,
                cover_image_url: row.get(7)?,
                color_identities: serde_json::from_str(&ci_str).unwrap_or_default(),
                is_favorite: is_fav != 0,
                sort_order: row.get(10).unwrap_or(0),
            })
        },
    )
}

/// Met à jour le statut favori d'un deck
#[tauri::command]
pub fn set_deck_favorite(db: State<DbPath>, deck_id: i64, is_favorite: bool) -> Result<(), String> {
    let conn = database::open(&db.0).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE decks SET is_favorite = ?1 WHERE id = ?2",
        params![is_favorite as i64, deck_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// Réordonne les decks en mettant à jour sort_order pour chaque ID dans l'ordre donné
#[tauri::command]
pub fn reorder_decks(db: State<DbPath>, ordered_ids: Vec<i64>) -> Result<(), String> {
    let conn = database::open(&db.0).map_err(|e| e.to_string())?;
    for (idx, id) in ordered_ids.iter().enumerate() {
        conn.execute(
            "UPDATE decks SET sort_order = ?1 WHERE id = ?2",
            params![idx as i64, id],
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Définit l'image de couverture d'un deck (art_crop d'une carte)
#[tauri::command]
pub fn set_deck_cover(
    db: State<DbPath>,
    deck_id: i64,
    cover_image_url: Option<String>,
) -> Result<(), String> {
    let conn = database::open(&db.0).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE decks SET cover_image_url = ?1 WHERE id = ?2",
        params![cover_image_url, deck_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn touch_deck(conn: &rusqlite::Connection, deck_id: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE decks SET updated_at = datetime('now') WHERE id = ?1",
        params![deck_id],
    )?;
    Ok(())
}

fn format_card_line(dc: &DeckCard) -> String {
    let set = dc.card.set_code.as_deref().unwrap_or("???").to_uppercase();
    let num = dc.card.collector_number.as_deref().unwrap_or("0");
    format!("{} {} ({}) {}\n", dc.quantity, dc.card.name_en, set, num)
}

/// Parse une ligne MTGA : "4 Lightning Bolt (M21) 150" → (4, "Lightning Bolt")
fn parse_mtga_line(line: &str) -> Option<(i32, String)> {
    let line = line.trim();
    // Optionnel : retire "1x", "4x", etc.
    let line = if line.starts_with(|c: char| c.is_ascii_digit()) {
        line
    } else {
        return None;
    };

    let space_pos = line.find(' ')?;
    let qty_str = &line[..space_pos];
    let qty: i32 = qty_str.trim_end_matches('x').parse().ok()?;

    let rest = line[space_pos + 1..].trim();

    // Enlève la partie "(SET) NUMERO" si présente
    let card_name = if let Some(paren_pos) = rest.find(" (") {
        rest[..paren_pos].trim().to_string()
    } else {
        rest.to_string()
    };

    if card_name.is_empty() { return None; }
    Some((qty, card_name))
}
