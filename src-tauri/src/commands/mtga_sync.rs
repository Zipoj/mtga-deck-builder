use crate::database::DbPath;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{Emitter, State};

// ─── Types ────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct MtgaSyncProgress {
    pub stage:         String,  // "scan" | "parse" | "update" | "done" | "error"
    pub cards_found:   usize,
    pub cards_updated: usize,
    pub done:          bool,
    pub error:         Option<String>,
}

/// Flexible card entry — handles both old JSON and new SQLite formats.
#[derive(Debug, Deserialize, Default)]
struct MtgaCardEntry {
    #[serde(alias = "grpid", alias = "GrpId", alias = "grpId")]
    grp_id:   Option<i64>,
    /// Integer title id (old JSON format: maps to Loc integer key)
    #[serde(alias = "titleId", alias = "TitleId", alias = "title_id")]
    title_id: Option<i64>,
}

/// Localisation map — either integer-keyed (old JSON format)
/// or English-name-keyed (new SQLite 2024+ format).
///
/// SQLite variant: key = `enUS` text (e.g. "Lightning Bolt"),
/// value = translated text (e.g. "Éclair").
/// Join is done by matching app DB `name_en` against `enUS`, bypassing the
/// integer `titleId` ↔ string `Loc.Key` mismatch entirely.
enum LocMap {
    ById(HashMap<i64, String>),
    ByEnName(HashMap<String, String>),
}

impl LocMap {
    fn get_by_id(&self, id: i64) -> Option<&String> {
        match self { LocMap::ById(m) => m.get(&id), _ => None }
    }
}

// ─── File helpers ─────────────────────────────────────────────────────────────

/// Read a file and return its text content.
/// Handles:
///   - Gzip-compressed data (magic bytes 1f 8b) — all new MTGA 2024+ .mtga files
///   - Zlib-compressed data (magic bytes 78 9c / 78 da / 78 01)
///   - UTF-8 BOM
///   - Plain UTF-8 / ASCII JSON
fn read_text(path: &Path) -> Result<String, String> {
    use std::io::Read;

    let raw = std::fs::read(path).map_err(|e| e.to_string())?;

    // ── Gzip (magic: 1f 8b) ───────────────────────────────────────────────────
    if raw.starts_with(&[0x1f, 0x8b]) {
        let mut decoder = flate2::read::GzDecoder::new(&raw[..]);
        let mut text = String::new();
        decoder.read_to_string(&mut text).map_err(|e| {
            format!(
                "Décompression gzip échouée pour {} : {e}",
                path.file_name().unwrap_or_default().to_string_lossy()
            )
        })?;
        return Ok(text);
    }

    // ── Zlib (magic: 78 9c, 78 da, 78 01, 78 5e) ─────────────────────────────
    if matches!(raw.first(), Some(0x78))
        && matches!(raw.get(1), Some(0x9c) | Some(0xda) | Some(0x01) | Some(0x5e))
    {
        let mut decoder = flate2::read::ZlibDecoder::new(&raw[..]);
        let mut text = String::new();
        if decoder.read_to_string(&mut text).is_ok() && !text.is_empty() {
            return Ok(text);
        }
    }

    // ── UTF-8 BOM ─────────────────────────────────────────────────────────────
    if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Ok(String::from_utf8_lossy(&raw[3..]).into_owned());
    }

    // ── Plain JSON / text ─────────────────────────────────────────────────────
    // If first byte is clearly not a JSON starter, report the bytes for diagnosis.
    if !matches!(raw.first(), Some(b'{') | Some(b'[') | Some(b'"') | Some(b' ') | Some(b'\t') | Some(b'\r') | Some(b'\n')) {
        let preview: Vec<String> = raw[..16.min(raw.len())]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        return Err(format!(
            "Format binaire inconnu pour {} (premiers octets: {}).\n\
             Ni JSON, ni gzip (1f 8b), ni zlib (78 9c).",
            path.file_name().unwrap_or_default().to_string_lossy(),
            preview.join(" ")
        ));
    }

    Ok(String::from_utf8_lossy(&raw).into_owned())
}

/// Returns true if `path` is a SQLite 3 database (magic header "SQLite format 3\0").
fn is_sqlite_file(path: &Path) -> bool {
    use std::io::Read;
    let mut f = match std::fs::File::open(path) {
        Ok(f) => f, Err(_) => return false,
    };
    let mut magic = [0u8; 16];
    f.read_exact(&mut magic).is_ok() && magic.starts_with(b"SQLite format 3\0")
}

/// Open a .mtga SQLite database and list all table names.
fn sqlite_tables(conn: &rusqlite::Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .map_err(|e| e.to_string())?;
    let names = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(names)
}

/// Read a SQLite column value as i64, accepting INTEGER, REAL, or TEXT storage.
fn sqlite_get_i64(r: &rusqlite::Row<'_>, idx: usize) -> rusqlite::Result<i64> {
    // Try integer first (most common)
    r.get::<_, i64>(idx)
        // Then float (e.g. 12345.0)
        .or_else(|_| r.get::<_, f64>(idx).map(|f| f as i64))
        // Then text "12345" → parse
        .or_else(|_| {
            r.get::<_, String>(idx).and_then(|s| {
                s.trim().parse::<i64>().map_err(|_| {
                    rusqlite::Error::InvalidColumnType(
                        idx,
                        format!("col{idx}"),
                        rusqlite::types::Type::Text,
                    )
                })
            })
        })
}

/// Return column names for a table (via PRAGMA table_info).
fn sqlite_columns(conn: &rusqlite::Connection, table: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info(\"{}\")", table))
        .map_err(|e| e.to_string())?;
    let cols = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(cols)
}

/// Parse a SQLite .mtga localization file (MTGA 2024+ format).
///
/// Returns a map keyed by the **English text** (`enUS` column value), not by `Loc.Key`.
/// This lets us join with the app DB via `name_en` without needing to resolve
/// the integer `titleId` ↔ hierarchical `Loc.Key` path mismatch.
///
/// Example: `"Lightning Bolt"` → `"Éclair"` (for lang_code="frFR")
fn parse_loc_file_sqlite(path: &Path, lang_code: &str) -> Result<HashMap<String, String>, String> {
    let conn = rusqlite::Connection::open(path)
        .map_err(|e| format!("Ouverture SQLite '{}' échouée : {e}", path.display()))?;

    let tables = sqlite_tables(&conn)?;

    let lc = lang_code.to_ascii_lowercase();
    let short2 = &lc[..2.min(lc.len())];
    let candidates: Vec<String> = vec![
        lang_code.to_string(),
        format!("{}_{}", &lang_code[..2], &lang_code[2..]),
        format!("{}-{}", &lang_code[..2], &lang_code[2..]),
        lang_code[2..].to_string(),
        short2.to_string(),
    ];

    let mut diagnostics: Vec<String> = Vec::new();

    for table in &tables {
        let cols = sqlite_columns(&conn, table)?;

        // Find the target language column
        let lang_col = candidates.iter()
            .find_map(|cand| cols.iter().find(|c| c.eq_ignore_ascii_case(cand)).cloned());
        let Some(lang_col) = lang_col else { continue };

        // Count for diagnostics
        let total: i64 = conn.query_row(
            &format!("SELECT count(*) FROM \"{table}\""), [], |r| r.get(0)
        ).unwrap_or(-1);
        let non_null: i64 = conn.query_row(
            &format!("SELECT count(*) FROM \"{table}\" WHERE \"{lang_col}\" IS NOT NULL AND \"{lang_col}\" != ''"),
            [], |r| r.get(0)
        ).unwrap_or(-1);
        diagnostics.push(format!("  {table} [rows={total}, {lang_col}_non_null={non_null}]"));
        if total == 0 { continue; }

        // Primary strategy: build enUS → translated map.
        // Loc.Key is a hierarchical path (e.g. "EPP/ColorMastery/...") unrelated to titleId.
        // Using enUS as the key lets us join directly with app DB name_en.
        let en_col = ["enUS", "en_US", "en-US", "en", "enus"].iter()
            .find_map(|ec| cols.iter().find(|c| c.eq_ignore_ascii_case(ec)).cloned());

        if let Some(ref en_col) = en_col {
            let sql = format!(
                "SELECT \"{en_col}\", \"{lang_col}\" FROM \"{table}\" \
                 WHERE \"{en_col}\" IS NOT NULL AND \"{en_col}\" != '' \
                 AND \"{lang_col}\" IS NOT NULL AND \"{lang_col}\" != ''"
            );
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let map: HashMap<String, String> = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            if !map.is_empty() {
                return Ok(map);
            }
        }

        // Fallback: Key (path string) → lang (kept for unknown future formats)
        let id_col = ["Key", "Id", "string_id", "StringId", "TextId", "LocId"].iter()
            .find_map(|ic| cols.iter().find(|c| c.eq_ignore_ascii_case(ic)).cloned());
        if let Some(ref id_col) = id_col {
            let sql = format!("SELECT \"{id_col}\", \"{lang_col}\" FROM \"{table}\"");
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let map: HashMap<String, String> = stmt
                .query_map([], |r| {
                    let key = r.get::<_, String>(0)
                        .or_else(|_| r.get::<_, i64>(0).map(|n| n.to_string()))?;
                    let text: String = r.get(1)?;
                    Ok((key, text))
                })
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .filter(|(_, t)| !t.is_empty())
                .collect();
            if !map.is_empty() {
                return Ok(map);
            }
        }
    }

    Err(format!(
        "Langue '{lang_code}' introuvable dans la base SQLite.\n\
         Tables analysées :\n{}\n\
         Noms essayés pour la colonne langue : {candidates:?}",
        diagnostics.join("\n")
    ))
}

