use crate::database::DbPath;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

// ─── Structs pour désérialiser le bulk data Scryfall ──────────────────────────

#[derive(Debug, Deserialize)]
struct ScryfallImageUris {
    normal:   Option<String>,
    small:    Option<String>,
    art_crop: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ScryfallCardFace {
    image_uris: Option<ScryfallImageUris>,
}

/// Seuls les champs utiles sont extraits ; serde ignore le reste automatiquement.
#[derive(Debug, Deserialize)]
struct ScryfallCard {
    id:               String,
    oracle_id:        Option<String>,
    name:             String,
    mana_cost:        Option<String>,
    cmc:              Option<f64>,
    type_line:        Option<String>,
    oracle_text:      Option<String>,
    colors:           Option<Vec<String>>,
    color_identity:   Option<Vec<String>>,
    rarity:           Option<String>,
    #[serde(rename = "set")]
    set_code:         Option<String>,
    collector_number: Option<String>,
    image_uris:       Option<ScryfallImageUris>,
    card_faces:       Option<Vec<ScryfallCardFace>>,
    power:            Option<String>,
    toughness:        Option<String>,
    loyalty:          Option<String>,
    keywords:         Option<Vec<String>>,
    arena_id:         Option<i64>,
    released_at:      Option<String>,
    layout:           Option<String>,
    games:            Vec<String>,
}

/// Layouts Scryfall ayant deux faces avec illustrations distinctes.
fn is_two_faced(layout: &Option<String>) -> bool {
    matches!(
        layout.as_deref(),
        Some("transform")
            | Some("modal_dfc")
            | Some("meld")
            | Some("battle")
            | Some("double_faced_token")
            | Some("reversible_card")
    )
}

// ─── Progress event pour l'import complet ─────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct ImportProgress {
    pub stage:          String,  // "fetch_url" | "download" | "parse" | "import" | "rebuild_fts" | "done"
    pub downloaded_mb:  f32,
    pub total_mb:       f32,
    pub cards_imported: u64,
    pub done:           bool,
    pub error:          Option<String>,
}

/// Progression envoyée au frontend via un événement Tauri
#[derive(Debug, Serialize, Clone)]
pub struct EnrichProgress {
    pub page: u32,
    pub total_updated: u64,
    pub done: bool,
    pub error: Option<String>,
}

