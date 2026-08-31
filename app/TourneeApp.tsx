"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  appleMapsUrl,
  DEMO_TOURNEES,
  getTourneeSummary,
  Patient,
  TOURNEE_CONFIG,
  TourneeId,
  Tournees,
} from "./tournee-data";

type Screen = "accueil" | "tournee" | "import";
type Progress = Record<TourneeId, string[]>;
type DeferredPatients = Record<TourneeId, string[]>;
type DurationHistory = Record<string, number[]>;
type NavigationPrompt = {
  patient: Patient;
  reason: "completed" | "selected" | "deferred";
};

const STORAGE_DATA = "ma-tournee-idel:data:v1";
const STORAGE_PROGRESS = "ma-tournee-idel:progress:v1";
const STORAGE_DEFERRED = "ma-tournee-idel:deferred:v1";
const STORAGE_DURATIONS = "ma-tournee-idel:durations:v1";
const EMPTY_PROGRESS: Progress = { matin: [], soir: [] };
const EMPTY_DEFERRED: DeferredPatients = { matin: [], soir: [] };

function createId(route: TourneeId, index: number) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${route}-${crypto.randomUUID()}`;
  }
  return `${route}-${Date.now()}-${index}`;
}

function normalizeHeader(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function findCell(row: Record<string, unknown>, aliases: string[]) {
  const normalized = new Map(
    Object.entries(row).map(([key, value]) => [normalizeHeader(key), value]),
  );
  for (const alias of aliases) {
    const value = normalized.get(alias);
    if (value !== undefined && String(value).trim() !== "") return value;
  }
  return undefined;
}

function parseNumber(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function durationKey(patient: Patient) {
  return [patient.nom, patient.adresse, patient.soin]
    .map(normalizeHeader)
    .join("|");
}

function estimatedDuration(patient: Patient, history: DurationHistory) {
  const samples = history[durationKey(patient)] ?? [];
  if (samples.length === 0) {
    return { minutes: patient.duree, samples: 0 };
  }

  const recent = samples.slice(-5);
  const minutes = Math.max(
    1,
    Math.round(recent.reduce((total, value) => total + value, 0) / recent.length),
  );
  return { minutes, samples: recent.length };
}

function formatTimer(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function nextPatientInOriginalOrder(
  patients: Patient[],
  completedIds: string[],
  deferredIds: string[],
  excludedId?: string,
) {
  const remaining = patients.filter(
    (patient) =>
      patient.id !== excludedId && !completedIds.includes(patient.id),
  );

  return (
    remaining.find((patient) => !deferredIds.includes(patient.id)) ??
    remaining[0] ??
    null
  );
}

function patientFromRow(
  row: Record<string, unknown>,
  index: number,
): { route: TourneeId; patient: Patient } | null {
  const nom = String(findCell(row, ["nom", "patient", "name"]) ?? "").trim();
  const adresse = String(
    findCell(row, ["adresse", "address", "domicile"]) ?? "",
  ).trim();
  if (!nom || !adresse) return null;

  const rawRoute = String(
    findCell(row, ["tournee", "tour", "periode", "moment"]) ?? "matin",
  ).toLowerCase();
  const route: TourneeId = /soir|evening|pm/.test(rawRoute) ? "soir" : "matin";

  return {
    route,
    patient: {
      id: createId(route, index),
      nom,
      adresse,
      soin: String(
        findCell(row, ["soin", "acte", "care", "intervention"]) ??
          "Soin à préciser",
      ).trim(),
      duree: Math.max(
        1,
        Math.round(
          parseNumber(
            findCell(row, ["duree", "dureemin", "duration", "minutes"]),
            15,
          ),
        ),
      ),
      notes: String(
        findCell(row, ["notes", "note", "commentaire", "commentaires"]) ?? "",
      ).trim(),
      kilometres: Math.max(
        0,
        parseNumber(
          findCell(row, ["kilometres", "kilometre", "km", "distance"]),
          0,
        ),
      ),
    },
  };
}

function Brand() {
  return (
    <div className="brand" aria-label="Ma Tournée IDEL">
      <span className="brand-mark" aria-hidden="true">
        <span />
        <i />
      </span>
      <span className="brand-name">
        Ma Tournée <strong>IDEL</strong>
      </span>
    </div>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

export function TourneeApp() {
  const [screen, setScreen] = useState<Screen>("accueil");
  const [tournees, setTournees] = useState<Tournees>(DEMO_TOURNEES);
  const [progress, setProgress] = useState<Progress>(EMPTY_PROGRESS);
  const [deferredPatients, setDeferredPatients] =
    useState<DeferredPatients>(EMPTY_DEFERRED);
  const [durationHistory, setDurationHistory] = useState<DurationHistory>({});
  const [selectedRoute, setSelectedRoute] = useState<TourneeId>("matin");
  const [activePatientId, setActivePatientId] = useState<string | null>(null);
  const [careStartedAt, setCareStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [navigationPrompt, setNavigationPrompt] =
    useState<NavigationPrompt | null>(null);
  const [patientListOpen, setPatientListOpen] = useState(false);
  const [importMessage, setImportMessage] = useState<string>("");
  const [importError, setImportError] = useState<string>("");
  const [isImporting, setIsImporting] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let savedData: Tournees | null = null;
    let savedProgress: Progress | null = null;
    let savedDeferred: DeferredPatients | null = null;
    let savedDurations: DurationHistory | null = null;
    let savedRoute: TourneeId | null = null;
    let cancelled = false;

    try {
      const storedData = localStorage.getItem(STORAGE_DATA);
      const storedProgress = localStorage.getItem(STORAGE_PROGRESS);
      const storedDeferred = localStorage.getItem(STORAGE_DEFERRED);
      const storedDurations = localStorage.getItem(STORAGE_DURATIONS);
      if (storedData) savedData = JSON.parse(storedData) as Tournees;
      if (storedProgress) savedProgress = JSON.parse(storedProgress) as Progress;
      if (storedDeferred) {
        savedDeferred = JSON.parse(storedDeferred) as DeferredPatients;
      }
      if (storedDurations) {
        savedDurations = JSON.parse(storedDurations) as DurationHistory;
      }

      const route = new URLSearchParams(window.location.search).get("tournee");
      if (route === "soir" || route === "matin") savedRoute = route;
    } catch {
      // Si le stockage est indisponible ou corrompu, la démo reste utilisable.
    }

    queueMicrotask(() => {
      if (cancelled) return;
      if (savedData) setTournees(savedData);
      if (savedProgress) setProgress(savedProgress);
      if (savedDeferred) setDeferredPatients(savedDeferred);
      if (savedDurations) setDurationHistory(savedDurations);
      if (savedRoute) setSelectedRoute(savedRoute);
      setHydrated(true);
    });

    if ("serviceWorker" in navigator) {
      const serviceWorkerUrl = new URL("sw.js", document.baseURI);
      navigator.serviceWorker.register(serviceWorkerUrl.pathname).catch(() => {
        // L’application continue de fonctionner en ligne si l’enregistrement échoue.
      });
    }

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(STORAGE_DATA, JSON.stringify(tournees));
  }, [tournees, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(STORAGE_PROGRESS, JSON.stringify(progress));
  }, [progress, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(STORAGE_DEFERRED, JSON.stringify(deferredPatients));
  }, [deferredPatients, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(STORAGE_DURATIONS, JSON.stringify(durationHistory));
  }, [durationHistory, hydrated]);

  useEffect(() => {
    if (careStartedAt === null) return;

    const updateTimer = () => {
      setElapsedSeconds(
        Math.max(0, Math.floor((Date.now() - careStartedAt) / 1000)),
      );
    };
    updateTimer();
    const timer = window.setInterval(updateTimer, 1000);
    return () => window.clearInterval(timer);
  }, [careStartedAt]);

  const activePatients = tournees[selectedRoute];
  const completedIds = progress[selectedRoute] ?? [];
  const deferredIds = deferredPatients[selectedRoute] ?? [];
  const activePatient = activePatientId
    ? activePatients.find(
        (patient) =>
          patient.id === activePatientId &&
          !completedIds.includes(patient.id),
      ) ?? null
    : null;
  const activeIndex = activePatient
    ? activePatients.findIndex((patient) => patient.id === activePatient.id)
    : -1;
  const completedCount = activePatients.filter((patient) =>
    completedIds.includes(patient.id),
  ).length;
  const routeComplete =
    activePatients.length > 0 && completedCount >= activePatients.length;

  const summaries = useMemo(
    () => ({
      matin: getTourneeSummary(
        tournees.matin.map((patient) => ({
          ...patient,
          duree: estimatedDuration(patient, durationHistory).minutes,
        })),
        TOURNEE_CONFIG.matin.start,
      ),
      soir: getTourneeSummary(
        tournees.soir.map((patient) => ({
          ...patient,
          duree: estimatedDuration(patient, durationHistory).minutes,
        })),
        TOURNEE_CONFIG.soir.start,
      ),
    }),
    [tournees, durationHistory],
  );

  function openTournee(route: TourneeId) {
    const firstPatient = nextPatientInOriginalOrder(
      tournees[route],
      progress[route] ?? [],
      deferredPatients[route] ?? [],
    );
    setSelectedRoute(route);
    setActivePatientId(firstPatient?.id ?? null);
    setCareStartedAt(null);
    setElapsedSeconds(0);
    setPatientListOpen(false);
    setNavigationPrompt(null);
    setScreen("tournee");
    window.scrollTo({ top: 0 });
  }

  function completeCare() {
    if (!activePatient || careStartedAt === null) return;
    const elapsedMinutes = Math.max(1, Math.round(elapsedSeconds / 60));
    const key = durationKey(activePatient);
    setDurationHistory((current) => ({
      ...current,
      [key]: [...(current[key] ?? []), elapsedMinutes].slice(-20),
    }));

    const updatedCompleted = Array.from(
      new Set([...completedIds, activePatient.id]),
    );
    setProgress((current) => ({
      ...current,
      [selectedRoute]: updatedCompleted,
    }));

    const updatedDeferred = deferredIds.filter(
      (patientId) => patientId !== activePatient.id,
    );
    setDeferredPatients((current) => ({
      ...current,
      [selectedRoute]: updatedDeferred,
    }));

    const next = nextPatientInOriginalOrder(
      activePatients,
      updatedCompleted,
      updatedDeferred,
    );
    setActivePatientId(next?.id ?? null);
    setCareStartedAt(null);
    setElapsedSeconds(0);
    setNavigationPrompt(
      next ? { patient: next, reason: "completed" } : null,
    );
  }

  function startCare() {
    setElapsedSeconds(0);
    setCareStartedAt(Date.now());
  }

  function deferActivePatient() {
    if (!activePatient) return;

    const updatedDeferred = Array.from(
      new Set([...deferredIds, activePatient.id]),
    );
    setDeferredPatients((current) => ({
      ...current,
      [selectedRoute]: updatedDeferred,
    }));

    const next = nextPatientInOriginalOrder(
      activePatients,
      completedIds,
      updatedDeferred,
      activePatient.id,
    );
    setActivePatientId(next?.id ?? null);
    setCareStartedAt(null);
    setElapsedSeconds(0);
    setNavigationPrompt(
      next ? { patient: next, reason: "deferred" } : null,
    );
  }

  function selectPatient(patient: Patient) {
    if (completedIds.includes(patient.id)) return;

    if (activePatient?.id === patient.id) {
      setPatientListOpen(false);
      return;
    }

    if (
      careStartedAt !== null &&
      activePatient?.id !== patient.id &&
      !window.confirm(
        "Un soin est chronométré. Changer de patient annulera ce chronométrage. Continuer ?",
      )
    ) {
      return;
    }

    setActivePatientId(patient.id);
    setCareStartedAt(null);
    setElapsedSeconds(0);
    setPatientListOpen(false);
    setNavigationPrompt({ patient, reason: "selected" });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function resetRoute(route: TourneeId) {
    setProgress((current) => ({ ...current, [route]: [] }));
    setDeferredPatients((current) => ({ ...current, [route]: [] }));
    setActivePatientId(tournees[route][0]?.id ?? null);
    setCareStartedAt(null);
    setElapsedSeconds(0);
    setNavigationPrompt(null);
  }

  function resetDemo() {
    setTournees(DEMO_TOURNEES);
    setProgress(EMPTY_PROGRESS);
    setDeferredPatients(EMPTY_DEFERRED);
    setActivePatientId(null);
    setCareStartedAt(null);
    setElapsedSeconds(0);
    setImportMessage("Les données fictives de démonstration ont été restaurées.");
    setImportError("");
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setImportError("");
    setImportMessage("");
    setIsImporting(true);

    try {
      const extension = file.name.split(".").pop()?.toLowerCase();
      if (!extension || !["csv", "xlsx", "xls"].includes(extension)) {
        throw new Error("Choisissez un fichier CSV, XLSX ou XLS.");
      }

      const XLSX = await import("xlsx");
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!firstSheet) throw new Error("Le fichier ne contient aucune feuille.");

      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(firstSheet, {
        defval: "",
        raw: false,
      });
      const imported: Tournees = { matin: [], soir: [] };
      let ignored = 0;

      rows.forEach((row, index) => {
        const result = patientFromRow(row, index);
        if (!result) {
          ignored += 1;
          return;
        }
        imported[result.route].push(result.patient);
      });

      const total = imported.matin.length + imported.soir.length;
      if (total === 0) {
        throw new Error(
          "Aucun patient valide. Vérifiez au minimum les colonnes nom et adresse.",
        );
      }

      setTournees(imported);
      setProgress(EMPTY_PROGRESS);
      setDeferredPatients(EMPTY_DEFERRED);
      setActivePatientId(null);
      setCareStartedAt(null);
      setElapsedSeconds(0);
      setImportMessage(
        `${total} patient${total > 1 ? "s" : ""} importé${total > 1 ? "s" : ""} — ${imported.matin.length} le matin, ${imported.soir.length} le soir${ignored ? ` · ${ignored} ligne${ignored > 1 ? "s" : ""} ignorée${ignored > 1 ? "s" : ""}` : ""}.`,
      );
    } catch (error) {
      setImportError(
        error instanceof Error
          ? error.message
          : "Le fichier n’a pas pu être importé.",
      );
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  if (screen === "import") {
    return (
      <main className="app-shell compact-shell">
        <header className="topbar">
          <button
            className="back-button"
            type="button"
            onClick={() => setScreen("accueil")}
            aria-label="Retour à l’accueil"
          >
            <span aria-hidden="true">←</span> Retour
          </button>
          <Brand />
        </header>

        <section className="page-intro">
          <p className="eyebrow">Préparer la journée</p>
          <h1>Importer les patients</h1>
          <p>
            Un seul fichier pour les tournées du matin et du soir. Les données
            restent uniquement sur cet appareil.
          </p>
        </section>

        <section className="import-card" aria-labelledby="import-title">
          <div className="file-mark" aria-hidden="true">
            CSV
            <span>+</span>
            XLSX
          </div>
          <h2 id="import-title">Choisir un fichier</h2>
          <p>La première feuille sera importée et remplacera la tournée actuelle.</p>
          <label className={`file-button ${isImporting ? "is-loading" : ""}`}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              onChange={importFile}
              disabled={isImporting}
            />
            {isImporting ? "Import en cours…" : "Parcourir les fichiers"}
          </label>
          <a className="sample-link" href="./exemple-patients.csv" download>
            Télécharger le fichier d’exemple
          </a>
        </section>

        {(importMessage || importError) && (
          <div
            className={`feedback ${importError ? "feedback-error" : "feedback-success"}`}
            role="status"
            aria-live="polite"
          >
            <strong>{importError ? "Import impossible" : "Import réussi"}</strong>
            <span>{importError || importMessage}</span>
          </div>
        )}

        <section className="format-card">
          <div>
            <span className="step-number">1</span>
            <div>
              <h2>Une ligne par patient</h2>
              <p>Les intitulés avec ou sans accent sont acceptés.</p>
            </div>
          </div>
          <div className="column-list" aria-label="Colonnes attendues">
            <span>tournee</span>
            <span>nom</span>
            <span>adresse</span>
            <span>soin</span>
            <span>duree</span>
            <span>notes</span>
            <span>kilometres</span>
          </div>
          <div>
            <span className="step-number">2</span>
            <div>
              <h2>Indiquer matin ou soir</h2>
              <p>Sans valeur, le patient est ajouté à la tournée du matin.</p>
            </div>
          </div>
        </section>

        <button className="text-button danger-text" type="button" onClick={resetDemo}>
          Restaurer les données fictives
        </button>
      </main>
    );
  }

  if (screen === "tournee") {
    const routeSummary = summaries[selectedRoute];
    const completeCount = completedCount;
    const remainingCount = activePatients.length - completeCount;
    const activeEstimate = activePatient
      ? estimatedDuration(activePatient, durationHistory)
      : null;
    const nextDefaultPatient = activePatient
      ? nextPatientInOriginalOrder(
          activePatients,
          [...completedIds, activePatient.id],
          deferredIds.filter((patientId) => patientId !== activePatient.id),
        )
      : null;

    return (
      <main className="app-shell runner-shell">
        <header className="runner-header">
          <button
            className="back-button light-back"
            type="button"
            onClick={() => setScreen("accueil")}
          >
            <span aria-hidden="true">←</span> Accueil
          </button>
          <div className="runner-title">
            <span>Tournée du {selectedRoute}</span>
            <strong>
              {completeCount}/{activePatients.length} terminés
            </strong>
          </div>
          <button
            className="patient-list-button"
            type="button"
            onClick={() => setPatientListOpen(true)}
            aria-label={`Afficher la liste, ${remainingCount} patient${remainingCount > 1 ? "s" : ""} restant${remainingCount > 1 ? "s" : ""}`}
          >
            <span aria-hidden="true">☷</span>
            Liste
          </button>
        </header>

        <div className="progress-track" aria-hidden="true">
          <span
            style={{
              width: `${activePatients.length ? (completeCount / activePatients.length) * 100 : 0}%`,
            }}
          />
        </div>

        {activePatients.length === 0 ? (
          <section className="empty-state">
            <span className="empty-symbol" aria-hidden="true">＋</span>
            <h1>Aucun patient</h1>
            <p>Importez un fichier pour préparer cette tournée.</p>
            <button className="primary-button" onClick={() => setScreen("import")}>
              Importer les patients
            </button>
          </section>
        ) : routeComplete ? (
          <section className="complete-state">
            <span className="complete-symbol" aria-hidden="true">✓</span>
            <p className="eyebrow">Tournée terminée</p>
            <h1>Bravo, tout est fait.</h1>
            <p>
              {activePatients.length} patient{activePatients.length > 1 ? "s" : ""} · {routeSummary.kilometres.toLocaleString("fr-FR")} km prévus
            </p>
            <button className="primary-button" onClick={() => setScreen("accueil")}>
              Revenir à l’accueil
            </button>
            <button className="text-button" onClick={() => resetRoute(selectedRoute)}>
              Recommencer cette tournée
            </button>
          </section>
        ) : !activePatient ? (
          <section className="complete-state revisit-state">
            <span className="complete-symbol revisit-symbol" aria-hidden="true">↻</span>
            <p className="eyebrow">À revoir plus tard</p>
            <h1>La tournée est en pause.</h1>
            <p>
              {remainingCount} patient{remainingCount > 1 ? "s" : ""} reste{remainingCount > 1 ? "nt" : ""} à voir.
            </p>
            <button
              className="primary-button"
              type="button"
              onClick={() => setPatientListOpen(true)}
            >
              Choisir un patient
            </button>
            <button className="text-button" onClick={() => setScreen("accueil") }>
              Revenir à l’accueil
            </button>
          </section>
        ) : (
          <>
            <section className="patient-stage">
              <div className="patient-count">
                Ordre initial · patient {activeIndex + 1} sur {activePatients.length}
              </div>
              <article className="patient-card">
                <div className="patient-heading">
                  <div>
                    <p>
                      {deferredIds.includes(activePatient.id)
                        ? "À revoir"
                        : "Maintenant"}
                    </p>
                    <h1>{activePatient.nom}</h1>
                  </div>
                  <div className="duration-estimate">
                    <span className="duration-badge">
                      ~{activeEstimate?.minutes ?? activePatient.duree} min
                    </span>
                    <small>
                      {activeEstimate?.samples
                        ? `moyenne de ${activeEstimate.samples} passage${activeEstimate.samples > 1 ? "s" : ""}`
                        : "estimation initiale"}
                    </small>
                  </div>
                </div>

                <div className="patient-detail address-detail">
                  <span className="detail-icon pin-icon" aria-hidden="true" />
                  <div>
                    <span>Adresse</span>
                    <strong>{activePatient.adresse}</strong>
                  </div>
                </div>
                <div className="patient-detail">
                  <span className="detail-icon care-icon" aria-hidden="true">+</span>
                  <div>
                    <span>Soin</span>
                    <strong>{activePatient.soin}</strong>
                  </div>
                </div>
                <div className="notes-box">
                  <span>Notes</span>
                  <p>{activePatient.notes || "Aucune note pour ce patient."}</p>
                </div>
              </article>

              {nextDefaultPatient && (
                <div className="next-preview">
                  <span>Par défaut ensuite</span>
                  <strong>{nextDefaultPatient.nom}</strong>
                  <small>{nextDefaultPatient.soin}</small>
                </div>
              )}
            </section>

            <footer className="action-dock">
              <a
                className="navigate-button"
                href={appleMapsUrl(activePatient.adresse)}
                target="_blank"
                rel="noreferrer"
              >
                <span className="nav-arrow" aria-hidden="true">↗</span>
                <span>
                  <strong>Naviguer</strong>
                  <small>Ouvrir dans Plans</small>
                </span>
              </a>
              {careStartedAt === null ? (
                <div className="patient-action-row">
                  <button className="start-care-button" type="button" onClick={startCare}>
                    <span aria-hidden="true">▶</span>
                    Commencer le soin
                  </button>
                  <button
                    className="not-seen-button"
                    type="button"
                    onClick={deferActivePatient}
                  >
                    <span aria-hidden="true">↻</span>
                    Patient non vu
                  </button>
                </div>
              ) : (
                <>
                  <div className="care-timer" role="timer" aria-live="off">
                    <span className="timer-dot" aria-hidden="true" />
                    <span>Soin en cours</span>
                    <strong>{formatTimer(elapsedSeconds)}</strong>
                  </div>
                  <button className="done-button" type="button" onClick={completeCare}>
                    <span aria-hidden="true">✓</span>
                    Soin terminé
                  </button>
                </>
              )}
            </footer>
          </>
        )}

        {patientListOpen && (
          <div className="modal-backdrop" role="presentation">
            <section
              className="patient-list-sheet"
              role="dialog"
              aria-modal="true"
              aria-labelledby="patient-list-title"
            >
              <span className="sheet-handle" aria-hidden="true" />
              <header className="patient-list-heading">
                <div>
                  <p className="eyebrow">Tournée du {selectedRoute}</p>
                  <h2 id="patient-list-title">Choisir un patient</h2>
                </div>
                <button
                  className="close-sheet-button"
                  type="button"
                  onClick={() => setPatientListOpen(false)}
                  aria-label="Fermer la liste"
                >
                  ×
                </button>
              </header>
              <p className="patient-list-help">
                Après ce patient, l’application reprendra le premier passage
                restant dans l’ordre initial.
              </p>
              <ol className="patient-list">
                {activePatients.map((patient, index) => {
                  const isCompleted = completedIds.includes(patient.id);
                  const isDeferred = deferredIds.includes(patient.id);
                  const isActive = activePatient?.id === patient.id;
                  const status = isCompleted
                    ? "Terminé"
                    : isActive
                      ? careStartedAt === null
                        ? "Maintenant"
                        : "Soin en cours"
                      : isDeferred
                        ? "À revoir"
                        : "À faire";

                  return (
                    <li key={patient.id}>
                      <button
                        className={`patient-list-item${isActive ? " is-active" : ""}${isDeferred ? " is-deferred" : ""}${isCompleted ? " is-completed" : ""}`}
                        type="button"
                        onClick={() => selectPatient(patient)}
                        disabled={isCompleted}
                        aria-label={`${index + 1}. ${patient.nom}, ${status}`}
                      >
                        <span className="patient-order" aria-hidden="true">
                          {isCompleted ? "✓" : index + 1}
                        </span>
                        <span className="patient-list-copy">
                          <strong>{patient.nom}</strong>
                          <small>{patient.adresse}</small>
                        </span>
                        <span className="patient-status">{status}</span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </section>
          </div>
        )}

        {navigationPrompt && (
          <div className="modal-backdrop" role="presentation">
            <section
              className="navigation-sheet"
              role="dialog"
              aria-modal="true"
              aria-labelledby="next-patient-title"
            >
              <span className="sheet-handle" aria-hidden="true" />
              <div className="next-ready" aria-hidden="true">
                {navigationPrompt.reason === "selected" ? "↗" : "✓"}
              </div>
              <p className="eyebrow">
                {navigationPrompt.reason === "completed"
                  ? "Soin enregistré"
                  : navigationPrompt.reason === "deferred"
                    ? "Patient reporté"
                    : "Patient sélectionné"}
              </p>
              <h2 id="next-patient-title">
                {navigationPrompt.reason === "selected"
                  ? navigationPrompt.patient.nom
                  : `Prochain patient : ${navigationPrompt.patient.nom}`}
              </h2>
              <p>{navigationPrompt.patient.adresse}</p>
              <a
                className="navigate-button sheet-navigate"
                href={appleMapsUrl(navigationPrompt.patient.adresse)}
                target="_blank"
                rel="noreferrer"
                autoFocus
                onClick={() => setNavigationPrompt(null)}
              >
                <span className="nav-arrow" aria-hidden="true">↗</span>
                <span>
                  <strong>Naviguer maintenant</strong>
                  <small>Ouvrir dans Plans</small>
                </span>
              </a>
              <button
                className="later-button"
                type="button"
                onClick={() => setNavigationPrompt(null)}
              >
                Plus tard
              </button>
            </section>
          </div>
        )}
      </main>
    );
  }

  return (
    <main className="app-shell home-shell">
      <header className="home-header">
        <Brand />
        <button
          className="import-shortcut"
          type="button"
          onClick={() => setScreen("import")}
        >
          <span aria-hidden="true">＋</span> Importer
        </button>
      </header>

      <section className="hero-card">
        <span className="hero-orbit orbit-one" aria-hidden="true" />
        <span className="hero-orbit orbit-two" aria-hidden="true" />
        <div className="hero-content">
          <p className="eyebrow">Aujourd’hui</p>
          <h1>Votre journée,<br />sans détour.</h1>
          <p>Deux tournées. Un patient à la fois.</p>
        </div>
        <div className="privacy-pill">
          <span aria-hidden="true">●</span> Données sur cet appareil
        </div>
      </section>

      {importMessage && (
        <div className="home-feedback" role="status">
          <span aria-hidden="true">✓</span>
          {importMessage}
        </div>
      )}

      <section className="tournees-section" aria-labelledby="tournees-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Programme</p>
            <h2 id="tournees-title">Mes tournées</h2>
          </div>
          <span className="route-total">
            {tournees.matin.length + tournees.soir.length} patients
          </span>
        </div>

        {(["matin", "soir"] as TourneeId[]).map((route) => {
          const config = TOURNEE_CONFIG[route];
          const summary = summaries[route];
          const completed = Math.min(
            progress[route]?.length ?? 0,
            tournees[route].length,
          );
          const deferred = tournees[route].filter((patient) =>
            (deferredPatients[route] ?? []).includes(patient.id),
          ).length;
          const isComplete = summary.patients > 0 && completed === summary.patients;
          const hasStarted = (completed > 0 || deferred > 0) && !isComplete;

          return (
            <article className={`route-card route-${route}`} key={route}>
              <div className="route-card-top">
                <div className="route-time">
                  <span className="sun-mark" aria-hidden="true">
                    {route === "matin" ? "☀" : "◐"}
                  </span>
                  <div>
                    <p>Tournée du</p>
                    <h3>{config.label}</h3>
                  </div>
                </div>
                <span className={`status-pill ${isComplete ? "done-status" : ""}`}>
                  {isComplete
                    ? "Terminée"
                    : deferred > 0
                      ? `${completed} fait${completed > 1 ? "s" : ""} · ${deferred} à revoir`
                    : hasStarted
                      ? `${completed}/${summary.patients} faits`
                      : `Départ ${config.start}`}
                </span>
              </div>

              <div className="metrics-row">
                <Metric value={String(summary.patients)} label="patients" />
                <Metric
                  value={`${summary.kilometres.toLocaleString("fr-FR")} km`}
                  label="prévus"
                />
                <Metric value={summary.end} label="fin estimée" />
              </div>

              <button
                className="route-button"
                type="button"
                onClick={() => openTournee(route)}
              >
                <span>
                  {isComplete ? "Voir la tournée" : hasStarted ? "Continuer" : "Commencer"}
                </span>
                <span aria-hidden="true">→</span>
              </button>
            </article>
          );
        })}
      </section>

      <p className="estimate-note">
        Fin estimée avec les durées apprises sur les 5 derniers passages et une
        vitesse moyenne de 30 km/h.
      </p>

      <details className="install-help">
        <summary>Installer sur l’iPhone</summary>
        <ol>
          <li>Ouvrez ce site dans Safari.</li>
          <li>Touchez Partager, puis « Sur l’écran d’accueil ».</li>
          <li>Ouvrez ensuite Ma Tournée comme une application.</li>
        </ol>
      </details>
    </main>
  );
}
