use crate::database::{self, Card, CardFilters, DbPath, DbStats};
use rusqlite::params;
use serde::Serialize;
use tauri::State;

/// Un set disponible dans la base (pour le filtre par set)
#[derive(Debug, Serialize)]
pub struct SetInfo {
    pub code: String,
    pub count: i64,
}

/// Recherche des cartes — appelée depuis le frontend React
/// `query` : texte libre (EN ou FR), `limit` : nombre max de résultats
/// `lang_code` : code MTGA de la langue active ("frFR", "koKR"…) pour le JOIN card_translations
/// `image_lang_code` : code MTGA pour le JOIN card_images (peut différer de lang_code)
#[tauri::command]
pub fn search_cards(
    db: State<DbPath>,
    query: String,
    limit: Option<i32>,
    filters: Option<CardFilters>,
    lang_code: Option<String>,
    image_lang_code: Option<String>,
) -> Result<Vec<Card>, String> {
    let conn = database::open(&db.0).map_err(|e| e.to_string())?;
    let limit = limit.unwrap_or(10000).max(1);
    let filters = filters.unwrap_or_default();
    let lang = lang_code.unwrap_or_else(|| "en".to_string());
    let img_lang = image_lang_code.unwrap_or_else(|| "en".to_string());

    database::search_cards_query(&conn, &query, limit, &filters, &lang, &img_lang)
        .map_err(|e| e.to_string())
}

