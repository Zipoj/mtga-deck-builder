use crate::database::DbPath;
use rusqlite::params;
use tauri::State;

/// Retourne la liste des card_id en favoris
#[tauri::command]
pub fn get_favorites(db: State<DbPath>) -> Result<Vec<String>, String> {
    let conn = crate::database::open(&db.0).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT card_id FROM favorites ORDER BY added_at DESC")
        .map_err(|e| e.to_string())?;
    let ids: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(ids)
}

/// Ajoute une carte aux favoris (ignore si déjà présente)
#[tauri::command]
pub fn add_favorite(db: State<DbPath>, card_id: String) -> Result<(), String> {
    let conn = crate::database::open(&db.0).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO favorites (card_id) VALUES (?1)",
        params![card_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Retire une carte des favoris
#[tauri::command]
pub fn remove_favorite(db: State<DbPath>, card_id: String) -> Result<(), String> {
    let conn = crate::database::open(&db.0).map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM favorites WHERE card_id = ?1",
        params![card_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
