import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";
import "flag-icons/css/flag-icons.min.css";
import { initThemes } from "./themes";

// Applique le thème couleur + police persistés avant le premier rendu
initThemes();

// Désactive le menu contextuel natif du webview (Actualiser, Enregistrer sous, Inspecter…)
// Les menus custom React (CardContextMenu etc.) fonctionnent toujours via leurs propres handlers.
document.addEventListener("contextmenu", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
