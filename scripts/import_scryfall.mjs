#!/usr/bin/env node
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * MTGA Deck Builder — Script d'import Scryfall
 * Utilise sql.js (SQLite en WebAssembly) — aucune compilation native requise
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Usage :
 *   cd scripts && npm install && node import_scryfall.mjs
 *
 * Options :
 *   --fr-only    : enrichissement des noms FR uniquement (DB déjà peuplée)
 *   --skip-fr    : ne pas importer les noms FR (plus rapide)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, createReadStream, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

// stream-json / stream-chain sont des modules CommonJS — import via require
const require = createRequire(import.meta.url);
const { parser }      = require("stream-json");
const { streamArray } = require("stream-json/streamers/StreamArray");
const { chain }       = require("stream-chain");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Chemins ─────────────────────────────────────────────────────────────────

const DATA_DIR  = path.join(__dirname, "data");
const DUMP_PATH = path.join(DATA_DIR, "default_cards.json");

// DB dans %APPDATA%\com.mtgabuilder.app\ (même chemin qu'utilisé par Tauri)
const APPDATA = process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? "~", "AppData", "Roaming");
const DB_DIR  = path.join(APPDATA, "com.mtgabuilder.app");
const DB_PATH = path.join(DB_DIR, "mtga.db");

// ─── Config ───────────────────────────────────────────────────────────────────

const SCRYFALL_BULK_API = "https://api.scryfall.com/bulk-data";
const SCRYFALL_SEARCH   = "https://api.scryfall.com/cards/search";
const RATE_LIMIT_MS     = 110;   // Scryfall : max ~10 req/s
const BATCH_SIZE        = 1000;  // Cartes insérées par transaction
const FR_ONLY           = process.argv.includes("--fr-only");
const SKIP_FR           = process.argv.includes("--skip-fr");
const SAVE_EVERY        = 5000;  // Sauvegarde intermédiaire toutes les N cartes

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(DB_DIR,   { recursive: true });

// ─── Initialisation sql.js ────────────────────────────────────────────────────

console.log("Chargement de sql.js (SQLite WebAssembly)…");
const { default: initSqlJs } = await import("sql.js");
const SQL = await initSqlJs();

// Charge la DB existante ou en crée une nouvelle
let db;
if (existsSync(DB_PATH)) {
  console.log(`DB existante chargée : ${DB_PATH}`);
  const fileBuffer = readFileSync(DB_PATH);
  db = new SQL.Database(fileBuffer);
} else {
  console.log(`Nouvelle base de données : ${DB_PATH}`);
  db = new SQL.Database();
}

db.run("PRAGMA journal_mode = WAL;");
db.run("PRAGMA synchronous = NORMAL;");
db.run("PRAGMA foreign_keys = ON;");

initSchema(db);

// ─── Main ─────────────────────────────────────────────────────────────────────

if (FR_ONLY) {
  console.log("\nMode --fr-only : enrichissement des noms français uniquement.\n");
  await importFrenchNames(db);
} else {
  await importEnglishCards(db);
  if (!SKIP_FR) {
    await importFrenchNames(db);
  }
}

saveDb(db, DB_PATH);
printStats(db);
db.close();
console.log("\n✅ Terminé !");

// ─── Étape 1 : Import des cartes EN depuis le dump Scryfall ───────────────────

async function importEnglishCards(db) {
  console.log("\n═══════════════════════════════════════════════");
  console.log(" ÉTAPE 1 — Import des cartes MTGA (anglais)");
  console.log("═══════════════════════════════════════════════");

  // Récupère l'URL du dump
  const downloadUrl = await fetchBulkDataUrl("default_cards");
  console.log(`\nURL : ${downloadUrl}`);

  // Télécharge si absent ou si le fichier a plus de 30 jours
  const MAX_DUMP_AGE_DAYS = 30;
  const dumpExists = existsSync(DUMP_PATH);
  const dumpAgeDays = dumpExists
    ? (Date.now() - statSync(DUMP_PATH).mtimeMs) / 86_400_000
    : Infinity;
  const forceRefresh = process.argv.includes("--refresh");

  if (!dumpExists || dumpAgeDays > MAX_DUMP_AGE_DAYS || forceRefresh) {
    if (dumpExists && dumpAgeDays > MAX_DUMP_AGE_DAYS)
      console.log(`Dump trop ancien (${Math.floor(dumpAgeDays)} jours) — re-téléchargement…`);
    else if (forceRefresh)
      console.log("--refresh demandé — re-téléchargement…");
    else
      console.log("Téléchargement du dump JSON (~100 MB)…");
    await downloadFile(downloadUrl, DUMP_PATH);
  } else {
    console.log(`Dump présent et récent (${Math.floor(dumpAgeDays)} jour(s)) : ${DUMP_PATH}`);
    console.log("  → Pour forcer le re-téléchargement : node import_scryfall.mjs --refresh");
  }

  // Parse et insère
  console.log("\nParsing et insertion en base…");
  const count = await parseAndInsertCards(db, DUMP_PATH);
  console.log(`\n✅ ${count.toLocaleString()} cartes MTGA insérées.\n`);
}

