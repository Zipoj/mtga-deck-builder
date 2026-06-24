// ─── Thèmes visuels ──────────────────────────────────────────────────────────
// Deux axes indépendants : couleur (palette de variables CSS) et police (--font-family).
// Application = écriture des variables sur document.documentElement. Persistance localStorage.
// Aucun changement de disposition, uniquement couleurs + typographie.

export interface ColorTheme {
  id: string;
  // i18n key pour le nom affiché
  nameKey: string;
  // valeurs des variables CSS structurantes (les raretés / couleurs de mana restent globales)
  vars: Record<string, string>;
}

export interface FontTheme {
  id: string;
  // libellé affiché (nom de police, non traduit sauf "system")
  label: string;
  nameKey?: string;
  family: string;
}

// Variables pilotées par un thème couleur
export const VAR_KEYS = [
  "--bg-primary", "--bg-secondary", "--bg-card", "--bg-hover",
  "--border", "--accent", "--accent-light", "--text-primary", "--text-muted",
] as const;

// Libellés courts pour l'éditeur de thème perso (i18n keys)
export const VAR_LABEL_KEYS: Record<string, string> = {
  "--bg-primary": "theme.varBgPrimary",
  "--bg-secondary": "theme.varBgSecondary",
  "--bg-card": "theme.varBgCard",
  "--bg-hover": "theme.varBgHover",
  "--border": "theme.varBorder",
  "--accent": "theme.varAccent",
  "--accent-light": "theme.varAccentLight",
  "--text-primary": "theme.varTextPrimary",
  "--text-muted": "theme.varTextMuted",
};

export const CUSTOM_COLOR_ID = "custom";
const CUSTOM_VARS_KEY = "custom_color_vars";

export const COLOR_THEMES: ColorTheme[] = [
  {
    id: "dark",
    nameKey: "theme.dark",
    vars: {
      "--bg-primary": "#0f0f13", "--bg-secondary": "#1a1a24", "--bg-card": "#22223a",
      "--bg-hover": "#2a2a42", "--border": "#3a3a5c", "--accent": "#7c6af7",
      "--accent-light": "#a89cf8", "--text-primary": "#e8e6f0", "--text-muted": "#8a8aaa",
    },
  },
  {
    id: "light",
    nameKey: "theme.light",
    vars: {
      "--bg-primary": "#f4f4f8", "--bg-secondary": "#ffffff", "--bg-card": "#eef0f6",
      "--bg-hover": "#e2e4ee", "--border": "#c7cadb", "--accent": "#6a5af0",
      "--accent-light": "#8a7cf5", "--text-primary": "#1c1c28", "--text-muted": "#6a6a82",
    },
  },
  {
    id: "island",
    nameKey: "theme.island",
    vars: {
      "--bg-primary": "#0c1420", "--bg-secondary": "#122032", "--bg-card": "#16293f",
      "--bg-hover": "#1d3650", "--border": "#2a4259", "--accent": "#38b6e6",
      "--accent-light": "#7fd3f2", "--text-primary": "#e2edf5", "--text-muted": "#7d97ad",
    },
  },
  {
    id: "swamp",
    nameKey: "theme.swamp",
    vars: {
      "--bg-primary": "#100a14", "--bg-secondary": "#1a1020", "--bg-card": "#241630",
      "--bg-hover": "#2e1d3e", "--border": "#412a52", "--accent": "#9b59b6",
      "--accent-light": "#c08fd6", "--text-primary": "#ece3f2", "--text-muted": "#9a85aa",
    },
  },
  {
    id: "mountain",
    nameKey: "theme.mountain",
    vars: {
      "--bg-primary": "#160c0a", "--bg-secondary": "#221210", "--bg-card": "#321a16",
      "--bg-hover": "#42221d", "--border": "#5c322a", "--accent": "#e0533a",
      "--accent-light": "#f2856f", "--text-primary": "#f4e6e2", "--text-muted": "#aa8a82",
    },
  },
  {
    id: "forest",
    nameKey: "theme.forest",
    vars: {
      "--bg-primary": "#0a140d", "--bg-secondary": "#102018", "--bg-card": "#162920",
      "--bg-hover": "#1d362a", "--border": "#2a4d3a", "--accent": "#3ab87c",
      "--accent-light": "#6fd6a3", "--text-primary": "#e2f2e8", "--text-muted": "#85aa95",
    },
  },
];

export const FONT_THEMES: FontTheme[] = [
  { id: "system",    nameKey: "theme.fontSystem", label: "Segoe UI",     family: "'Segoe UI', system-ui, -apple-system, sans-serif" },
  { id: "serif",     label: "Georgia",      family: "Georgia, 'Times New Roman', serif" },
  { id: "mono",      label: "Consolas",     family: "Consolas, 'Courier New', monospace" },
  { id: "trebuchet", label: "Trebuchet MS", family: "'Trebuchet MS', sans-serif" },
  { id: "verdana",   label: "Verdana",      family: "Verdana, Geneva, sans-serif" },
  { id: "cambria",   label: "Cambria",      family: "Cambria, Georgia, serif" },
];

// Thème couleur personnalisable par l'utilisateur (vars stockées dans localStorage).
export const CUSTOM_COLOR_THEME: ColorTheme = {
  id: CUSTOM_COLOR_ID,
  nameKey: "theme.custom",
  vars: {},
};

export const DEFAULT_COLOR_THEME = "dark";
export const DEFAULT_FONT_THEME = "system";

/** Vars du thème perso : lit le localStorage, complète avec le thème sombre par défaut. */
export function getCustomColorVars(): Record<string, string> {
  const base = COLOR_THEMES[0].vars;
  try {
    const raw = localStorage.getItem(CUSTOM_VARS_KEY);
    if (raw) return { ...base, ...JSON.parse(raw) };
  } catch { /* JSON invalide → fallback */ }
  return { ...base };
}

/** Enregistre les vars du thème perso. */
export function saveCustomColorVars(vars: Record<string, string>): void {
  localStorage.setItem(CUSTOM_VARS_KEY, JSON.stringify(vars));
}

export function getColorTheme(id: string): ColorTheme {
  if (id === CUSTOM_COLOR_ID) return { ...CUSTOM_COLOR_THEME, vars: getCustomColorVars() };
  return COLOR_THEMES.find((t) => t.id === id) ?? COLOR_THEMES[0];
}
export function getFontTheme(id: string): FontTheme {
  return FONT_THEMES.find((t) => t.id === id) ?? FONT_THEMES[0];
}

/** Applique une palette couleur en écrivant les variables CSS sur :root. */
export function applyColorTheme(id: string): void {
  const theme = getColorTheme(id);
  const root = document.documentElement;
  for (const key of VAR_KEYS) {
    const val = theme.vars[key];
    if (val) root.style.setProperty(key, val);
  }
}

/** Applique une police via la variable --font-family. */
export function applyFontTheme(id: string): void {
  document.documentElement.style.setProperty("--font-family", getFontTheme(id).family);
}

/** À appeler au démarrage : lit les réglages persistés et les applique. */
export function initThemes(): void {
  applyColorTheme(localStorage.getItem("color_theme") ?? DEFAULT_COLOR_THEME);
  applyFontTheme(localStorage.getItem("font_theme") ?? DEFAULT_FONT_THEME);
}
