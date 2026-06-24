mod commands;
mod database;
mod api_server;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Initialise la base de données dans le dossier AppData de l'utilisateur
            let app_data_dir = app.path().app_data_dir()
                .expect("Impossible de trouver le dossier AppData");
            std::fs::create_dir_all(&app_data_dir)?;

            let db_path = app_data_dir.join("mtga.db");
            database::init_db(&db_path)
                .expect("Échec de l'initialisation de la base de données");

            // Lance le serveur API local (pour l'extension Firefox) sur port 7891
            let db_path_clone = db_path.clone();
            let app_handle    = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                api_server::start(db_path_clone, 7891, app_handle).await;
            });

            // Stocke le chemin DB dans l'état global de l'app
            app.manage(database::DbPath(db_path));

            // Enregistre le schéma URI mtgabuilder:// dans le registre Windows (HKCU, sans droits admin)
            // Cela permet à l'addon Firefox d'ouvrir l'app via mtgabuilder://open
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                if let Ok(exe) = std::env::current_exe() {
                    let cmd_val = format!("\"{}\" \"%1\"", exe.to_string_lossy());
                    let _ = std::process::Command::new("reg")
                        .args(["add", "HKCU\\Software\\Classes\\mtgabuilder",
                               "/ve", "/d", "URL:MTGA Builder Protocol", "/f"])
                        .creation_flags(CREATE_NO_WINDOW)
                        .status();
                    let _ = std::process::Command::new("reg")
                        .args(["add", "HKCU\\Software\\Classes\\mtgabuilder",
                               "/v", "URL Protocol", "/d", "", "/f"])
                        .creation_flags(CREATE_NO_WINDOW)
                        .status();
                    let _ = std::process::Command::new("reg")
                        .args(["add", "HKCU\\Software\\Classes\\mtgabuilder\\shell\\open\\command",
                               "/ve", "/d", &cmd_val, "/f"])
                        .creation_flags(CREATE_NO_WINDOW)
                        .status();
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // ── Cartes ──────────────────────────────────
            commands::cards::search_cards,
            commands::cards::get_card_by_id,
            commands::cards::get_cards_by_ids,
            commands::cards::get_cards_by_names,
            commands::cards::get_db_stats,
            commands::cards::get_sets,
            // ── Decks ───────────────────────────────────
            commands::decks::create_deck,
            commands::decks::get_decks,
            commands::decks::get_deck_with_cards,
            commands::decks::delete_deck,
            commands::decks::rename_deck,
            commands::decks::duplicate_deck,
            commands::decks::add_card_to_deck,
            commands::decks::remove_card_from_deck,
            commands::decks::update_card_quantity,
            commands::decks::export_deck_mtga,
            commands::decks::import_deck_mtga,
            commands::decks::set_deck_cover,
            commands::decks::set_deck_favorite,
            commands::decks::reorder_decks,
            // ── Combos ──────────────────────────────────
            commands::combos::get_combos,
            commands::combos::create_combo,
            commands::combos::delete_combo,
            commands::combos::set_combo_favorite,
            commands::combos::get_cs_combo_count,
            commands::combos::export_combos,
            commands::combos::import_combos,
            // ── Favoris ─────────────────────────────────
            commands::favorites::get_favorites,
            commands::favorites::add_favorite,
            commands::favorites::remove_favorite,
            // ── Paramètres ──────────────────────────────
            commands::settings::enrich_fr_images,
            commands::settings::enrich_loc_images,
            commands::settings::get_detailed_stats,
            commands::settings::get_localized_image_count,
            commands::settings::import_cards_from_scryfall,
            // ── MTGA local sync ─────────────────────────
            commands::mtga_sync::scan_mtga_folder,
            commands::mtga_sync::sync_loc_from_mtga,
            commands::mtga_sync::inspect_cards_db,
            commands::mtga_sync::read_collection_from_memory,
            commands::mtga_sync::save_collection,
        ])
        .run(tauri::generate_context!())
        .expect("Erreur lors du lancement de l'application Tauri");
}