/// Detect available language columns in a SQLite .mtga localization file.
/// Returns the canonical MTGA lang codes (e.g. "frFR") for whichever languages
/// can be found in the database (by exact or approximate column name match).
/// Kept for legacy/fallback use — prefer `sqlite_cards_available_langs`.
#[allow(dead_code)]
pub fn sqlite_loc_available_langs(path: &Path) -> Vec<String> {
    let known = ["frFR","deDE","esES","itIT","ptBR","jaJP","koKR","ruRU","zhCN","zhTW","enUS"];
    let conn = match rusqlite::Connection::open(path) {
        Ok(c) => c, Err(_) => return vec![],
    };
    let tables = match sqlite_tables(&conn) {
        Ok(t) => t, Err(_) => return vec![],
    };
    for table in &tables {
        let cols = match sqlite_columns(&conn, table) {
            Ok(c) => c, Err(_) => continue,
        };
        let cols_lc: Vec<String> = cols.iter().map(|c| c.to_ascii_lowercase()).collect();
        let found: Vec<String> = known.iter()
            .filter(|k| {
                let kl = k.to_ascii_lowercase();
                let short2 = &kl[..2];
                let with_sep = format!("{short2}_{}", &kl[2..]);
                // Match "frfr", "fr_fr", "fr-fr", "fr", etc.
                cols_lc.iter().any(|c| {
                    c == &kl
                    || c == &with_sep
                    || c == short2
                    || c == &kl[2..]
                })
            })
            .map(|k| k.to_string())
            .collect();
        if !found.is_empty() { return found; }
    }
    vec![]
}