/// Télécharge les images localisées depuis Scryfall pour la langue donnée (code MTGA, ex: "frFR").
/// Les URLs sont stockées dans `card_images (oracle_id, lang, uri)` au lieu d'écraser `image_uri_fr`.
/// Si lang_code = "frFR", met aussi à jour `cards.image_uri_fr` pour la compatibilité.
/// Émet des événements `enrich-fr-progress` pendant le traitement.
#[tauri::command]
pub async fn enrich_loc_images(
    window: tauri::Window,
    db: State<'_, DbPath>,
    lang_code: String,
) -> Result<u64, String> {
    // Correspondance code MTGA → code Scryfall
    let scryfall_lang = match lang_code.as_str() {
        "frFR" => "fr",
        "deDE" => "de",
        "esES" => "es",
        "itIT" => "it",
        "ptBR" => "pt",
        "jaJP" => "ja",
        "koKR" => "ko",
        "ruRU" => "ru",
        "zhCN" => "zhs",
        "zhTW" => "zht",
        _      => "en",
    };
    let is_fr = lang_code == "frFR";
    let config_key = format!("enrich_last_page_{}", lang_code);
    let db_path = db.0.clone();

    let client = reqwest::Client::builder()
        .user_agent("MTGADeckBuilder/1.0 (enrichissement images localisées)")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    // Lecture de la dernière page complétée pour reprendre là où on s'était arrêté
    let resume_conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;
    let last_page: u32 = resume_conn
        .query_row(
            "SELECT value FROM _config WHERE key = ?1",
            params![config_key],
            |r| r.get::<_, String>(0),
        )
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    drop(resume_conn);

    let mut page = last_page + 1;
    let mut total_updated = 0u64;

    loop {
        // Scryfall : cartes MTGA dans la langue demandée, unique par oracle
        let url = format!(
            "https://api.scryfall.com/cards/search?q=lang%3A{}+game%3Aarena&unique=cards&page={}",
            scryfall_lang, page
        );

        // Récupération de la page avec tolérance au rate limit Scryfall (429) et aux
        // erreurs réseau transitoires : on retente la MÊME page avec un backoff progressif.
        let mut attempt = 0u32;
        let resp = loop {
            attempt += 1;

            let r = match client.get(&url).send().await {
                Ok(r) => r,
                Err(e) => {
                    // Erreur réseau transitoire : quelques tentatives avant d'abandonner
                    if attempt <= 5 {
                        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                        continue;
                    }
                    let _ = window.emit("enrich-fr-progress", EnrichProgress {
                        page, total_updated, done: true,
                        error: Some(e.to_string()),
                    });
                    return Err(e.to_string());
                }
            };

            // 429 Too Many Requests : on respecte l'en-tête Retry-After si présent,
            // sinon backoff croissant (2s, 4s, … plafonné à 30s).
            if r.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
                if attempt <= 8 {
                    let wait = r.headers()
                        .get(reqwest::header::RETRY_AFTER)
                        .and_then(|v| v.to_str().ok())
                        .and_then(|v| v.parse::<u64>().ok())
                        .unwrap_or_else(|| (2 * attempt as u64).clamp(2, 30));
                    tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
                    continue;
                }
                let _ = window.emit("enrich-fr-progress", EnrichProgress {
                    page, total_updated, done: true,
                    error: Some("Scryfall limite les requêtes (429). Réessaie dans quelques minutes — la progression est sauvegardée, le téléchargement reprendra là où il s'est arrêté.".into()),
                });
                return Err("HTTP 429 (rate limit) persistant".into());
            }

            break r;
        };

        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            break; // Plus de pages
        }
        if !resp.status().is_success() {
            let msg = format!("HTTP {}", resp.status());
            let _ = window.emit("enrich-fr-progress", EnrichProgress {
                page, total_updated, done: true,
                error: Some(msg.clone()),
            });
            return Err(msg);
        }

        let data: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        let cards = data["data"].as_array().cloned().unwrap_or_default();
        let has_more = data["has_more"].as_bool().unwrap_or(false);

        let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;
        for card in &cards {
            let oracle_id = match card["oracle_id"].as_str() {
                Some(s) if !s.is_empty() => s,
                _ => continue,
            };
            // Image de la face principale (ou face 0 pour les cartes double-face)
            let img_uri = card["image_uris"]["normal"].as_str()
                .or_else(|| card["card_faces"][0]["image_uris"]["normal"].as_str());

            if let Some(img) = img_uri {
                // Stockage multilingue dans card_images (INSERT OR REPLACE = mise à jour)
                if conn.execute(
                    "INSERT OR REPLACE INTO card_images (oracle_id, lang, uri) VALUES (?1, ?2, ?3)",
                    params![oracle_id, lang_code, img],
                ).is_ok_and(|n| n > 0) {
                    total_updated += 1;
                }
                // Compatibilité frFR : maintenir aussi image_uri_fr pour les requêtes directes
                if is_fr {
                    let _ = conn.execute(
                        "UPDATE cards SET image_uri_fr = ?1 WHERE oracle_id = ?2 AND (image_uri_fr IS NULL OR image_uri_fr = '')",
                        params![img, oracle_id],
                    );
                }
            }
        }

        // Sauvegarde de la page complétée pour reprendre en cas d'interruption
        let _ = conn.execute(
            "INSERT OR REPLACE INTO _config (key, value) VALUES (?1, ?2)",
            params![config_key, page.to_string()],
        );

        let _ = window.emit("enrich-fr-progress", EnrichProgress {
            page, total_updated, done: false, error: None,
        });

        if !has_more { break; }
        page += 1;

        // Respect du rate limit Scryfall : Scryfall demande 50-100ms entre requêtes ;
        // on garde une marge confortable (150ms ≈ 6-7 req/s) pour éviter les 429.
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }

    // Réinitialise le curseur de page pour que le prochain lancement reparte de 0
    if let Ok(conn) = rusqlite::Connection::open(&db_path) {
        let _ = conn.execute(
            "DELETE FROM _config WHERE key = ?1",
            params![config_key],
        );
    }

    let _ = window.emit("enrich-fr-progress", EnrichProgress {
        page, total_updated, done: true, error: None,
    });

    Ok(total_updated)
}