// ─── Étape 2 : Noms français ──────────────────────────────────────────────────

async function importFrenchNames(db) {
  console.log("═══════════════════════════════════════════════");
  console.log(" ÉTAPE 2 — Enrichissement des noms français");
  console.log("═══════════════════════════════════════════════\n");

  let page    = 1;
  let hasMore = true;
  let total   = 0;

  console.log("Récupération des noms FR depuis l'API Scryfall…");
  console.log("(~50-100 pages, quelques minutes)\n");

  while (hasMore) {
    const url = `${SCRYFALL_SEARCH}?q=lang%3Afr+game%3Aarena&unique=cards&page=${page}`;
    let data;

    try {
      const resp = await fetch(url, { headers: { "User-Agent": "MTGADeckBuilder/1.0" } });
      if (resp.status === 404) { hasMore = false; break; }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      data = await resp.json();
    } catch (err) {
      console.error(`\nErreur page ${page} : ${err.message} — retry dans 2s`);
      await sleep(2000);
      continue;
    }

    const cards = data.data ?? [];
    db.run("BEGIN TRANSACTION");
    for (const card of cards) {
      const nameFr   = card.printed_name ?? card.name;
      const oracleId = card.oracle_id;
      // Image de la face principale (ou face 0 pour les cartes double-face)
      const imageUriFr = card.image_uris?.normal
        ?? card.card_faces?.[0]?.image_uris?.normal
        ?? null;
      if (nameFr && oracleId) {
        db.run(
          "UPDATE cards SET name_fr = ?, image_uri_fr = ? WHERE oracle_id = ?",
          [nameFr, imageUriFr, oracleId]
        );
        total++;
      }
    }
    db.run("COMMIT");

    process.stdout.write(`\rPage ${String(page).padStart(3)} | +${cards.length} cartes | Total FR : ${total}`);

    // Sauvegarde intermédiaire toutes les 20 pages
    if (page % 20 === 0) {
      process.stdout.write(" [sauvegarde…]");
      saveDb(db, DB_PATH);
    }

    hasMore = data.has_more ?? false;
    page++;
    if (hasMore) await sleep(RATE_LIMIT_MS);
  }

  console.log(`\n\n✅ ${total.toLocaleString()} noms français enrichis.\n`);
  saveDb(db, DB_PATH);
}

// ─── Parsing streaming du dump JSON ───────────────────────────────────────────

async function parseAndInsertCards(db, filePath) {
  // parser / streamArray / chain sont importés au top du fichier via require()
  let totalInserted = 0;
  let batch = [];

  const insertSql = `
    INSERT OR REPLACE INTO cards (
      id, oracle_id, name_en, mana_cost, cmc, type_line, oracle_text,
      colors, color_identity, rarity, set_code, collector_number,
      image_uri_normal, image_uri_small, image_uri_art_crop,
      power, toughness, loyalty, keywords, arena_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `;

  const flushBatch = () => {
    db.run("BEGIN TRANSACTION");
    for (const row of batch) {
      db.run(insertSql, row);
    }
    db.run("COMMIT");
    totalInserted += batch.length;
    batch = [];

    // Sauvegarde intermédiaire pour ne pas tout perdre en cas de coupure
    if (totalInserted % SAVE_EVERY === 0) {
      process.stdout.write(` [${totalInserted.toLocaleString()} cartes — sauvegarde…]`);
      saveDb(db, DB_PATH);
    }
    process.stdout.write(`\rInséré : ${totalInserted.toLocaleString()} cartes`);
  };

  return new Promise((resolve, reject) => {
    const pipe = chain([
      createReadStream(filePath),
      parser(),
      streamArray(),
    ]);

    pipe.on("data", ({ value: card }) => {
      if (!card.games?.includes("arena")) return;
      if (card.layout === "token" || card.layout === "emblem") return;

      batch.push(cardToRow(card));
      if (batch.length >= BATCH_SIZE) flushBatch();
    });

    pipe.on("end", () => {
      if (batch.length > 0) flushBatch();
      resolve(totalInserted);
    });

    pipe.on("error", reject);
  });
}

// ─── Conversion carte Scryfall → tableau de valeurs SQL ──────────────────────