/// Parse a SQLite .mtga card database file.
/// Only reads grpId + titleId; titleId is only needed for the old JSON format join.
/// For SQLite format, the translation join uses name_en from the app DB instead.
fn parse_cards_file_sqlite(path: &Path) -> Result<Vec<MtgaCardEntry>, String> {
    let conn = rusqlite::Connection::open(path)
        .map_err(|e| format!("Ouverture SQLite '{}' échouée : {e}", path.display()))?;

    let tables = sqlite_tables(&conn)?;

    for table in &tables {
        let cols = sqlite_columns(&conn, table)?;
        let cols_lc: Vec<String> = cols.iter().map(|c| c.to_ascii_lowercase()).collect();

        // Need at minimum a grpId column
        let grp_col = cols.iter().zip(&cols_lc)
            .find(|(_, lc)| *lc == "grpid")
            .map(|(c, _)| c.clone());
        let Some(gc) = grp_col else { continue };

        // titleId is optional (used only in old JSON fallback path)
        let title_id_col = cols.iter().zip(&cols_lc)
            .find(|(_, lc)| *lc == "titleid")
            .map(|(c, _)| c.clone());

        let sql = if let Some(ref tc) = title_id_col {
            format!("SELECT \"{gc}\", \"{tc}\" FROM \"{table}\"")
        } else {
            format!("SELECT \"{gc}\" FROM \"{table}\"")
        };

        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let entries: Vec<MtgaCardEntry> = stmt
            .query_map([], |r| {
                let grp_id = sqlite_get_i64(r, 0).ok();
                let title_id = if title_id_col.is_some() {
                    sqlite_get_i64(r, 1).ok()
                } else {
                    None
                };
                Ok(MtgaCardEntry { grp_id, title_id })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        if !entries.is_empty() {
            return Ok(entries);
        }
    }

    // Diagnostic: show all tables and their columns
    let col_report: Vec<String> = tables.iter()
        .filter_map(|t| sqlite_columns(&conn, t).ok()
            .map(|c| format!("  Table '{}': [{}]", t, c.join(", "))))
        .collect();
    Err(format!(
        "Colonne grpId introuvable dans la base SQLite.\n\
         Schéma détecté :\n{}",
        col_report.join("\n")
    ))
}

/// Join Cards.TitleId → Localizations_{lang_code}.LocId in the Cards SQLite DB.
///
/// The Cards DB (Raw_CardDatabase_*.mtga) embeds all localisation tables directly:
///   Cards.TitleId  =  Localizations_frFR.LocId  →  Loc (plain text card name)
///
/// We use Formatted=0 (plain text, not HTML) and exclude "#NoTranslation*" placeholders.
/// Returns Vec<(grp_id, localised_name)>.
/// Returns `(GrpId, translated_name, en_name)` for all Arena cards.
///
/// Uses TWO separate queries so that `Localizations_enUS` scarcity doesn't
/// reduce the frFR result set (INNER JOIN was too restrictive — enUS Formatted=0
/// has far fewer entries than frFR in some installations).
///
/// - Query 1: all (GrpId, frFR_name) via Cards JOIN Localizations_{lang} Formatted=0
/// - Query 2: (GrpId, enUS_name) via Cards JOIN Localizations_enUS, any Formatted,
///            GROUP BY GrpId — used only as a name-based fallback in the UPDATE loop
/// Row returned by the Cards SQLite sync.
struct CardLocRow {
    grp_id:   i64,
    loc_name: String,
    loc_body: Option<String>,  // oracle text in target language
    loc_type: Option<String>,  // full type line in target language (type + subtype)
    en_name:  String,          // English name for pass-2 matching
}

/// Convertit le coût de mana « old school » de MTGA en notation Scryfall.
/// Ex : "o2oUoU" → "{2}{U}{U}", "o9" → "{9}". Chaque symbole est préfixé par 'o'.
fn fmt_mtga_mana(raw: &str) -> String {
    raw.split('o')
        .filter(|s| !s.is_empty())
        .map(|s| format!("{{{}}}", s))
        .collect()
}

/// Load an entire Localizations table into a `HashMap<LocId, best_plain_text>`.
/// Picks `Formatted=0` non-HTML text first, then any non-HTML text as fallback.
/// One full table scan — all subsequent lookups are O(1) HashMaps (no SQL JOINs).
fn load_loc_table(
    conn: &rusqlite::Connection,
    table: &str,
) -> Result<HashMap<i64, String>, String> {
    let sql = format!(
        "SELECT LocId, \
           COALESCE( \
             MIN(CASE WHEN Formatted=0 AND Loc NOT LIKE '<%' AND Loc NOT LIKE '#%' THEN Loc END), \
             MIN(CASE WHEN Loc NOT LIKE '<%' AND Loc NOT LIKE '#%' THEN Loc END) \
           ) \
         FROM \"{table}\" \
         WHERE Loc IS NOT NULL AND Loc != '' \
         GROUP BY LocId \
         HAVING COALESCE( \
           MIN(CASE WHEN Formatted=0 AND Loc NOT LIKE '<%' AND Loc NOT LIKE '#%' THEN Loc END), \
           MIN(CASE WHEN Loc NOT LIKE '<%' AND Loc NOT LIKE '#%' THEN Loc END) \
         ) IS NOT NULL"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let map: HashMap<i64, String> = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(map)
}

fn sync_names_from_cards_sqlite(
    cards_path: &Path,
    lang_code: &str,
) -> Result<Vec<CardLocRow>, String> {
    let conn = rusqlite::Connection::open(cards_path)
        .map_err(|e| format!("Ouverture SQLite cards : {e}"))?;

    // Speed pragmas — larger cache, keep temp data in RAM
    let _ = conn.execute_batch("PRAGMA cache_size=-65536; PRAGMA temp_store=MEMORY;");

    let tables = sqlite_tables(&conn)?;

    // Find tables (case-insensitive)
    let target = format!("Localizations_{lang_code}");
    let lang_table = tables.iter()
        .find(|t| t.eq_ignore_ascii_case(&target))
        .cloned()
        .ok_or_else(|| {
            let available: Vec<&str> = tables.iter()
                .filter(|t| t.starts_with("Localizations_"))
                .map(|t| t.as_str())
                .collect();
            format!(
                "Table '{target}' introuvable dans le Cards DB.\n\
                 Tables de localisation disponibles : {available:?}"
            )
        })?;
    let en_table = tables.iter()
        .find(|t| t.eq_ignore_ascii_case("Localizations_enUS"))
        .cloned();
    let cards_table = tables.iter()
        .find(|t| t.eq_ignore_ascii_case("Cards"))
        .cloned()
        .ok_or("Table 'Cards' introuvable dans le Cards DB")?;

    let card_cols = sqlite_columns(&conn, &cards_table)?;
    let has_col = |name: &str| card_cols.iter().any(|c| c.eq_ignore_ascii_case(name));

    // ── Step 1: Load Localizations_{lang} entirely into RAM (one full scan) ───
    // All subsequent name / type / oracle lookups become O(1) HashMap.get()
    // instead of SQL JOINs — this is the main speedup over the old approach.
    println!("[sync] Chargement Localizations_{lang_code} en mémoire…");
    let loc_map: HashMap<i64, String> = load_loc_table(&conn, &lang_table)?;

    // ── Step 2: Load Localizations_enUS (for pass-2 en_name matching) ─────────
    let en_loc_map: HashMap<i64, String> = if let Some(ref en_tbl) = en_table {
        println!("[sync] Chargement Localizations_enUS…");
        load_loc_table(&conn, en_tbl).unwrap_or_default()
    } else {
        HashMap::new()
    };

    // ── Step 3: Load Abilities: Id → TextId (two columns, very fast) ──────────
    // ability_textid[ability_id] = text_id  →  loc_map[text_id] = oracle line
    let ability_textid: HashMap<i64, i64> = if tables.iter().any(|t| t.eq_ignore_ascii_case("Abilities")) {
        println!("[sync] Chargement table Abilities…");
        let mut stmt = conn.prepare(
            "SELECT Id, TextId FROM Abilities WHERE TextId IS NOT NULL AND CAST(TextId AS INTEGER) != 0"
        ).map_err(|e| e.to_string())?;
        let rows: HashMap<i64, i64> = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        rows
    } else {
        HashMap::new()
    };

    // ── Step 4: Load all relevant Card columns in one query ───────────────────
    // SELECT GrpId, TitleId, TypeTextId?, SubtypeTextId?, AbilityIds?
    // Only fetch columns that actually exist in this Cards table version.
    let has_type    = has_col("TypeTextId");
    let has_sub     = has_col("SubtypeTextId");
    let has_ab      = has_col("AbilityIds");
    let has_body    = ["BodyId", "OracleTextId", "RulesTextId"]
        .iter().find(|c| has_col(c)).copied();
    // Colonnes prototype : la face liée (LinkedFaceType=13) porte coût + taille
    let has_lft     = has_col("LinkedFaceType");
    let has_lfg     = has_col("LinkedFaceGrpIds");
    let has_mana    = has_col("OldSchoolManaText");
    let has_pow     = has_col("Power");
    let has_tou     = has_col("Toughness");

    let cols_sql = {
        let mut cols = vec!["GrpId", "TitleId"];
        if has_type { cols.push("TypeTextId"); }
        if has_sub  { cols.push("SubtypeTextId"); }
        if has_ab   { cols.push("AbilityIds"); }
        if let Some(bc) = has_body { cols.push(bc); }
        if has_lft  { cols.push("LinkedFaceType"); }
        if has_lfg  { cols.push("LinkedFaceGrpIds"); }
        if has_mana { cols.push("OldSchoolManaText"); }
        if has_pow  { cols.push("Power"); }
        if has_tou  { cols.push("Toughness"); }
        cols.join(", ")
    };
    let sql_cards = format!("SELECT {cols_sql} FROM \"{cards_table}\"");

    struct CardRow {
        grp_id:          i64,
        title_id:        Option<i64>,
        type_text_id:    Option<i64>,
        subtype_text_id: Option<i64>,
        ability_ids:     Option<String>,
        body_text_id:    Option<i64>,
        linked_face_type:    Option<i64>,
        linked_face_grp_ids: Option<String>,
        mana:            Option<String>,
        power:           Option<String>,
        toughness:       Option<String>,
    }

    println!("[sync] Chargement table Cards ({cols_sql})…");
    let card_rows: Vec<CardRow> = {
        let mut stmt = conn.prepare(&sql_cards).map_err(|e| e.to_string())?;
        let rows: Vec<CardRow> = stmt
            .query_map([], |r| {
                let mut idx = 0usize;
                let grp_id:   i64          = r.get(idx)?; idx += 1;
                let title_id: Option<i64>  = r.get(idx).ok(); idx += 1;
                let type_text_id:    Option<i64> = if has_type { let v = r.get(idx).ok(); idx += 1; v } else { None };
                let subtype_text_id: Option<i64> = if has_sub  { let v = r.get(idx).ok(); idx += 1; v } else { None };
                let ability_ids:  Option<String> = if has_ab   { let v = r.get(idx).ok(); idx += 1; v } else { None };
                let body_text_id: Option<i64>    = if has_body.is_some() { let v = r.get(idx).ok(); idx += 1; v } else { None };
                let linked_face_type:    Option<i64>    = if has_lft  { let v = r.get(idx).ok(); idx += 1; v } else { None };
                let linked_face_grp_ids: Option<String> = if has_lfg  { let v = r.get(idx).ok(); idx += 1; v } else { None };
                let mana:      Option<String> = if has_mana { let v = r.get(idx).ok(); idx += 1; v } else { None };
                let power:     Option<String> = if has_pow  { let v = r.get(idx).ok(); idx += 1; v } else { None };
                let toughness: Option<String> = if has_tou  { r.get(idx).ok() } else { None };
                Ok(CardRow {
                    grp_id, title_id, type_text_id, subtype_text_id, ability_ids, body_text_id,
                    linked_face_type, linked_face_grp_ids, mana, power, toughness,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        rows
    };

    // Map des faces prototype (LinkedFaceType=13) : GrpId → (coût formaté, force, endurance).
    // La face « principale » (type 14) référence cette face via LinkedFaceGrpIds.
    let proto_face: HashMap<i64, (String, String, String)> = card_rows.iter()
        .filter(|c| c.linked_face_type == Some(13))
        .filter_map(|c| {
            let mana = c.mana.as_deref().filter(|s| !s.is_empty())?;
            let p = c.power.clone().unwrap_or_default();
            let t = c.toughness.clone().unwrap_or_default();
            Some((c.grp_id, (fmt_mtga_mana(mana), p, t)))
        })
        .collect();

    // ── Step 5: Build CardLocRow using in-memory HashMap lookups ──────────────
    println!("[sync] Construction des {} entrées…", card_rows.len());
    let results: Vec<CardLocRow> = card_rows
        .into_iter()
        .filter_map(|card| {
            // Name (required — skip cards without a translation)
            let tid = card.title_id.filter(|&id| id != 0)?;
            let loc_name = loc_map.get(&tid)?.clone();

            // Type line: main type + optional subtype separated by " — "
            let loc_type = {
                let t = card.type_text_id
                    .filter(|&id| id != 0)
                    .and_then(|id| loc_map.get(&id))
                    .cloned();
                let s = card.subtype_text_id
                    .filter(|&id| id != 0)
                    .and_then(|id| loc_map.get(&id))
                    .cloned();
                match (t.filter(|v| !v.is_empty()), s.filter(|v| !v.is_empty())) {
                    (Some(t), Some(s)) => Some(format!("{t} — {s}")),
                    (Some(t), None)    => Some(t),
                    (None,    Some(s)) => Some(s),
                    _                  => None,
                }
            };

            // Info prototype (coût + taille) depuis la face liée, si présente.
            let proto_info = card.linked_face_grp_ids.as_deref().and_then(|csv| {
                csv.split(',')
                    .filter_map(|g| g.trim().parse::<i64>().ok())
                    .find_map(|g| proto_face.get(&g))
            });

            // Oracle text: BodyId column (legacy) OR Abilities table (current)
            let loc_body = if let Some(btid) = card.body_text_id.filter(|&id| id != 0) {
                loc_map.get(&btid).cloned()
            } else if let Some(ref ab_csv) = card.ability_ids {
                let lines: Vec<String> = ab_csv
                    .split(',')
                    .filter_map(|pair| {
                        let ab_id: i64 = pair.split(':').next()?.trim().parse().ok()?;
                        let text_id = ability_textid.get(&ab_id)?;
                        let en = en_loc_map.get(text_id).map(|s| s.as_str());
                        // Ligne mot-clé « Prototype » → on synthétise « Prototype {coût} — F/E »
                        if let (Some("Prototype"), Some((cost, p, t))) = (en, proto_info) {
                            let kw = loc_map.get(text_id).map(|s| s.as_str()).unwrap_or("Prototype");
                            return Some(format!("{kw} {cost} — {p}/{t}"));
                        }
                        // Texte FR si dispo, sinon fallback EN (placeholder #NoTranslation exclu de loc_map)
                        let txt = loc_map.get(text_id).cloned()
                            .or_else(|| en.map(|e| e.to_string()))?;
                        Some(txt.replace("CARDNAME", &loc_name))
                    })
                    .collect();
                if lines.is_empty() { None } else { Some(lines.join("\n")) }
            } else {
                None
            };

            // EN name for pass-2 matching
            let en_name = en_loc_map.get(&tid).cloned().unwrap_or_default();

            Some(CardLocRow { grp_id: card.grp_id, loc_name, loc_body, loc_type, en_name })
        })
        .collect();

    Ok(results)
}

/// Returns language codes available in the Cards SQLite DB
/// by scanning for Localizations_* table names.
pub fn sqlite_cards_available_langs(path: &Path) -> Vec<String> {
    let conn = match rusqlite::Connection::open(path) {
        Ok(c) => c, Err(_) => return vec![],
    };
    let tables = match sqlite_tables(&conn) {
        Ok(t) => t, Err(_) => return vec![],
    };
    tables.into_iter()
        .filter_map(|t| {
            t.strip_prefix("Localizations_").map(|lang| lang.to_string())
        })
        .filter(|l| l != "phyrexian") // not a real display language
        .collect()
}

/// Returns the most recent file whose name starts with `prefix` and ends with
/// `.mtga` or `.json` in `dir`.
fn find_latest_file(dir: &Path, prefix: &str) -> Option<PathBuf> {
    let mut matches: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with(prefix) && (n.ends_with(".mtga") || n.ends_with(".json")))
                .unwrap_or(false)
        })
        .collect();
    matches.sort();
    matches.pop()
}

/// Detect the localization file in a directory.
/// New format (2024+): Raw_ClientLocalization_*.mtga  (all langs in one file)
/// Old format:         Data_loc_*.mtga                (one file per language)
#[derive(Debug, Clone)]
enum LocFormat {
    Combined(PathBuf),              // Raw_ClientLocalization_*.mtga
    PerLang(Vec<String>),           // list of Data_loc_*.mtga file names
}

fn detect_loc_format(dir: &Path) -> Option<LocFormat> {
    // New format first
    if let Some(p) = find_latest_file(dir, "Raw_ClientLocalization_") {
        return Some(LocFormat::Combined(p));
    }
    // Old per-language format
    let mut per_lang: Vec<String> = std::fs::read_dir(dir).ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("Data_loc_") && (n.ends_with(".mtga") || n.ends_with(".json")))
        .collect();
    if !per_lang.is_empty() {
        per_lang.sort();
        per_lang.dedup_by(|a, b| {
            let pa = &a[..a.rfind('_').unwrap_or(a.len())];
            let pb = &b[..b.rfind('_').unwrap_or(b.len())];
            if pa == pb { *b = a.clone(); true } else { false }
        });
        return Some(LocFormat::PerLang(per_lang));
    }
    None
}

fn detect_cards_file(dir: &Path) -> Option<PathBuf> {
    find_latest_file(dir, "Raw_CardDatabase_")
        .or_else(|| find_latest_file(dir, "Data_cards_"))
}

/// Returns true if `dir` contains MTGA data files (either format).
fn dir_has_mtga_data(dir: &Path) -> bool {
    detect_loc_format(dir).is_some() && detect_cards_file(dir).is_some()
}

// ─── Path resolution ──────────────────────────────────────────────────────────

fn resolve_data_dir(folder_path: &str) -> Result<PathBuf, String> {
    let base = PathBuf::from(folder_path);

    let candidates = [
        // New layout (2024+): Downloads/Raw/
        base.join("MTGA_Data").join("Downloads").join("Raw"),
        base.join("Downloads").join("Raw"),
        // Old layout: Downloads/Data/
        base.join("MTGA_Data").join("Downloads").join("Data"),
        base.join("Downloads").join("Data"),
        // Bare Downloads or base itself
        base.join("MTGA_Data").join("Downloads"),
        base.join("Downloads"),
        base.join("Raw"),
        base.join("Data"),
        base.clone(),
        // MTGA sub-folder (some Steam installs)
        base.join("MTGA").join("MTGA_Data").join("Downloads").join("Raw"),
        base.join("MTGA").join("MTGA_Data").join("Downloads").join("Data"),
        // Hardcoded default install paths (new layout)
        PathBuf::from(r"C:\Program Files\Wizards of the Coast\MTGA\MTGA_Data\Downloads\Raw"),
        PathBuf::from(r"C:\Program Files (x86)\Wizards of the Coast\MTGA\MTGA_Data\Downloads\Raw"),
        PathBuf::from(r"C:\Program Files\Wizards Of The Coast\MTGA\MTGA_Data\Downloads\Raw"),
        // Hardcoded default install paths (old layout)
        PathBuf::from(r"C:\Program Files\Wizards of the Coast\MTGA\MTGA_Data\Downloads\Data"),
        PathBuf::from(r"C:\Program Files (x86)\Wizards of the Coast\MTGA\MTGA_Data\Downloads\Data"),
    ];

    for c in &candidates {
        if c.exists() && dir_has_mtga_data(c) {
            return Ok(c.clone());
        }
    }

    // Shallow recursive scan (depth ≤ 5, only relevant directory names)
    if let Some(found) = find_data_dir_recursive(&base, 0) {
        return Ok(found);
    }

    Err(format!(
        "Fichiers MTGA introuvables à partir de : {folder_path}\n\
         \n\
         MTGA 2024+ stocke ses données dans :\n\
         …\\MTGA_Data\\Downloads\\Raw\\\n\
         Versions antérieures : …\\MTGA_Data\\Downloads\\Data\\\n\
         \n\
         Utilisez le bouton 📁 pour naviguer directement jusqu'au dossier Raw (ou Data)."
    ))
}

fn find_data_dir_recursive(dir: &Path, depth: u8) -> Option<PathBuf> {
    if depth > 5 { return None; }
    if dir_has_mtga_data(dir) {
        return Some(dir.to_path_buf());
    }
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_dir() { continue; }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_ascii_lowercase();
        let relevant = ["data", "download", "raw", "mtga", "wizards", "magic", "alt", "asset"]
            .iter().any(|k| name.contains(k));
        if relevant || depth < 2 {
            if let Some(found) = find_data_dir_recursive(&path, depth + 1) {
                return Some(found);
            }
        }
    }
    None
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

/// Parse a localization file and extract id→name for the requested `lang_code`.
///
/// Handles several formats:
/// A) New combined file: array of per-language objects
///    `[{"langkey":"frFR","keys":[{"id":N,"text":"..."}]}, ...]`
/// B) New combined file: array of multi-lang entries
///    `[{"id":N,"frFR":"...","deDE":"...",...}]`
///    or `{"keys":[{"id":N,"frFR":"..."}]}`
/// C) Object keyed by lang code: `{"frFR":[{"id":N,"text":"..."}],...}`
/// D) Old per-language file: `{"langkey":"frFR","keys":[{"id":N,"text":"..."}]}`
/// E) Old per-language flat array: `[{"id":N,"text":"..."}]`
fn parse_loc_file(path: &Path, lang_code: &str) -> Result<LocMap, String> {
    // New MTGA 2024+ format: SQLite database — keyed by English card name
    if is_sqlite_file(path) {
        return parse_loc_file_sqlite(path, lang_code).map(LocMap::ByEnName);
    }

    let text = read_text(path).map_err(|e| format!("Lecture fichier loc : {e}"))?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|e| format!("JSON invalide dans {}: {e}", path.display()))?;

    // ── Format A : array where each element is a per-lang block ──────────────
    if let Some(arr) = value.as_array() {
        for entry in arr {
            let langkey = entry.get("langkey").and_then(|v| v.as_str()).unwrap_or("");
            if langkey.eq_ignore_ascii_case(lang_code) {
                if let Some(map) = extract_id_text_array(entry.get("keys")) {
                    if !map.is_empty() { return Ok(LocMap::ById(map)); }
                }
            }
        }

        // ── Format B : array of multi-lang objects {id, frFR, deDE, …} ──────
        let short = &lang_code[..2];
        let mut map = HashMap::new();
        for k in arr {
            let id = match k.get("id").and_then(|v| v.as_i64()) {
                Some(v) => v, None => continue,
            };
            let text = k.get(lang_code)
                .or_else(|| k.get(&format!("{}{}", &short[..1].to_uppercase(), &short[1..])))
                .and_then(|v| v.as_str());
            if let Some(t) = text { map.insert(id, t.to_string()); }
        }
        if !map.is_empty() { return Ok(LocMap::ById(map)); }

        // ── Format E : old flat array [{"id":N,"text":"..."}] ────────────────
        if let Some(map) = extract_id_text_array(Some(&value)) {
            if !map.is_empty() { return Ok(LocMap::ById(map)); }
        }
    }

    // ── Format C : object keyed by lang code {"frFR":[...], "deDE":[...]} ───
    if let Some(arr) = value.get(lang_code).and_then(|v| v.as_array()) {
        if let Some(map) = extract_id_text_array(Some(&Value::Array(arr.clone()))) {
            if !map.is_empty() { return Ok(LocMap::ById(map)); }
        }
    }

    // ── Format B inside {"keys":[...]} ───────────────────────────────────────
    if let Some(keys) = value.get("keys").and_then(|v| v.as_array()) {
        let short = &lang_code[..2];
        let mut map = HashMap::new();
        for k in keys {
            let id = match k.get("id").and_then(|v| v.as_i64()) {
                Some(v) => v, None => continue,
            };
            let text = k.get(lang_code)
                .or_else(|| k.get(&format!("{}{}", &short[..1].to_uppercase(), &short[1..])))
                .and_then(|v| v.as_str());
            if let Some(t) = text { map.insert(id, t.to_string()); }
        }
        if !map.is_empty() { return Ok(LocMap::ById(map)); }

        // ── Format D : old per-language flat keys array ───────────────────────
        if let Some(map) = extract_id_text_array(Some(&Value::Array(keys.clone()))) {
            if !map.is_empty() { return Ok(LocMap::ById(map)); }
        }
    }

    Err(format!(
        "Langue '{lang_code}' introuvable dans {}\n\
         Formats essayés : combined-array, multi-lang, per-lang-key, old-single.",
        path.file_name().unwrap_or_default().to_string_lossy()
    ))
}

/// Helper: extract HashMap<id, text> from an array value of {"id":N,"text":"..."} objects.
fn extract_id_text_array(arr_val: Option<&Value>) -> Option<HashMap<i64, String>> {
    let arr = arr_val?.as_array()?;
    let map: HashMap<i64, String> = arr.iter()
        .filter_map(|k| {
            let id   = k.get("id").and_then(|v| v.as_i64())?;
            let text = k.get("text").and_then(|v| v.as_str())?;
            Some((id, text.to_string()))
        })
        .collect();
    Some(map)
}

fn parse_cards_file(path: &Path) -> Result<Vec<MtgaCardEntry>, String> {
    // New MTGA 2024+ format: SQLite database
    if is_sqlite_file(path) {
        return parse_cards_file_sqlite(path);
    }

    let text = read_text(path).map_err(|e| format!("Lecture fichier cards : {e}"))?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|e| format!("JSON invalide cards : {e}"))?;

    // Format A — array at root
    if let Some(arr) = value.as_array() {
        return Ok(arr.iter()
            .filter_map(|v| serde_json::from_value::<MtgaCardEntry>(v.clone()).ok())
            .collect());
    }
    // Format B — {"cards":[...]}  or  {"data":[...]}
    for key in &["cards", "data", "Cards"] {
        if let Some(arr) = value.get(key).and_then(|v| v.as_array()) {
            return Ok(arr.iter()
                .filter_map(|v| serde_json::from_value::<MtgaCardEntry>(v.clone()).ok())
                .collect());
        }
    }

    Err("Format de fichier cards non reconnu (ni tableau ni {cards:[...]})".to_string())
}

// ─── Tauri commands ───────────────────────────────────────────────────────────

/// Validates the MTGA folder and lists the data files found.
#[tauri::command]
pub fn scan_mtga_folder(folder_path: String) -> Result<Value, String> {
    let data_dir = resolve_data_dir(&folder_path)?;

    let cards_file = detect_cards_file(&data_dir);
    let loc_fmt    = detect_loc_format(&data_dir);

    // Build the language list.
    // Priority: Cards DB SQLite (Localizations_* tables) > Loc file > hardcoded fallback.
    let (loc_files, combined): (Vec<String>, bool) = {
        let fallback_langs: Vec<String> = ["frFR","deDE","esES","itIT","ptBR","jaJP","koKR","ruRU","zhCN","zhTW"]
            .iter().map(|l| l.to_string()).collect();

        // Try Cards DB first (most accurate — contains exactly what MTGA ships)
        let langs: Vec<String> = if let Some(cp) = &cards_file {
            if is_sqlite_file(cp) {
                let found = sqlite_cards_available_langs(cp);
                if found.is_empty() { fallback_langs.clone() } else { found }
            } else {
                fallback_langs.clone()
            }
        } else {
            fallback_langs.clone()
        };

        // Encode as fake per-lang filenames so the frontend filter still works.
        // Use loc file name if available, otherwise use cards file name.
        let ref_name = match &loc_fmt {
            Some(LocFormat::Combined(p)) => p.file_name().unwrap_or_default().to_string_lossy().into_owned(),
            Some(LocFormat::PerLang(files)) => files.first().cloned().unwrap_or_default(),
            None => cards_file.as_ref()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
        };
        let names: Vec<String> = langs.iter()
            .map(|l| format!("Data_loc_{l}_{ref_name}"))
            .collect();
        (names, true)
    };

    let ready = !loc_files.is_empty() && cards_file.is_some();

    Ok(serde_json::json!({
        "data_dir":   data_dir.to_string_lossy().into_owned(),
        "loc_files":  loc_files,
        "cards_file": cards_file.as_ref().map(|p| p.file_name().unwrap_or_default().to_string_lossy().into_owned()),
        "ready":      ready,
        "combined_loc": combined,
    }))
}

/// Dump the full schema of Raw_CardDatabase_*.mtga for diagnostic purposes.
/// Returns table names + all column names + first 3 sample rows per table.
#[tauri::command]
pub fn inspect_cards_db(folder_path: String) -> Result<String, String> {
    let data_dir = resolve_data_dir(&folder_path)?;
    let cards_path = detect_cards_file(&data_dir)
        .ok_or("Raw_CardDatabase_*.mtga introuvable")?;

    if !is_sqlite_file(&cards_path) {
        return Ok(format!("Fichier JSON (non SQLite) : {}", cards_path.display()));
    }

    let conn = rusqlite::Connection::open(&cards_path)
        .map_err(|e| e.to_string())?;
    let tables = sqlite_tables(&conn)?;

    let mut out = format!("Fichier : {}\n\n", cards_path.file_name().unwrap_or_default().to_string_lossy());

    for table in &tables {
        let cols = sqlite_columns(&conn, table)?;
        out.push_str(&format!("TABLE «{}» ({} colonnes)\n  {}\n",
            table, cols.len(), cols.join(", ")));

        // Count rows
        let count: i64 = conn.query_row(
            &format!("SELECT count(*) FROM \"{table}\""), [], |r| r.get(0)
        ).unwrap_or(-1);
        out.push_str(&format!("  {} lignes\n", count));

        // First 2 sample rows (show all column values)
        if count > 0 && !cols.is_empty() {
            let sql = format!("SELECT * FROM \"{}\" LIMIT 2", table);
            if let Ok(mut stmt) = conn.prepare(&sql) {
                let col_count = cols.len();
                let rows: Vec<Vec<String>> = stmt
                    .query_map([], |r| {
                        let vals: Vec<String> = (0..col_count)
                            .map(|i| {
                                r.get::<_, String>(i)
                                    .or_else(|_| r.get::<_, i64>(i).map(|n| n.to_string()))
                                    .or_else(|_| r.get::<_, f64>(i).map(|f| format!("{f:.2}")))
                                    .unwrap_or_else(|_| "NULL".to_string())
                            })
                            .collect();
                        Ok(vals)
                    })
                    .ok()
                    .map(|rows| rows.filter_map(|r| r.ok()).collect())
                    .unwrap_or_default();

                for row in &rows {
                    let pairs: Vec<String> = cols.iter().zip(row.iter())
                        .map(|(c, v)| {
                            // Truncate long values — use char boundary, not byte index
                            let v_short: String = v.chars().take(60).collect();
                            let v_short = if v.chars().count() > 60 {
                                format!("{v_short}…")
                            } else {
                                v_short
                            };
                            format!("{c}={v_short:?}")
                        })
                        .collect();
                    out.push_str(&format!("  ROW: {}\n", pairs.join("  ")));
                }
            }
        }
        out.push('\n');
    }
    Ok(out)
}

/// Backfill `arena_id` from the raw MTGA SQLite for cards Scryfall imported
/// with a NULL arena_id (recent sets where Scryfall hasn't backfilled the Arena
/// IDs yet — e.g. Marvel's Spider-Man `spm`). These cards are otherwise hidden by
/// the `arena_id IS NOT NULL` display filter.
///
/// Match is by `(ExpansionCode, CollectorNumber)` on primary cards — unambiguous
/// (set+number is unique, so reprints sharing a name are not a problem).
/// Idempotent: only touches rows where `arena_id IS NULL`.
fn backfill_arena_ids(raw_path: &Path, app_db: &Path) -> Result<usize, String> {
    if !is_sqlite_file(raw_path) {
        return Ok(0);
    }
    let raw = rusqlite::Connection::open(raw_path).map_err(|e| e.to_string())?;

    // ── Passe 1 : index (set minuscule, numéro de collection) → GrpId ─────────
    // Match exact et non ambigu (set+numéro est unique). Couvre la majorité des
    // sets récents non backfillés par Scryfall (ex : spm).
    let mut grp_by_key: HashMap<(String, String), i64> = HashMap::new();
    // ── Passe 2 (préparation) : index nom anglais normalisé → GrpId ──────────
    // Le raw MTGA range les cartes Alchemy sous des codes annuels (Y22..Y26) alors
    // que Scryfall utilise des codes par-set (yeoe, yotj…) avec des numéros de
    // collection différents : le match (set, numéro) échoue donc totalement pour
    // elles. On les rattrape par leur nom anglais, à condition qu'il soit unique
    // dans le pool Arena (sinon on s'abstient pour éviter un faux appariement).
    let en_loc = load_loc_table(&raw, "Localizations_enUS").unwrap_or_default();
    let mut grp_by_name: HashMap<String, i64> = HashMap::new();
    let mut ambiguous_names: std::collections::HashSet<String> = std::collections::HashSet::new();

    {
        let mut stmt = raw
            .prepare(
                "SELECT lower(ExpansionCode), CollectorNumber, GrpId, TitleId FROM Cards \
                 WHERE ExpansionCode IS NOT NULL AND ExpansionCode != '' \
                   AND IsPrimaryCard = 1",
            )
            .map_err(|e| e.to_string())?;
        let mut q = stmt.query([]).map_err(|e| e.to_string())?;
        while let Some(r) = q.next().map_err(|e| e.to_string())? {
            let set: String = r.get(0).map_err(|e| e.to_string())?;
            let coll: Option<String> = r.get(1).map_err(|e| e.to_string())?;
            let grp: i64 = r.get(2).map_err(|e| e.to_string())?;
            let title: Option<i64> = r.get(3).map_err(|e| e.to_string())?;

            if let Some(c) = coll.as_ref().filter(|c| !c.is_empty()) {
                grp_by_key.entry((set.clone(), c.clone())).or_insert(grp);
            }

            if let Some(name) = title.and_then(|t| en_loc.get(&t)) {
                let key = name.trim().to_lowercase();
                if !key.is_empty() {
                    match grp_by_name.get(&key) {
                        Some(g) if *g != grp => { ambiguous_names.insert(key); }
                        None => { grp_by_name.insert(key, grp); }
                        _ => {}
                    }
                }
            }
        }
    }
    // On retire les noms portés par plusieurs cartes distinctes (reprints…).
    for k in &ambiguous_names {
        grp_by_name.remove(k);
    }

    let conn = crate::database::open(app_db).map_err(|e| e.to_string())?;

    // Un seul balayage des cartes sans arena_id, puis UPDATE par clé primaire (indexée).
    // `id` est l'UUID Scryfall (TEXT), pas un entier.
    let targets: Vec<(String, String, Option<String>, Option<String>)> = {
        let mut sel = conn
            .prepare(
                "SELECT id, lower(set_code), collector_number, name_en FROM cards \
                 WHERE arena_id IS NULL AND set_code IS NOT NULL",
            )
            .map_err(|e| e.to_string())?;
        let rows: Vec<(String, String, Option<String>, Option<String>)> = sel
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        rows
    };

    let mut updated = 0usize;
    conn.execute_batch("BEGIN TRANSACTION").map_err(|e| e.to_string())?;
    {
        let mut up = conn
            .prepare("UPDATE cards SET arena_id = ?1 WHERE id = ?2")
            .map_err(|e| e.to_string())?;
        for (id, set, coll, name) in &targets {
            // 1) match exact (set, numéro) ; 2) repli sur le nom anglais unique.
            let grp = coll
                .as_ref()
                .filter(|c| !c.is_empty())
                .and_then(|c| grp_by_key.get(&(set.clone(), c.clone())).copied())
                .or_else(|| {
                    name.as_ref()
                        .and_then(|n| grp_by_name.get(&n.trim().to_lowercase()).copied())
                });
            if let Some(grp) = grp {
                updated += up.execute(params![grp, id]).map_err(|e| e.to_string())?;
            }
        }
    }
    conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
    println!("[backfill] {updated} arena_id restaurés depuis le raw MTGA");
    Ok(updated)
}

/// Syncs localised card names for ONE language from MTGA data files into SQLite.
#[tauri::command]
pub async fn sync_loc_from_mtga(
    db:          State<'_, DbPath>,
    folder_path: String,
    lang_code:   String,
    app:         tauri::AppHandle,
) -> Result<(), String> {
    macro_rules! emit {
        ($stage:expr, $found:expr, $updated:expr, $done:expr, $err:expr) => {
            let _ = app.emit("mtga-sync-progress", MtgaSyncProgress {
                stage:         $stage.to_string(),
                cards_found:   $found,
                cards_updated: $updated,
                done:          $done,
                error:         $err,
            });
        };
    }

    emit!("scan", 0, 0, false, None);

    let data_dir = resolve_data_dir(&folder_path)
        .map_err(|e| { emit!("error", 0, 0, true, Some(e.clone())); e })?;

    let cards_path = detect_cards_file(&data_dir)
        .ok_or_else(|| {
            let msg = format!(
                "Fichier de cartes introuvable dans :\n{}\n\
                 Attendu : Raw_CardDatabase_*.mtga (ou Data_cards_*.mtga)",
                data_dir.display()
            );
            emit!("error", 0, 0, true, Some(msg.clone()));
            msg
        })?;

    emit!("parse", 0, 0, false, None);

    // ── Backfill arena_id depuis le raw (sets récents non backfillés par Scryfall) ──
    // Rend visibles les cartes importées de Scryfall avec arena_id NULL (ex : spm).
    // Indépendant de la langue ; idempotent (ne touche que les arena_id NULL).
    if let Err(e) = backfill_arena_ids(&cards_path, &db.0) {
        // Non bloquant : un échec ici ne doit pas empêcher la sync des traductions.
        eprintln!("Backfill arena_id ignoré : {e}");
    }

    // ── Build arena_id → localised name ──────────────────────────────────────
    // New format (2024+): Raw_CardDatabase_*.mtga is SQLite and embeds all
    // Localizations_* tables directly.  We do a single JOIN inside that file:
    //   Cards.TitleId = Localizations_{lang_code}.LocId  WHERE Formatted=0
    // This covers ALL Arena cards (~25 000) in one query — no external loc file needed.
    //
    // Old format (pre-2024): JSON cards + separate Raw_ClientLocalization_*.mtga.
    // We keep that path as a fallback for legacy installations.
    // CardLocRow : (GrpId, localised_name, localised_body_text, en_name)
    // loc_body is None for legacy JSON path (no body text available there).
    // en_name is used for name-based fallback matching when arena_id is not set.
    let id_to_name: Vec<CardLocRow> = if is_sqlite_file(&cards_path) {
        sync_names_from_cards_sqlite(&cards_path, &lang_code)
            .map_err(|e| {
                let msg = format!("Erreur sync SQLite ({lang_code}) : {e}");
                emit!("error", 0, 0, true, Some(msg.clone()));
                msg
            })?
    } else {
        // ── Legacy JSON path — body text not available ────────────────────────
        let loc_path = if let Some(p) = find_latest_file(&data_dir, "Raw_ClientLocalization_") {
            p
        } else {
            let prefix = format!("Data_loc_{lang_code}_");
            find_latest_file(&data_dir, &prefix)
                .ok_or_else(|| {
                    let msg = format!(
                        "Fichier de localisation introuvable pour '{lang_code}' dans :\n{}\n\
                         Attendu : Raw_ClientLocalization_*.mtga (ou Data_loc_{lang_code}_*.mtga)",
                        data_dir.display()
                    );
                    emit!("error", 0, 0, true, Some(msg.clone()));
                    msg
                })?
        };

        let loc_map = parse_loc_file(&loc_path, &lang_code)
            .map_err(|e| {
                let msg = format!("Erreur lecture localisation ({lang_code}) : {e}");
                emit!("error", 0, 0, true, Some(msg.clone()));
                msg
            })?;

        let card_entries = parse_cards_file(&cards_path)
            .map_err(|e| {
                let msg = format!("Erreur lecture cards : {e}");
                emit!("error", 0, 0, true, Some(msg.clone()));
                msg
            })?;

        match &loc_map {
            LocMap::ById(_) => {
                card_entries.iter()
                    .filter_map(|c| {
                        let grp_id = c.grp_id?;
                        let name = loc_map.get_by_id(c.title_id?).cloned()?;
                        Some(CardLocRow { grp_id, loc_name: name, loc_body: None, loc_type: None, en_name: String::new() })
                    })
                    .collect()
            },
            LocMap::ByEnName(en_to_name) => {
                let lower_map: HashMap<String, String> = en_to_name.iter()
                    .map(|(k, v)| (k.to_lowercase(), v.clone()))
                    .collect();
                let conn_tmp = crate::database::open(&db.0).map_err(|e| e.to_string())?;
                let mut stmt = conn_tmp
                    .prepare(
                        "SELECT arena_id, name_en FROM cards \
                         WHERE name_en IS NOT NULL AND name_en != '' AND arena_id IS NOT NULL"
                    )
                    .map_err(|e| format!("Requête app DB : {e}"))?;
                let app_cards: Vec<(i64, String)> = stmt
                    .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
                    .map_err(|e| e.to_string())?
                    .filter_map(|r| r.ok())
                    .collect();
                app_cards.into_iter()
                    .filter_map(|(arena_id, name_en)| {
                        let translated = en_to_name.get(&name_en)
                            .or_else(|| lower_map.get(&name_en.to_lowercase()))?;
                        Some(CardLocRow { grp_id: arena_id, loc_name: translated.clone(), loc_body: None, loc_type: None, en_name: String::new() })
                    })
                    .collect()
            },
        }
    };

    let cards_found = id_to_name.len();
    emit!("update", cards_found, 0, false, None);

    if cards_found == 0 {
        let msg = format!(
            "0 carte traduite pour la langue '{lang_code}'.\n\
             Vérifie que le dossier MTGA contient Raw_CardDatabase_*.mtga \
             et que la table Localizations_{lang_code} existe."
        );
        emit!("error", 0, 0, true, Some(msg.clone()));
        return Err(msg);
    }

    // Open app DB for the UPDATE passes
    let conn = crate::database::open(&db.0).map_err(|e| e.to_string())?;

    // Index on name_en makes pass-2 lookups O(log n) instead of a full table scan
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_cards_name_en ON cards(name_en)",
    )
    .ok();

    // Index on arena_id : indispensable pour la passe 1 (UPDATE/INSERT WHERE arena_id = ?).
    // Sans lui, chaque carte déclenche un balayage complet de la table (~21k lignes)
    // → le sync devenait extrêmement lent (≈1 milliard de comparaisons au total).
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_cards_arena_id ON cards(arena_id)",
    )
    .ok();

    let mut updated = 0usize;
    // Track which GrpIds already matched by arena_id so we skip them in pass 2
    let mut matched_by_id: std::collections::HashSet<i64> = std::collections::HashSet::new();

    // ── Pass 1 : arena_id match — 500 rows per transaction ───────────────────
    // Each chunk is committed separately so events can be delivered to the UI.
    let is_fr = lang_code == "frFR";
    for chunk in id_to_name.chunks(500) {
        let res = tokio::task::block_in_place(|| -> Result<(), String> {
            conn.execute_batch("BEGIN TRANSACTION").map_err(|e| e.to_string())?;
            for row in chunk {
                // Pour frFR : met aussi à jour cards.name_fr (compatibilité FTS5)
                if is_fr {
                    let rows = conn
                        .execute(
                            "UPDATE cards SET name_fr = ?1, oracle_text_fr = ?2, type_line_fr = ?3 \
                             WHERE arena_id = ?4",
                            params![row.loc_name, row.loc_body, row.loc_type, row.grp_id],
                        )
                        .map_err(|e| e.to_string())?;
                    if rows > 0 {
                        updated += rows;
                        matched_by_id.insert(row.grp_id);
                    }
                }
                // Toujours écrire dans card_translations (multilingue)
                let ct_rows = conn
                    .execute(
                        "INSERT OR REPLACE INTO card_translations \
                         (card_id, lang, name, oracle_text, type_line) \
                         SELECT id, ?1, ?2, ?3, ?4 FROM cards WHERE arena_id = ?5",
                        params![lang_code, row.loc_name, row.loc_body, row.loc_type, row.grp_id],
                    )
                    .map_err(|e| e.to_string())?;
                if !is_fr && ct_rows > 0 {
                    updated += ct_rows;
                    matched_by_id.insert(row.grp_id);
                }
            }
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
            Ok(())
        });
        res?;
        emit!("update", cards_found, updated, false, None);
        tokio::task::yield_now().await;
    }

    // ── Pass 2 : name_en fallback — 500 rows per transaction ─────────────────
    // Matches by English card name. Does NOT write arena_id (reprints share the
    // same name but have different GrpIds — setting arena_id here would be wrong).
    let pass2: Vec<&CardLocRow> = id_to_name
        .iter()
        .filter(|row| !matched_by_id.contains(&row.grp_id) && !row.en_name.is_empty())
        .collect();

    for chunk in pass2.chunks(500) {
        let res = tokio::task::block_in_place(|| -> Result<(), String> {
            conn.execute_batch("BEGIN TRANSACTION").map_err(|e| e.to_string())?;
            for row in chunk.iter() {
                // Pour frFR : met aussi à jour cards.name_fr (FTS5)
                if is_fr {
                    let rows = conn
                        .execute(
                            "UPDATE cards SET name_fr = ?1, oracle_text_fr = ?2, type_line_fr = ?3 \
                             WHERE name_en = ?4 AND (name_fr IS NULL OR name_fr = '')",
                            params![row.loc_name, row.loc_body, row.loc_type, row.en_name],
                        )
                        .map_err(|e| e.to_string())?;
                    updated += rows;
                }
                // card_translations : INSERT OR IGNORE (ne pas écraser les matches du pass 1)
                conn.execute(
                    "INSERT OR IGNORE INTO card_translations \
                     (card_id, lang, name, oracle_text, type_line) \
                     SELECT id, ?1, ?2, ?3, ?4 FROM cards WHERE name_en = ?5",
                    params![lang_code, row.loc_name, row.loc_body, row.loc_type, row.en_name],
                )
                .map_err(|e| e.to_string())?;
            }
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
            Ok(())
        });
        res?;
        emit!("update", cards_found, updated, false, None);
        tokio::task::yield_now().await;
    }

    emit!("done", cards_found, updated, true, None);
    Ok(())
}

