# MTGA Deck Builder

A desktop deck builder for **Magic: The Gathering Arena**, focused on building decks from the cards you actually own.

Built with **Tauri 2 + React + TypeScript** and a local **SQLite** card database (no account, no cloud — everything runs and stays on your machine).

## Features

- **Deck builder** with drag & drop, mana curve, type/color breakdown and deck statistics
- **Collection view** synced from your local MTG Arena data
- **Combos** browser with import/export
- **Favorites** management
- Powerful card search with format, color, type, rarity and set filters
- **Multilingual** card data — independent settings for card text language and card image language (11 languages)
- **Localized UI** (11 languages)
- **Theme support** (6 presets, custom accent color, multiple fonts)
- Double-faced card support (flip view)
- Companion browser extension ([ComboTGA](https://github.com/Zipoj/combotga)) integration via a local REST API

## Tech stack

- **Frontend:** React 18, TypeScript, CSS Modules, Vite
- **Backend:** Rust (Tauri 2), rusqlite (SQLite + FTS5)
- **Card data:** Scryfall (card images & text) + local MTG Arena data

## Development

Requirements: [Node.js](https://nodejs.org/), [Rust](https://www.rust-lang.org/tools/install) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```bash
npm install          # install frontend dependencies
npm run tauri dev    # run the app in development
npm run tauri build  # build a release binary
```

## License

[MIT](LICENSE) © 2026 Zipoj
