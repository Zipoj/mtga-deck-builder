/// Serveur HTTP local sur localhost:7891
/// Permet à l'extension Firefox ComboTGA de communiquer avec l'application.
///
/// Routes disponibles :
///   GET  /api/health              → vérification que le serveur tourne
///   GET  /api/cards?q=<query>     → recherche de cartes
///   GET  /api/decks               → liste des decks
///   POST /api/deck/:id/add        → ajoute une carte à un deck
///   POST /api/combos              → importe un combo (payload ComboPayload)
///   GET  /api/arena-cards         → liste complète des cartes Arena (noms EN, lowercase)
///   POST /api/favorites/add       → ajoute une carte aux favoris par nom EN

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::Json,
    routing::{get, post},
    Router,
};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::{net::SocketAddr, path::PathBuf, sync::Arc};
use tauri::Emitter;
use tower_http::cors::{Any, CorsLayer};

/// État partagé du serveur API
#[derive(Clone)]
struct ApiState {
    db_path:    Arc<PathBuf>,
    app_handle: Arc<tauri::AppHandle>,
}

#[derive(Deserialize)]
struct SearchQuery {
    q: Option<String>,
    limit: Option<i32>,
}

#[derive(Deserialize)]
struct AddCardBody {
    card_name: String,
    quantity: Option<i32>,
    board: Option<String>,
}

#[derive(Deserialize)]
struct FavoriteBody {
    card_name: String,
}

#[derive(Serialize)]
struct ApiError {
    error: String,
}

#[derive(Serialize)]
struct HealthResponse {
    status: String,
    version: String,
}

pub async fn start(db_path: PathBuf, port: u16, app_handle: tauri::AppHandle) {
    let state = ApiState {
        db_path:    Arc::new(db_path),
        app_handle: Arc::new(app_handle),
    };

    // CORS permissif : l'extension Firefox peut appeler depuis n'importe quel domaine
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/cards", get(search_cards))
        .route("/api/decks", get(list_decks))
        .route("/api/deck/:deck_id/add", post(add_card_to_deck))
        .route("/api/combos", post(import_combo))
        .route("/api/arena-cards", get(get_arena_cards))
        .route("/api/favorites/add", post(add_favorite_api))
        .layer(cors)
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));

    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => {
            println!("[API] Serveur local démarré sur http://{}", addr);
            l
        }
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            // Une autre instance tourne déjà sur ce port — ne pas paniquer
            println!("[API] Port {} déjà utilisé (autre instance en cours). Serveur non démarré.", port);
            return;
        }
        Err(e) => {
            eprintln!("[API] Impossible de démarrer sur le port {} : {}", port, e);
            return;
        }
    };

    axum::serve(listener, app).await.unwrap();
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}

async fn search_cards(
    State(state): State<ApiState>,
    Query(params): Query<SearchQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    let query = params.q.unwrap_or_default();
    let limit = params.limit.unwrap_or(20).min(100);

    let conn = rusqlite::Connection::open(state.db_path.as_ref())
        .map_err(|e| internal_err(e.to_string()))?;

    let filters = crate::database::CardFilters::default();
    let cards = crate::database::search_cards_query(&conn, &query, limit, &filters, "en", "en")
        .map_err(|e| internal_err(e.to_string()))?;

    Ok(Json(serde_json::json!({ "cards": cards, "count": cards.len() })))
}

async fn list_decks(
    State(state): State<ApiState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    let conn = rusqlite::Connection::open(state.db_path.as_ref())
        .map_err(|e| internal_err(e.to_string()))?;

    let mut stmt = conn
        .prepare("SELECT id, name, format, description, created_at FROM decks ORDER BY updated_at DESC")
        .map_err(|e| internal_err(e.to_string()))?;

    let decks: Vec<serde_json::Value> = stmt
        .query_map([], |row| {
            Ok(serde_json::json!({
                "id":          row.get::<_, i64>(0)?,
                "name":        row.get::<_, String>(1)?,
                "format":      row.get::<_, String>(2)?,
                "description": row.get::<_, String>(3)?,
                "created_at":  row.get::<_, String>(4)?,
            }))
        })
        .map_err(|e| internal_err(e.to_string()))?
        .flatten()
        .collect();

    Ok(Json(serde_json::json!({ "decks": decks })))
}