// ─── Collection sync via process memory (ReadProcessMemory) ──────────────────

/// Reads the MTGA card collection directly from the game's process memory.
///
/// How it works (same approach as NthPhantom10/MTGA-collection-exporter):
///   1. Find MTGA.exe process ID via CreateToolhelp32Snapshot
///   2. Open the process with PROCESS_VM_READ | PROCESS_QUERY_INFORMATION
///   3. Enumerate all committed, readable memory regions with VirtualQueryEx
///   4. For each region, read bytes and scan for the largest contiguous block
///      of valid (arena_id, quantity) u32 pairs:
///        arena_id  ∈ [1 000, 900 000]   (MTGA card IDs)
///        quantity  ∈ [1, 400]
///   5. The largest such block (≥ 100 pairs) is the collection.
///
/// Prerequisites:
///   - MTGA must be running and the user logged in.
///   - The user must have opened the Collection tab and scrolled through it
///     (so the card data is fully loaded into memory).
#[tauri::command]
pub fn read_collection_from_memory() -> Result<Value, String> {
    #[cfg(not(target_os = "windows"))]
    return Err("La lecture mémoire n'est disponible que sur Windows.".to_string());

    #[cfg(target_os = "windows")]
    {
        let pid = mem_reader::find_mtga_pid().ok_or_else(|| {
            "MTGA.exe n'est pas en cours d'exécution.\n\n\
             Pour synchroniser votre collection :\n\
             1. Lancez MTGA et connectez-vous\n\
             2. Ouvrez l'onglet Collection dans MTGA\n\
             3. Faites défiler votre collection quelques secondes\n\
             4. Revenez ici et cliquez à nouveau sur Sync Collection"
                .to_string()
        })?;

        let collection = mem_reader::scan_collection(pid)
            .map_err(|e| format!("Erreur lecture mémoire MTGA (PID {pid}) : {e}"))?;

        if collection.is_empty() {
            return Err(
                "Collection introuvable dans la mémoire de MTGA.\n\n\
                 Assurez-vous que :\n\
                 1. Vous êtes connecté dans MTGA\n\
                 2. Vous avez ouvert l'onglet Collection\n\
                 3. Vous avez fait défiler votre collection (quelques secondes)\n\
                 puis cliquez à nouveau sur Sync Collection."
                    .to_string(),
            );
        }

        let total = collection.len();
        let cards_value: serde_json::Map<String, Value> = collection
            .into_iter()
            .map(|(k, v)| (k.to_string(), Value::Number(serde_json::Number::from(v as i64))))
            .collect();

        Ok(serde_json::json!({
            "cards":        cards_value,
            "total_unique": total,
            "log_path":     "process memory (MTGA.exe)",
        }))
    }
}