/// Alias de compatibilité — appelle enrich_loc_images avec "frFR"
#[tauri::command]
pub async fn enrich_fr_images(
    window: tauri::Window,
    db: State<'_, DbPath>,
) -> Result<u64, String> {
    enrich_loc_images(window, db, "frFR".to_string()).await
}

/// Statistiques détaillées pour la vue Paramètres
#[derive(Debug, Serialize)]
pub struct DetailedStats {
    pub total_cards: i64,
    pub cards_with_fr_names: i64,
    pub cards_with_fr_images: i64,
    pub total_combos: i64,
    pub total_decks: i64,
    pub db_size_mb: f64,
}

#[tauri::command]
pub fn get_detailed_stats(db: State<DbPath>) -> Result<DetailedStats, String> {
    let conn = crate::database::open(&db.0).map_err(|e| e.to_string())?;

    let total_cards: i64 = conn
        .query_row("SELECT COUNT(*) FROM cards", [], |r| r.get(0))
        .unwrap_or(0);
    let cards_with_fr_names: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cards WHERE name_fr IS NOT NULL AND name_fr != ''",
            [], |r| r.get(0),
        )
        .unwrap_or(0);
    let cards_with_fr_images: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM cards WHERE image_uri_fr IS NOT NULL AND image_uri_fr != ''",
            [], |r| r.get(0),
        )
        .unwrap_or(0);
    let total_combos: i64 = conn
        .query_row("SELECT COUNT(*) FROM combos", [], |r| r.get(0))
        .unwrap_or(0);
    let total_decks: i64 = conn
        .query_row("SELECT COUNT(*) FROM decks", [], |r| r.get(0))
        .unwrap_or(0);

    // Taille du fichier DB
    let db_size_mb = std::fs::metadata(&db.0)
        .map(|m| m.len() as f64 / 1_048_576.0)
        .unwrap_or(0.0);

    Ok(DetailedStats {
        total_cards,
        cards_with_fr_names,
        cards_with_fr_images,
        total_combos,
        total_decks,
        db_size_mb,
    })
}

/// Nombre d'images localisées disponibles pour une langue donnée (code MTGA, ex "frFR").
/// `count` = entrées dans card_images pour cette langue (1 par oracle_id).
/// `total` = oracle_id distincts disponibles sur Arena (dénominateur représentatif).
#[derive(Debug, Serialize)]
pub struct LocImageCount {
    pub count: i64,
    pub total: i64,
}

#[tauri::command]
pub fn get_localized_image_count(db: State<DbPath>, lang_code: String) -> Result<LocImageCount, String> {
    let conn = crate::database::open(&db.0).map_err(|e| e.to_string())?;
    let safe_lang: String = lang_code.chars().filter(|c| c.is_alphanumeric()).collect();

    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM card_images WHERE lang = ?1",
            [&safe_lang],
            |r| r.get(0),
        )
        .unwrap_or(0);

    let total: i64 = conn
        .query_row(
            "SELECT COUNT(DISTINCT oracle_id) FROM cards \
             WHERE oracle_id IS NOT NULL AND arena_id IS NOT NULL",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    Ok(LocImageCount { count, total })
}

