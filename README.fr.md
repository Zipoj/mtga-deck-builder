<div align="center">

<img src="docs/img/lotus.png" width="90" alt="MTGA Deck Builder logo"><br>

# MTGA Deck Builder

**Le deck builder compagnon pour MTG Arena — tout ce que fait Arena, plus les outils qui lui manquent.**

[English](README.md) · [Français](README.fr.md)

![version](https://img.shields.io/badge/version-1.0.1-7c4dff)
![platform](https://img.shields.io/badge/platform-Windows-0078d6)
![Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24c8db)
![license](https://img.shields.io/badge/license-MIT-green)

### [⬇️ Télécharger la dernière version](https://github.com/Zipoj/mtga-deck-builder/releases/latest)

</div>

---

## ✨ Aperçu

Construisez vos decks Magic: The Gathering Arena à partir des cartes que vous **possédez vraiment** — entièrement sur votre machine, sans compte, sans cloud.

<!-- SCREENSHOT: vue principale du deck builder -->
<p align="center"><img src="docs/img/overview.png" width="850" alt="MTGA Deck Builder — vue de construction de deck"></p>

## Fonctionnalités

### Les bases — tout ce que vous attendez d'Arena

- 🃏 **Deck builder** avec glisser-déposer, courbe de mana, répartition par type/couleur et statistiques complètes
- 📦 **Vue collection** synchronisée depuis vos données MTG Arena locales — voyez exactement ce que vous possédez
- 🔍 Recherche puissante avec filtres format, couleur, type, rareté et extension
- 🔄 Support des cartes recto-verso (vue retournée)

### Ce que le builder ajoute en plus

- 📤 **Import & export** de vos decks en toute liberté — déplacez vos listes en texte, partagez-les, sauvegardez-les
- ♾️ **Aucune limite de decks** — Arena vous plafonne à 100 decks ; ici gardez-en autant que vous voulez et constituez une bien plus grande bibliothèque
- 🔗 Navigateur de **combos** avec import/export
- ⭐ Gestion des **favoris**
- 🔎 **Recherche & filtres indépendants par onglet** — chaque onglet conserve sa propre recherche et ses filtres, donc passer de l'un à l'autre ne réinitialise jamais ce que vous regardiez
- 💾 **Persistance optionnelle** — rouvrez l'app exactement là où vous l'aviez laissée, avec les mêmes decks et vues ouverts
- 🌍 **Données de carte multilingues** — réglages de langue indépendants pour le texte et les illustrations (11 langues)
- 🖥️ **Interface localisée** (11 langues)
- 🎨 **Thèmes** (6 préréglages, couleur d'accent personnalisée, plusieurs polices)
- 🧩 Intégration de l'extension de navigateur compagnon (ComboTGA) via une API REST locale

## 🖼️ Tour d'horizon

<p align="center"><img src="docs/img/search.png" width="850" alt="Recherche et filtres"></p>
<p align="center"><em>Recherche puissante avec filtres format, couleur, type, rareté et extension — plus des actions au clic droit pour mettre en favori, envoyer vers un deck ou créer un combo.</em></p>

<p align="center"><img src="docs/img/build.png" width="850" alt="Construction de deck avec stats en direct"></p>
<p align="center"><em>Construisez en glisser-déposer pendant que les stats en direct (courbe de mana, couleurs, types) se mettent à jour en haut.</em></p>

<p align="center"><img src="docs/img/stats.png" width="850" alt="Navigateur de combos"></p>
<p align="center"><em>Le navigateur de combos — organisez, taguez, importez et exportez vos interactions favorites.</em></p>

## 🚀 Installation

1. Rendez-vous sur la [**dernière release**](https://github.com/Zipoj/mtga-deck-builder/releases/latest) et téléchargez **`MTGA Deck Builder_1.0.1_x64-setup.exe`**.
2. Lancez l'installeur et suivez l'assistant.
3. Si **Windows SmartScreen** apparaît (l'app n'est pas signée), cliquez sur **Informations complémentaires** → **Exécuter quand même**.

> 💡 Deux formats sont disponibles : l'installeur `-setup.exe` (recommandé) et un paquet `.msi`.

## 📖 Première utilisation — construire sa base de données

L'application démarre vide : vous construisez votre base de cartes locale en quelques étapes guidées depuis la page **Paramètres**. Faites-les dans l'ordre la première fois.

<p align="center"><img src="docs/img/sync.png" width="850" alt="Paramètres — configuration de la base"></p>

### 1. Télécharger la base de données (requis)

Récupérez l'ensemble des données de cartes depuis **Scryfall**. C'est la fondation — noms, coûts, types, texte oracle et images anglaises de chaque carte. Paramètres → **Mettre à jour la base**.

### 2. Télécharger les images localisées (optionnel)

Si vous voulez les illustrations dans une autre langue, récupérez les images localisées pour la langue de votre choix. Paramètres → **Images localisées**. Purement esthétique — sautez cette étape si l'anglais vous convient.

### 3. Synchroniser les données MTG Arena — traductions & cartes manquantes

Indiquez à l'app votre dossier de données MTG Arena local et lancez la synchronisation. Elle fait deux choses importantes :

- **Texte de carte localisé** dans la langue du fichier raw (noms, types, texte oracle).
- **Débloque les cartes très récentes** que Scryfall liste mais n'a pas encore taguées pour Arena (un backfill d'Arena-ID). Ces cartes existent dans les données Scryfall mais restent cachées tant que vos fichiers Arena ne confirment pas que vous pouvez les obtenir — la synchro les révèle.

Elle permet aussi à la **recherche de fonctionner en anglais et dans votre langue en même temps**, pour trouver une carte par l'un ou l'autre nom.

> **Utilisateurs anglophones :** la synchro est par langue, donc choisissez simplement une langue (par ex. le français) pour la lancer — vos noms anglais ne sont **jamais écrasés**. Laissez juste le **bouton LOC sur EN** et l'app reste entièrement en anglais, tout en profitant des cartes débloquées et d'une recherche bilingue.

### 4. Synchroniser votre collection

Avec **MTG Arena lancé**, synchronisez votre collection pour que le builder sache exactement quelles cartes — et en quelle quantité — vous possédez. Paramètres → **Synchroniser la collection**.

## 🌐 Le bouton LOC

Le bouton **LOC** (barre du haut) bascule le texte et les images des cartes entre l'**anglais** et votre langue sélectionnée à la volée. Activez-le pour tout lire en version localisée ; remettez-le sur **EN** pour retrouver l'anglais d'origine — vos données restent intactes dans les deux cas.

## 🧩 Extension de navigateur — *bientôt disponible*

Une extension de navigateur compagnon (**ComboTGA**) dialogue avec le builder via une API REST locale pour amener les données de combos directement dans votre navigateur. Les versions **Firefox** et **Opera** sont **prêtes et actuellement en attente de validation** par les stores — les liens seront ajoutés ici dès qu'elles seront approuvées.

## 🛠️ Compiler depuis les sources

Prérequis : [Node.js](https://nodejs.org/), [Rust](https://www.rust-lang.org/tools/install) et les [prérequis Tauri](https://tauri.app/start/prerequisites/).

```bash
npm install          # installer les dépendances frontend
npm run tauri dev    # lancer l'app en développement
npm run tauri build  # compiler un installeur de release
```

**Stack technique :** React 18 · TypeScript · CSS Modules · Vite · Rust (Tauri 2) · rusqlite (SQLite + FTS5). Données de carte depuis Scryfall + données MTG Arena locales.

## 🙏 Remerciements

Un immense merci à **Andrew Gioia** pour les superbes symboles de mana et d'extension utilisés dans toute l'app :

- [Mana](https://github.com/andrewgioia/mana) — police pour les symboles de mana et coûts de carte
- [Keyrune](https://github.com/andrewgioia/keyrune) — police pour les symboles d'extension

## Licence

[MIT](LICENSE) © 2026 Zipoj

---

## 💬 Un mot de l'auteur

Un **projet solo** démarré pour le fun, qui a fini par me motiver à ajouter tout un tas de fonctions. N'hésitez pas à faire remonter les bugs — voire les cartes manquantes, car la base de données est une vraie plaie à gérer.

Si vous souhaitez soutenir le projet, vous pouvez le faire ici :

[![Ko-fi](https://img.shields.io/badge/Soutenez--moi%20sur-Ko--fi-ff5e5b?logo=ko-fi&logoColor=white)](https://ko-fi.com/zipoj)

C'est entièrement optionnel — utiliser et partager l'app est déjà un énorme merci. ❤️
