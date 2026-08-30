import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TourneeApp } from "../app/TourneeApp";
import "../app/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TourneeApp />
  </StrictMode>,
);