function cardToRow(card) {
  const face   = card.card_faces?.[0] ?? card;
  const images = card.image_uris ?? face.image_uris ?? {};
  return [
    card.id,
    card.oracle_id ?? null,
    card.name,
    face.mana_cost ?? card.mana_cost ?? null,
    card.cmc ?? 0,
    card.type_line ?? face.type_line ?? null,
    face.oracle_text ?? card.oracle_text ?? null,
    JSON.stringify(card.colors ?? face.colors ?? []),
    JSON.stringify(card.color_identity ?? []),
    card.rarity ?? null,
    card.set ?? null,
    card.collector_number ?? null,
    images.normal    ?? null,
    images.small     ?? null,
    images.art_crop  ?? null,
    card.power       ?? face.power    ?? null,
    card.toughness   ?? face.toughness ?? null,
    card.loyalty     ?? face.loyalty  ?? null,
    JSON.stringify(card.keywords ?? []),
    card.arena_id ?? null,
  ];
}

// ─── Sauvegarde la DB sur disque ──────────────────────────────────────────────

function saveDb(db, filePath) {
  const data = db.export();             // Uint8Array
  writeFileSync(filePath, Buffer.from(data));
}

// ─── Schéma SQLite ────────────────────────────────────────────────────────────

function initSchema(db) {
  db.run(`
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
      image_uri_fr     TEXT,
      power            TEXT,
      toughness        TEXT,
      loyalty          TEXT,
      keywords         TEXT DEFAULT '[]',
      arena_id         INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_oracle  ON cards(oracle_id);
    CREATE INDEX IF NOT EXISTS idx_rarity  ON cards(rarity);
    CREATE INDEX IF NOT EXISTS idx_set     ON cards(set_code);
    CREATE INDEX IF NOT EXISTS idx_cmc     ON cards(cmc);

    -- Note : la table FTS5 et ses triggers sont créés par Tauri au premier lancement
    -- (FTS5 n'est pas disponible dans le WASM de sql.js)
  `);
  // Migration pour les DB existantes sans la colonne image_uri_fr
  try { db.run("ALTER TABLE cards ADD COLUMN image_uri_fr TEXT"); } catch(e) { /* column exists */ }
  db.run(`

    CREATE TABLE IF NOT EXISTS decks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      format      TEXT DEFAULT 'standard',
      description TEXT DEFAULT '',
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS deck_cards (
      deck_id  INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
      card_id  TEXT    NOT NULL REFERENCES cards(id),
      quantity INTEGER DEFAULT 1,
      board    TEXT    DEFAULT 'main',
      PRIMARY KEY (deck_id, card_id, board)
    );
  `);
}

// ─── Utilitaires ─────────────────────────────────────────────────────────────

async function fetchBulkDataUrl(type) {
  const resp = await fetch(SCRYFALL_BULK_API, { headers: { "User-Agent": "MTGADeckBuilder/1.0" } });
  if (!resp.ok) throw new Error(`bulk-data : HTTP ${resp.status}`);
  const data = await resp.json();
  const entry = data.data.find((d) => d.type === type);
  if (!entry) throw new Error(`Type "${type}" introuvable`);
  return entry.download_uri;
}

async function downloadFile(url, dest) {
  const resp = await fetch(url, { headers: { "User-Agent": "MTGADeckBuilder/1.0" } });
  if (!resp.ok) throw new Error(`Téléchargement : HTTP ${resp.status}`);
  const total = parseInt(resp.headers.get("content-length") ?? "0", 10);
  let downloaded = 0;
  const file = createWriteStream(dest);
  const reader = resp.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    file.write(value);
    downloaded += value.length;
    if (total > 0) {
      process.stdout.write(
        `\r  ${((downloaded / total) * 100).toFixed(1)}% — ${(downloaded / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB`
      );
    }
  }
  await new Promise((res, rej) => { file.end(); file.on("finish", res); file.on("error", rej); });
  console.log();
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function printStats(db) {
  const total   = db.exec("SELECT COUNT(*) FROM cards")[0]?.values[0][0] ?? 0;
  const withFr  = db.exec("SELECT COUNT(*) FROM cards WHERE name_fr IS NOT NULL")[0]?.values[0][0] ?? 0;
  const withImg = db.exec("SELECT COUNT(*) FROM cards WHERE image_uri_normal IS NOT NULL")[0]?.values[0][0] ?? 0;
  console.log("\n📊 Statistiques :");
  console.log(`   Cartes MTGA   : ${Number(total).toLocaleString()}`);
  console.log(`   Noms français : ${Number(withFr).toLocaleString()} (${total > 0 ? ((withFr/total)*100).toFixed(1) : 0}%)`);
  console.log(`   Avec image    : ${Number(withImg).toLocaleString()} (${total > 0 ? ((withImg/total)*100).toFixed(1) : 0}%)`);
  console.log(`\n📁 Base : ${DB_PATH}`);
}
