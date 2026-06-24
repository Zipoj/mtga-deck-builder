use crate::database::DbPath;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Combo {
    pub id: i64,
    pub name: String,
    pub cards: Vec<String>,      // noms EN des cartes
    pub description: String,
    pub tags: String,
    pub source: String,          // "manual" | "commanderspellbook"
    pub created_at: String,
    pub is_favorite: bool,
}

/// Retourne tous les combos
#[tauri::command]
pub fn get_combos(db: State<DbPath>) -> Result<Vec<Combo>, String> {
    let conn = crate::database::open(&db.0).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, cards, description, tags, source, created_at, is_favorite FROM combos ORDER BY is_favorite DESC, id DESC")
        .map_err(|e| e.to_string())?;

    let combos = stmt
        .query_map([], |row| {
            let cards_json: String = row.get(2)?;
            let cards: Vec<String> = serde_json::from_str(&cards_json).unwrap_or_default();
            let is_fav: i64 = row.get(7).unwrap_or(0);
            Ok(Combo {
                id: row.get(0)?,
                name: row.get(1)?,
                cards,
                description: row.get(3)?,
                tags: row.get(4)?,
                source: row.get(5)?,
                created_at: row.get(6)?,
                is_favorite: is_fav != 0,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(combos)
}

/// Crée un nouveau combo
#[tauri::command]
pub fn create_combo(
    db: State<DbPath>,
    name: String,
    cards: Vec<String>,
    description: String,
    tags: String,
    source: Option<String>,
) -> Result<Combo, String> {
    let conn = crate::database::open(&db.0).map_err(|e| e.to_string())?;
    let cards_json = serde_json::to_string(&cards).unwrap_or_else(|_| "[]".to_string());
    let src = source.unwrap_or_else(|| "manual".to_string());

    conn.execute(
        "INSERT INTO combos (name, cards, description, tags, source) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![name, cards_json, description, tags, src],
    )
    .map_err(|e| e.to_string())?;

    let id = conn.last_insert_rowid();
    let combo = conn
        .query_row(
            "SELECT id, name, cards, description, tags, source, created_at, is_favorite FROM combos WHERE id = ?1",
            params![id],
            |row| {
                let cards_json: String = row.get(2)?;
                let cards: Vec<String> = serde_json::from_str(&cards_json).unwrap_or_default();
                let is_fav: i64 = row.get(7).unwrap_or(0);
                Ok(Combo {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    cards,
                    description: row.get(3)?,
                    tags: row.get(4)?,
                    source: row.get(5)?,
                    created_at: row.get(6)?,
                    is_favorite: is_fav != 0,
                })
            },
        )
        .map_err(|e| e.to_string())?;

    Ok(combo)
}

/// Supprime un combo
#[tauri::command]
pub fn delete_combo(db: State<DbPath>, id: i64) -> Result<(), String> {
    let conn = crate::database::open(&db.0).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM combos WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Met à jour le statut favori d'un combo
#[tauri::command]
pub fn set_combo_favorite(db: State<DbPath>, id: i64, is_favorite: bool) -> Result<(), String> {
    let conn = crate::database::open(&db.0).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE combos SET is_favorite = ?1 WHERE id = ?2",
        params![is_favorite as i64, id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

/// Récupère le nombre de combos pour une carte depuis Commander Spellbook
#[tauri::command]
pub async fn get_cs_combo_count(card_name: String) -> Result<i64, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("MTGABuilder/1.0")
        .build()
        .map_err(|e| e.to_string())?;

    // Encode les espaces en %20 (pas +) pour Commander Spellbook
    let encoded_name = card_name
        .replace('%', "%25")
        .replace(' ', "%20")
        .replace('\'', "%27")
        .replace(',', "%2C");
    // Pas de page_size — l'API CS renvoie tous les résultats d'un coup (count: null)
    let url = format!(
        "https://backend.commanderspellbook.com/variants/?q=card%3A%22{}%22",
        encoded_name
    );

    eprintln!("[CS] URL: {}", url);
    let resp = client.get(&url).send().await.map_err(|e| {
        eprintln!("[CS] Erreur réseau: {}", e); e.to_string()
    })?;
    eprintln!("[CS] Status: {}", resp.status());
    let text = resp.text().await.map_err(|e| e.to_string())?;
    eprintln!("[CS] Body ({} chars): {}", text.len(), &text[..text.len().min(500)]);

    let data: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;

    // L'API retourne count: null — on compte results directement
    let count = match data["count"].as_i64() {
        Some(n) if n > 0 => n,
        _ => data["results"].as_array().map(|a| {
            eprintln!("[CS] results.len() = {}", a.len());
            a.len() as i64
        }).unwrap_or(0),
    };
    eprintln!("[CS] => count final: {}", count);
    Ok(count)
}

/// Combo « portable » pour l'échange entre joueurs (champs partageables uniquement).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PortableCombo {
    pub name: String,
    pub cards: Vec<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: String,
}

/// Fichier d'export de combos.
#[derive(Debug, Serialize, Deserialize)]
pub struct ComboExportFile {
    pub format: String,
    pub version: u32,
    pub combos: Vec<PortableCombo>,
}

const COMBO_EXPORT_FORMAT: &str = "mtgabuilder-combos";

/// Exporte les combos dont les `ids` sont fournis vers un fichier JSON.
/// Retourne le nombre de combos exportés.
#[tauri::command]
pub fn export_combos(db: State<DbPath>, ids: Vec<i64>, path: String) -> Result<usize, String> {
    if ids.is_empty() {
        return Err("Aucun combo à exporter".to_string());
    }
    let conn = crate::database::open(&db.0).map_err(|e| e.to_string())?;

    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT name, cards, description, tags FROM combos WHERE id IN ({placeholders})"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let params_vec: Vec<&dyn rusqlite::ToSql> =
        ids.iter().map(|id| id as &dyn rusqlite::ToSql).collect();

    let combos: Vec<PortableCombo> = stmt
        .query_map(params_vec.as_slice(), |row| {
            let cards_json: String = row.get(1)?;
            let cards: Vec<String> = serde_json::from_str(&cards_json).unwrap_or_default();
            Ok(PortableCombo {
                name: row.get(0)?,
                cards,
                description: row.get(2).unwrap_or_default(),
                tags: row.get(3).unwrap_or_default(),
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let file = ComboExportFile {
        format: COMBO_EXPORT_FORMAT.to_string(),
        version: 1,
        combos,
    };
    let json = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("Écriture impossible : {e}"))?;
    Ok(file.combos.len())
}

/// Importe des combos depuis un fichier JSON. Accepte trois formes :
/// l'enveloppe `{format,version,combos:[…]}`, un tableau nu `[…]`, ou un combo unique `{…}`.
/// Retourne le nombre de combos importés.
#[tauri::command]
pub fn import_combos(db: State<DbPath>, path: String) -> Result<usize, String> {
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Lecture impossible : {e}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("JSON invalide : {e}"))?;

    // Extrait le tableau de combos selon la forme du fichier.
    let combos: Vec<PortableCombo> = if let Some(arr) = value.get("combos") {
        serde_json::from_value(arr.clone()).map_err(|e| e.to_string())?
    } else if value.is_array() {
        serde_json::from_value(value).map_err(|e| e.to_string())?
    } else {
        vec![serde_json::from_value(value).map_err(|e| e.to_string())?]
    };

    if combos.is_empty() {
        return Err("Aucun combo trouvé dans le fichier".to_string());
    }

    let conn = crate::database::open(&db.0).map_err(|e| e.to_string())?;
    let mut imported = 0usize;
    for c in combos {
        if c.cards.is_empty() {
            continue;
        }
        let cards_json = serde_json::to_string(&c.cards).unwrap_or_else(|_| "[]".to_string());
        conn.execute(
            "INSERT INTO combos (name, cards, description, tags, source) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![c.name, cards_json, c.description, c.tags, "imported"],
        )
        .map_err(|e| e.to_string())?;
        imported += 1;
    }
    Ok(imported)
}

/// Payload reçu depuis l'addon Firefox (via POST /api/combos)
#[derive(Debug, Deserialize)]
pub struct ComboPayload {
    pub name: Option<String>,
    pub cards: Vec<String>,
    pub description: Option<String>,
    pub tags: Option<String>,
    pub source: Option<String>,
}

/// Importe un combo depuis l'API locale (appelé par api_server.rs)
pub fn import_combo_internal(
    conn: &rusqlite::Connection,
    payload: ComboPayload,
) -> rusqlite::Result<i64> {
    let cards_json = serde_json::to_string(&payload.cards).unwrap_or_else(|_| "[]".to_string());
    conn.execute(
        "INSERT INTO combos (name, cards, description, tags, source) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            payload.name.unwrap_or_default(),
            cards_json,
            payload.description.unwrap_or_default(),
            payload.tags.unwrap_or_default(),
            payload.source.unwrap_or_else(|| "commanderspellbook".to_string()),
        ],
    )?;
    Ok(conn.last_insert_rowid())
}