/// Windows process-memory reader for MTGA collection data.
#[cfg(target_os = "windows")]
mod mem_reader {
    use std::collections::HashMap;
    use winapi::um::handleapi::{CloseHandle, INVALID_HANDLE_VALUE};
    use winapi::um::memoryapi::{ReadProcessMemory, VirtualQueryEx};
    use winapi::um::processthreadsapi::OpenProcess;
    use winapi::um::tlhelp32::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW,
        PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use winapi::um::winnt::{
        MEMORY_BASIC_INFORMATION, MEM_COMMIT,
        PAGE_EXECUTE_READ, PAGE_EXECUTE_READWRITE,
        PAGE_GUARD, PAGE_READONLY, PAGE_READWRITE,
        PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
    };

    /// Find the PID of MTGA.exe. Returns None if MTGA is not running.
    pub fn find_mtga_pid() -> Option<u32> {
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return None;
            }
            let mut e: PROCESSENTRY32W = std::mem::zeroed();
            e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;

            if Process32FirstW(snap, &mut e) == 0 {
                CloseHandle(snap);
                return None;
            }
            loop {
                let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(0);
                let name = String::from_utf16_lossy(&e.szExeFile[..len]);
                if name.eq_ignore_ascii_case("MTGA.exe") {
                    let pid = e.th32ProcessID;
                    CloseHandle(snap);
                    return Some(pid);
                }
                if Process32NextW(snap, &mut e) == 0 {
                    break;
                }
            }
            CloseHandle(snap);
            None
        }
    }

    /// Open the MTGA process and scan its committed, readable memory regions.
    /// Returns a HashMap<arena_id, quantity> representing the full collection.
    pub fn scan_collection(pid: u32) -> Result<HashMap<u32, u32>, String> {
        let handle =
            unsafe { OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, 0, pid) };
        if handle.is_null() {
            return Err(
                "Accès refusé au processus MTGA.\n\
                 Essayez de relancer MTGABuilder en tant qu'administrateur."
                    .to_string(),
            );
        }

        let mut best: HashMap<u32, u32> = HashMap::new();
        let mut addr: usize = 0;

        // Skip regions larger than 32 MB — the collection is ≤ a few hundred KB.
        // Unity GC heap segments are typically 1–16 MB, so this covers them.
        const MAX_REGION: usize = 32 * 1024 * 1024;

        loop {
            let mut mbi: MEMORY_BASIC_INFORMATION = unsafe { std::mem::zeroed() };
            if unsafe {
                VirtualQueryEx(
                    handle,
                    addr as *const _,
                    &mut mbi,
                    std::mem::size_of::<MEMORY_BASIC_INFORMATION>(),
                )
            } == 0
            {
                break;
            }

            let region_end = match (mbi.BaseAddress as usize).checked_add(mbi.RegionSize) {
                Some(a) => a,
                None => break,
            };

            let protect_base = mbi.Protect & 0xFF;
            let is_readable = mbi.State == MEM_COMMIT
                && (mbi.Protect & PAGE_GUARD) == 0
                && matches!(
                    protect_base,
                    PAGE_READWRITE
                        | PAGE_READONLY
                        | PAGE_EXECUTE_READ
                        | PAGE_EXECUTE_READWRITE
                );

            // Region must hold at least 100 valid pairs (800 bytes) and be ≤ 32 MB
            if is_readable && mbi.RegionSize >= 800 && mbi.RegionSize <= MAX_REGION {
                let mut buf = vec![0u8; mbi.RegionSize];
                let mut bytes_read: usize = 0;

                let ok = unsafe {
                    ReadProcessMemory(
                        handle,
                        mbi.BaseAddress,
                        buf.as_mut_ptr() as *mut _,
                        mbi.RegionSize,
                        &mut bytes_read as *mut usize as *mut _,
                    )
                };

                if ok != 0 && bytes_read >= 8 {
                    // Try both 4-byte alignment offsets (0 and 4 bytes into the buffer)
                    for off in 0..2usize {
                        let blk = collect_block(&buf[..bytes_read], off * 4);
                        if blk.len() > best.len() {
                            best = blk;
                        }
                    }
                }
            }

            addr = region_end;
        }

        unsafe { CloseHandle(handle) };
        Ok(best)
    }

    /// Scan `data` with an 8-byte stride starting at `start_offset`.
    /// Each step reads one (u32, u32) pair as (candidate_arena_id, candidate_qty).
    /// Accumulates runs of valid pairs; returns the longest run with ≥ MIN_PAIRS entries.
    ///
    /// Valid pair: arena_id ∈ [1 000, 900 000], qty ∈ [1, 400].
    /// Tolerates up to MAX_MISSES consecutive invalid pairs inside a run (handles
    /// any bookkeeping words that may interleave the card data in memory).
    fn collect_block(data: &[u8], start_offset: usize) -> HashMap<u32, u32> {
        const LO_ID:    u32   = 1_000;
        const HI_ID:    u32   = 900_000;
        const LO_QT:    u32   = 1;
        const HI_QT:    u32   = 400;
        const MIN_PAIRS: usize = 100;  // minimum pairs to be considered a real collection
        const MAX_MISS:  usize = 5;    // allow up to 5 consecutive invalid pairs in a run

        let mut best: HashMap<u32, u32> = HashMap::new();
        let mut cur:  HashMap<u32, u32> = HashMap::new();
        let mut miss = 0usize;

        let mut i = start_offset;
        while i + 8 <= data.len() {
            let id  = u32::from_le_bytes(data[i..i + 4].try_into().unwrap());
            let qty = u32::from_le_bytes(data[i + 4..i + 8].try_into().unwrap());

            if id >= LO_ID && id <= HI_ID && qty >= LO_QT && qty <= HI_QT {
                cur.insert(id, qty);
                miss = 0;
            } else {
                miss += 1;
                if miss > MAX_MISS {
                    if cur.len() >= MIN_PAIRS && cur.len() > best.len() {
                        best = std::mem::take(&mut cur);
                    } else {
                        cur.clear();
                    }
                    miss = 0;
                }
            }
            i += 8;
        }

        // Check the final run
        if cur.len() >= MIN_PAIRS && cur.len() > best.len() {
            best = cur;
        }
        best
    }
}

/// Saves the personal collection into the local SQLite database.
#[tauri::command]
pub fn save_collection(db: State<DbPath>, cards_json: String) -> Result<usize, String> {
    let cards: HashMap<String, i64> =
        serde_json::from_str(&cards_json).map_err(|e| format!("JSON invalide : {e}"))?;

    let conn = crate::database::open(&db.0).map_err(|e| e.to_string())?;

    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS collection (
            arena_id  INTEGER PRIMARY KEY,
            quantity  INTEGER NOT NULL DEFAULT 0,
            synced_at TEXT    DEFAULT (datetime('now'))
         );"
    ).map_err(|e| e.to_string())?;

    conn.execute("DELETE FROM collection", []).map_err(|e| e.to_string())?;

    let mut saved = 0usize;
    for (id_str, qty) in &cards {
        if let Ok(arena_id) = id_str.parse::<i64>() {
            conn.execute(
                "INSERT INTO collection (arena_id, quantity) VALUES (?1, ?2)",
                params![arena_id, qty],
            ).map_err(|e| e.to_string())?;
            saved += 1;
        }
    }
    Ok(saved)
}