/// Récupère une carte précise par son ID Scryfall
#[tauri::command]
pub fn get_card_by_id(
    db: State<DbPath>,
    card_id: String,
    lang_code: Option<String>,
    image_lang_code: Option<String>,
) -> Result<Option<Card>, String> {
    let conn = database::open(&db.0).map_err(|e| e.to_string())?;
    let lang = lang_code.unwrap_or_else(|| "en".to_string());
    let safe_lang: String = lang.chars().filter(|c| c.is_alphanumeric()).collect();
    let img_lang = image_lang_code.unwrap_or_else(|| "en".to_string());
    let safe_img_lang: String = img_lang.chars().filter(|c| c.is_alphanumeric()).collect();

    let sql = format!(
        "SELECT c.*, \
         COALESCE(ct.name, c.name_fr) AS name_loc, \
         COALESCE(ct.oracle_text, c.oracle_text_fr) AS oracle_text_loc, \
         COALESCE(ct.type_line, c.type_line_fr) AS type_line_loc, \
         ci.uri AS image_loc \
         FROM cards c \
         LEFT JOIN card_translations ct ON c.id = ct.card_id AND ct.lang = '{safe_lang}' \
         LEFT JOIN card_images ci ON c.oracle_id = ci.oracle_id AND ci.lang = '{safe_img_lang}' \
         WHERE c.id = ?1"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query_map(params![card_id], |row| database::row_to_card(row))
        .map_err(|e| e.to_string())?;

    match rows.next() {
        Some(card) => Ok(Some(card.map_err(|e| e.to_string())?)),
        None => Ok(None),
    }
}

/// Retourne des statistiques sur la base de données (nb cartes, nb cartes FR, nb decks)
#[tauri::command]
pub fn get_db_stats(db: State<DbPath>) -> Result<DbStats, String> {
    let conn = database::open(&db.0).map_err(|e| e.to_string())?;

    let total_cards: i64 = conn
        .query_row("SELECT COUNT(*) FROM cards", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    let cards_with_fr: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cards WHERE name_fr IS NOT NULL AND name_fr != ''",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    let cards_with_fr_images: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cards WHERE image_uri_fr IS NOT NULL AND image_uri_fr != ''",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    let total_decks: i64 = conn
        .query_row("SELECT COUNT(*) FROM decks", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    let total_combos: i64 = conn
        .query_row("SELECT COUNT(*) FROM combos", [], |r| r.get(0))
        .unwrap_or(0);

    Ok(DbStats {
        total_cards,
        cards_with_fr,
        cards_with_fr_images,
        total_decks,
        total_combos,
    })
}

/// Liste tous les sets disponibles dans la DB (code + nb de cartes), triés alphabétiquement
#[tauri::command]
pub fn get_sets(db: State<DbPath>) -> Result<Vec<SetInfo>, String> {
    let conn = database::open(&db.0).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT set_code, COUNT(*) as cnt FROM cards
             WHERE set_code IS NOT NULL AND arena_id IS NOT NULL
             GROUP BY set_code
             HAVING cnt >= 10
             ORDER BY MAX(released_at) DESC, set_code ASC",
        )
        .map_err(|e| e.to_string())?;

    let sets = stmt
        .query_map([], |row| {
            Ok(SetInfo {
                code:  row.get(0)?,
                count: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    Ok(sets)
}

/// Filtre une liste de noms de cartes EN pour ne garder que celles disponibles sur Arena
#[tauri::command]
pub fn get_cards_by_names(
    db: State<DbPath>,
    names: Vec<String>,
    lang_code: Option<String>,
    image_lang_code: Option<String>,
) -> Result<Vec<Card>, String> {
    if names.is_empty() { return Ok(vec![]); }
    let conn = database::open(&db.0).map_err(|e| e.to_string())?;
    let lang = lang_code.unwrap_or_else(|| "en".to_string());
    let safe_lang: String = lang.chars().filter(|c| c.is_alphanumeric()).collect();
    let img_lang = image_lang_code.unwrap_or_else(|| "en".to_string());
    let safe_img_lang: String = img_lang.chars().filter(|c| c.is_alphanumeric()).collect();

    let placeholders: Vec<String> = (1..=names.len())
        .map(|i| format!("?{}", i))
        .collect();
    // GROUP BY name_en : une seule ligne par carte (plusieurs printings arena possibles)
    let sql = format!(
        "SELECT c.*, \
         COALESCE(ct.name, c.name_fr) AS name_loc, \
         COALESCE(ct.oracle_text, c.oracle_text_fr) AS oracle_text_loc, \
         COALESCE(ct.type_line, c.type_line_fr) AS type_line_loc, \
         ci.uri AS image_loc \
         FROM cards c \
         LEFT JOIN card_translations ct ON c.id = ct.card_id AND ct.lang = '{safe_lang}' \
         LEFT JOIN card_images ci ON c.oracle_id = ci.oracle_id AND ci.lang = '{safe_img_lang}' \
         WHERE c.name_en IN ({}) AND c.arena_id IS NOT NULL \
         GROUP BY c.name_en ORDER BY c.name_en",
        placeholders.join(",")
    );

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

    let params: Vec<&dyn rusqlite::types::ToSql> = names.iter()
        .map(|s| s as &dyn rusqlite::types::ToSql)
        .collect();

    let cards = stmt
        .query_map(params.as_slice(), |row| database::row_to_card(row))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    Ok(cards)
}

/// Récupère plusieurs cartes par leurs IDs en une seule requête
#[tauri::command]
pub fn get_cards_by_ids(
    db: State<DbPath>,
    ids: Vec<String>,
    lang_code: Option<String>,
    image_lang_code: Option<String>,
) -> Result<Vec<Card>, String> {
    if ids.is_empty() { return Ok(vec![]); }
    let conn = database::open(&db.0).map_err(|e| e.to_string())?;
    let lang = lang_code.unwrap_or_else(|| "en".to_string());
    let safe_lang: String = lang.chars().filter(|c| c.is_alphanumeric()).collect();
    let img_lang = image_lang_code.unwrap_or_else(|| "en".to_string());
    let safe_img_lang: String = img_lang.chars().filter(|c| c.is_alphanumeric()).collect();

    // Construit les placeholders : ?,?,?,...
    let placeholders: Vec<String> = ids.iter().enumerate()
        .map(|(i, _)| format!("?{}", i + 1))
        .collect();
    let sql = format!(
        "SELECT c.*, \
         COALESCE(ct.name, c.name_fr) AS name_loc, \
         COALESCE(ct.oracle_text, c.oracle_text_fr) AS oracle_text_loc, \
         COALESCE(ct.type_line, c.type_line_fr) AS type_line_loc, \
         ci.uri AS image_loc \
         FROM cards c \
         LEFT JOIN card_translations ct ON c.id = ct.card_id AND ct.lang = '{safe_lang}' \
         LEFT JOIN card_images ci ON c.oracle_id = ci.oracle_id AND ci.lang = '{safe_img_lang}' \
         WHERE c.id IN ({})",
        placeholders.join(",")
    );

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

    // Convertit Vec<String> en Vec<&dyn rusqlite::ToSql>
    let params: Vec<&dyn rusqlite::types::ToSql> = ids.iter()
        .map(|s| s as &dyn rusqlite::types::ToSql)
        .collect();

    let cards = stmt
        .query_map(params.as_slice(), |row| database::row_to_card(row))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    Ok(cards)
}