async fn add_card_to_deck(
    State(state): State<ApiState>,
    Path(deck_id): Path<i64>,
    Json(body): Json<AddCardBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    let conn = rusqlite::Connection::open(state.db_path.as_ref())
        .map_err(|e| internal_err(e.to_string()))?;

    // Cherche la carte par son nom EN ou FR
    let card_id: Option<String> = conn
        .query_row(
            "SELECT id FROM cards
             WHERE LOWER(name_en) = LOWER(?1) OR LOWER(name_fr) = LOWER(?1)
             LIMIT 1",
            rusqlite::params![body.card_name],
            |r| r.get(0),
        )
        .ok();

    let Some(card_id) = card_id else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ApiError { error: format!("Carte non trouvée : {}", body.card_name) }),
        ));
    };

    let quantity = body.quantity.unwrap_or(1);
    let board = body.board.unwrap_or_else(|| "main".to_string());

    conn.execute(
        "INSERT INTO deck_cards (deck_id, card_id, quantity, board)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(deck_id, card_id, board)
         DO UPDATE SET quantity = quantity + excluded.quantity",
        params![deck_id, card_id, quantity, board],
    )
    .map_err(|e| internal_err(e.to_string()))?;

    Ok(Json(serde_json::json!({
        "success": true,
        "card_id": card_id,
        "deck_id": deck_id,
        "quantity": quantity,
        "board": board,
    })))
}

async fn import_combo(
    State(state): State<ApiState>,
    Json(body): Json<crate::commands::combos::ComboPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    let conn = rusqlite::Connection::open(state.db_path.as_ref())
        .map_err(|e| internal_err(e.to_string()))?;

    let id = crate::commands::combos::import_combo_internal(&conn, body)
        .map_err(|e| internal_err(e.to_string()))?;

    // Notifie le frontend pour qu'il rafraîchisse la liste des combos
    let _ = state.app_handle.emit("combo-added", ());

    Ok(Json(serde_json::json!({ "success": true, "id": id })))
}

/// GET /api/arena-cards
/// Retourne la liste complète des noms de cartes disponibles sur Arena (en minuscules).
/// Utilisé par l'addon Firefox pour remplacer son fetch Scryfall.
async fn get_arena_cards(
    State(state): State<ApiState>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    let conn = rusqlite::Connection::open(state.db_path.as_ref())
        .map_err(|e| internal_err(e.to_string()))?;

    let mut stmt = conn
        .prepare(
            "SELECT DISTINCT LOWER(name_en) FROM cards \
             WHERE arena_id IS NOT NULL AND name_en IS NOT NULL \
             ORDER BY name_en ASC",
        )
        .map_err(|e| internal_err(e.to_string()))?;

    let cards: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| internal_err(e.to_string()))?
        .flatten()
        .collect();

    let count = cards.len();
    Ok(Json(serde_json::json!({ "cards": cards, "count": count })))
}

/// POST /api/favorites/add   body: { "card_name": "Lightning Bolt" }
/// Ajoute une carte aux favoris à partir de son nom EN (cherche l'id en DB).
async fn add_favorite_api(
    State(state): State<ApiState>,
    Json(body): Json<FavoriteBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    let conn = rusqlite::Connection::open(state.db_path.as_ref())
        .map_err(|e| internal_err(e.to_string()))?;

    // Cherche une impression Arena de la carte (n'importe laquelle)
    let card_id: Option<String> = conn
        .query_row(
            "SELECT id FROM cards \
             WHERE LOWER(name_en) = LOWER(?1) AND arena_id IS NOT NULL \
             LIMIT 1",
            rusqlite::params![body.card_name],
            |r| r.get(0),
        )
        .ok();

    let Some(card_id) = card_id else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ApiError {
                error: format!("Carte Arena introuvable : {}", body.card_name),
            }),
        ));
    };

    conn.execute(
        "INSERT OR IGNORE INTO favorites (card_id) VALUES (?1)",
        params![card_id],
    )
    .map_err(|e| internal_err(e.to_string()))?;

    // Notifie le frontend pour qu'il rafraîchisse les favoris
    let _ = state.app_handle.emit("favorite-added", ());

    Ok(Json(serde_json::json!({
        "success":   true,
        "card_id":   card_id,
        "card_name": body.card_name,
    })))
}

fn internal_err(msg: String) -> (StatusCode, Json<ApiError>) {
    (StatusCode::INTERNAL_SERVER_ERROR, Json(ApiError { error: msg }))
}