/// Télécharge le bulk data Scryfall (default_cards) et importe toutes les cartes Arena.
/// Met à jour les cartes existantes sans écraser name_fr ni image_uri_fr.
/// Émet des événements `import-progress` pendant le traitement.
#[tauri::command]
pub async fn import_cards_from_scryfall(
    window: tauri::Window,
    db: State<'_, DbPath>,
) -> Result<u64, String> {
    let db_path = db.0.clone();

    let client = reqwest::Client::builder()
        .user_agent("MTGADeckBuilder/1.0 (import cartes MTGA Arena)")
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;

    // ── Étape 1 : récupération de l'URL de téléchargement ────────────────────
    let _ = window.emit("import-progress", ImportProgress {
        stage: "fetch_url".into(), downloaded_mb: 0.0, total_mb: 0.0,
        cards_imported: 0, done: false, error: None,
    });

    let meta: serde_json::Value = client
        .get("https://api.scryfall.com/bulk-data")
        .send().await.map_err(|e| e.to_string())?
        .json().await.map_err(|e| e.to_string())?;

    let download_uri = meta["data"]
        .as_array()
        .and_then(|arr| arr.iter().find(|v| v["type"].as_str() == Some("default_cards")))
        .and_then(|v| v["download_uri"].as_str())
        .ok_or_else(|| "URL bulk data introuvable dans la réponse Scryfall".to_string())?
        .to_string();

    // ── Étape 2 : téléchargement streaming vers fichier temporaire ───────────
    let _ = window.emit("import-progress", ImportProgress {
        stage: "download".into(), downloaded_mb: 0.0, total_mb: 0.0,
        cards_imported: 0, done: false, error: None,
    });

    let mut response = client.get(&download_uri)
        .send().await.map_err(|e| e.to_string())?;

    let total_bytes = response.content_length().unwrap_or(0);
    let total_mb    = total_bytes as f32 / 1_048_576.0;

    let temp_path = std::env::temp_dir().join("mtgabuilder_scryfall_bulk.json");

    {
        use tokio::io::AsyncWriteExt;
        let mut file = tokio::fs::File::create(&temp_path).await
            .map_err(|e| format!("Fichier temporaire impossible à créer : {}", e))?;

        let mut downloaded: u64 = 0;
        let mut last_emit: u64  = 0;
        const EMIT_EVERY: u64   = 10 * 1024 * 1024; // tous les 10 MB

        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
            downloaded += chunk.len() as u64;
            if downloaded - last_emit >= EMIT_EVERY {
                last_emit = downloaded;
                let _ = window.emit("import-progress", ImportProgress {
                    stage: "download".into(),
                    downloaded_mb: downloaded as f32 / 1_048_576.0,
                    total_mb, cards_imported: 0, done: false, error: None,
                });
            }
        }
        file.flush().await.map_err(|e| e.to_string())?;
    } // fichier fermé ici

    let _ = window.emit("import-progress", ImportProgress {
        stage: "parse".into(), downloaded_mb: total_mb, total_mb,
        cards_imported: 0, done: false, error: None,
    });

    // ── Étape 3 : parsing + import dans un thread bloquant ───────────────────
    let window2 = window.clone();

    let total_upserted = tokio::task::spawn_blocking(move || -> Result<u64, String> {
        // Lecture + parsing (struct typée = plus efficace que serde_json::Value)
        let file   = std::fs::File::open(&temp_path)
            .map_err(|e| format!("Impossible d'ouvrir le fichier temporaire : {}", e))?;
        let reader = std::io::BufReader::with_capacity(8 * 1024 * 1024, file);

        let cards: Vec<ScryfallCard> = serde_json::from_reader(reader)
            .map_err(|e| format!("Erreur parsing JSON Scryfall : {}", e))?;

        let _ = window2.emit("import-progress", ImportProgress {
            stage: "import".into(), downloaded_mb: total_mb, total_mb,
            cards_imported: 0, done: false, error: None,
        });

        // Connexion DB + pragmas de performance
        let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
            .map_err(|e| e.to_string())?;

        // UPSERT : met à jour les champs EN, préserve name_fr et image_uri_fr
        let sql = "
            INSERT INTO cards (
                id, oracle_id, name_en, mana_cost, cmc, type_line, oracle_text,
                colors, color_identity, rarity, set_code, collector_number,
                image_uri_normal, image_uri_small, image_uri_art_crop,
                power, toughness, loyalty, keywords, arena_id, released_at,
                layout, image_uri_back
            ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)
            ON CONFLICT(id) DO UPDATE SET
                oracle_id          = excluded.oracle_id,
                name_en            = excluded.name_en,
                mana_cost          = excluded.mana_cost,
                cmc                = excluded.cmc,
                type_line          = excluded.type_line,
                oracle_text        = excluded.oracle_text,
                colors             = excluded.colors,
                color_identity     = excluded.color_identity,
                rarity             = excluded.rarity,
                set_code           = excluded.set_code,
                collector_number   = excluded.collector_number,
                image_uri_normal   = excluded.image_uri_normal,
                image_uri_small    = excluded.image_uri_small,
                image_uri_art_crop = excluded.image_uri_art_crop,
                power              = excluded.power,
                toughness          = excluded.toughness,
                loyalty            = excluded.loyalty,
                keywords           = excluded.keywords,
                arena_id           = COALESCE(excluded.arena_id, arena_id),
                released_at        = excluded.released_at,
                layout             = excluded.layout,
                image_uri_back     = excluded.image_uri_back
        ";

        conn.execute_batch("BEGIN TRANSACTION").map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let mut total: u64 = 0;
        let mut batch: u64 = 0;

        for card in &cards {
            // Filtre : disponible sur Arena
            if !card.games.iter().any(|g| g == "arena") { continue; }

            let colors         = serde_json::to_string(card.colors.as_deref().unwrap_or(&[])).unwrap_or_default();
            let color_identity = serde_json::to_string(card.color_identity.as_deref().unwrap_or(&[])).unwrap_or_default();
            let keywords       = serde_json::to_string(card.keywords.as_deref().unwrap_or(&[])).unwrap_or_default();

            // Images : face principale ou face 0 pour DFC / MDFC
            let img = card.image_uris.as_ref()
                .or_else(|| card.card_faces.as_ref()?.first()?.image_uris.as_ref());

            // Face arrière (face 1) pour les cartes à deux faces illustrées
            let img_back = if is_two_faced(&card.layout) {
                card.card_faces.as_ref()
                    .and_then(|f| f.get(1))
                    .and_then(|f| f.image_uris.as_ref())
                    .and_then(|i| i.normal.as_deref())
            } else {
                None
            };

            stmt.execute(params![
                card.id,
                card.oracle_id.as_deref(),
                card.name,
                card.mana_cost.as_deref(),
                card.cmc.unwrap_or(0.0),
                card.type_line.as_deref(),
                card.oracle_text.as_deref(),
                colors, color_identity,
                card.rarity.as_deref(),
                card.set_code.as_deref(),
                card.collector_number.as_deref(),
                img.and_then(|i| i.normal.as_deref()),
                img.and_then(|i| i.small.as_deref()),
                img.and_then(|i| i.art_crop.as_deref()),
                card.power.as_deref(),
                card.toughness.as_deref(),
                card.loyalty.as_deref(),
                keywords,
                card.arena_id,
                card.released_at.as_deref(),
                card.layout.as_deref(),
                img_back,
            ]).map_err(|e| e.to_string())?;

            total += 1;
            batch += 1;

            // Commit toutes les 500 cartes pour libérer le verrou DB régulièrement
            if batch >= 500 {
                drop(stmt);
                conn.execute_batch("COMMIT; BEGIN TRANSACTION").map_err(|e| e.to_string())?;
                stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
                let _ = window2.emit("import-progress", ImportProgress {
                    stage: "import".into(), downloaded_mb: total_mb, total_mb,
                    cards_imported: total, done: false, error: None,
                });
                batch = 0;
            }
        }

        drop(stmt);
        conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;

        // Reconstruction de l'index FTS5 pour garantir la cohérence
        let _ = window2.emit("import-progress", ImportProgress {
            stage: "rebuild_fts".into(), downloaded_mb: total_mb, total_mb,
            cards_imported: total, done: false, error: None,
        });
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild')")
            .map_err(|e| e.to_string())?;

        // Nettoyage du fichier temporaire
        std::fs::remove_file(&temp_path).ok();

        Ok(total)
    }).await.map_err(|e| e.to_string())??;

    let _ = window.emit("import-progress", ImportProgress {
        stage: "done".into(), downloaded_mb: total_mb, total_mb,
        cards_imported: total_upserted, done: true, error: None,
    });

    Ok(total_upserted)
}
