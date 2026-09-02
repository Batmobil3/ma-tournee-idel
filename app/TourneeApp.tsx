"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  appleMapsUrl,
  DEMO_TOURNEES,
  getTourneeSummary,
  Patient,
  TOURNEE_CONFIG,
  TourneeId,
  Tournees,
} from "./tournee-data";
import {
  appendTransmission,
  GoogleSyncConfig,
  isGoogleSyncConfigured,
  loadGoogleSyncConfig,
  loadSharedSheet,
  markTransmissionRead,
  NurseName,
  requestGoogleAccessToken,
  SheetRowReferences,
  Transmission,
  TransmissionPriority,
  updatePatientFile,
} from "./google-sheets";

type Screen = "accueil" | "tournee" | "import" | "transmissions";
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
const STORAGE_NURSE = "ma-tournee-idel:nurse:v1";
const EMPTY_PROGRESS: Progress = { matin: [], soir: [] };
const EMPTY_DEFERRED: DeferredPatients = { matin: [], soir: [] };
const EMPTY_ROW_REFERENCES: SheetRowReferences = {
  ficheRowByPatientId: {},
  importRowsByPatientId: {},
};

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

function parseTransmissionDate(value: string, reference = new Date()) {
  const text = value.trim();
  const localized = text.match(
    /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})(?:[ T](\d{1,2})(?::(\d{2}))?)?/,
  );

  if (localized) {
    const [, first, second, rawYear, rawHour = "0", rawMinute = "0"] = localized;
    const year = Number(rawYear) < 100 ? 2000 + Number(rawYear) : Number(rawYear);
    const hour = Number(rawHour);
    const minute = Number(rawMinute);
    const candidates = [
      { day: Number(first), month: Number(second) },
      { day: Number(second), month: Number(first) },
    ]
      .map(({ day, month }) => ({
        day,
        month,
        date: new Date(year, month - 1, day, hour, minute),
      }))
      .filter(
        ({ day, month, date }) =>
          date.getFullYear() === year &&
          date.getMonth() === month - 1 &&
          date.getDate() === day &&
          date.getHours() === hour &&
          date.getMinutes() === minute,
      )
      .map(({ date }) => date);

    if (candidates.length > 0) {
      return candidates.sort(
        (left, right) =>
          Math.abs(left.getTime() - reference.getTime()) -
          Math.abs(right.getTime() - reference.getTime()),
      )[0];
    }
  }

  return new Date(text);
}

function formatTransmissionDate(value: string) {
  const parsed = parseTransmissionDate(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isTransmissionFromYesterday(value: string, reference = new Date()) {
  const parsed = parseTransmissionDate(value, reference);
  if (Number.isNaN(parsed.getTime())) return false;

  const today = new Date(reference);
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  return parsed >= yesterday && parsed < today;
}

function formatYesterday(reference = new Date()) {
  const yesterday = new Date(reference);
  yesterday.setDate(yesterday.getDate() - 1);
  return yesterday.toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

function isUnreadForNurse(transmission: Transmission, nurse: NurseName | null) {
  if (nurse === "Manon") return !transmission.readByManon;
  if (nurse === "Aurore") return !transmission.readByAurore;
  return false;
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
  const [googleConfig, setGoogleConfig] = useState<GoogleSyncConfig | null>(null);
  const [googleAccessToken, setGoogleAccessToken] = useState<string | null>(null);
  const [googleSyncStatus, setGoogleSyncStatus] = useState<
    "loading" | "unconfigured" | "disconnected" | "connecting" | "syncing" | "synced" | "error"
  >("loading");
  const [googleSyncMessage, setGoogleSyncMessage] = useState("");
  const [googleSyncError, setGoogleSyncError] = useState("");
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);
  const [nurseName, setNurseName] = useState<NurseName | null>(null);
  const [transmissions, setTransmissions] = useState<Transmission[]>([]);
  const [sheetRowReferences, setSheetRowReferences] =
    useState<SheetRowReferences>(EMPTY_ROW_REFERENCES);
  const [transmissionMessage, setTransmissionMessage] = useState("");
  const [transmissionCategory, setTransmissionCategory] = useState("Autre");
  const [transmissionPriority, setTransmissionPriority] =
    useState<TransmissionPriority>("Normale");
  const [transmissionUpdatesFile, setTransmissionUpdatesFile] = useState(false);
  const [transmissionTargetField, setTransmissionTargetField] = useState("soin");
  const [transmissionNewValue, setTransmissionNewValue] = useState("");
  const [isSavingTransmission, setIsSavingTransmission] = useState(false);
  const [isMarkingAllTransmissions, setIsMarkingAllTransmissions] =
    useState(false);
  const [transmissionError, setTransmissionError] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const googleTokenExpiresAt = useRef(0);

  const syncFromGoogle = useCallback(
    async (tokenOverride?: string, configOverride?: GoogleSyncConfig) => {
      const token = tokenOverride ?? googleAccessToken;
      const config = configOverride ?? googleConfig;
      if (!token || !config || !isGoogleSyncConfigured(config)) return;

      setGoogleSyncStatus("syncing");
      setGoogleSyncError("");
      try {
        const snapshot = await loadSharedSheet(token, config.spreadsheetId);
        setTournees(snapshot.tournees);
        setTransmissions(snapshot.transmissions);
        setSheetRowReferences(snapshot.rowReferences);
        setProgress((current) => ({
          matin: current.matin.filter((id) =>
            snapshot.tournees.matin.some((patient) => patient.id === id),
          ),
          soir: current.soir.filter((id) =>
            snapshot.tournees.soir.some((patient) => patient.id === id),
          ),
        }));
        setDeferredPatients((current) => ({
          matin: current.matin.filter((id) =>
            snapshot.tournees.matin.some((patient) => patient.id === id),
          ),
          soir: current.soir.filter((id) =>
            snapshot.tournees.soir.some((patient) => patient.id === id),
          ),
        }));
        setLastSyncAt(new Date());
        setGoogleSyncStatus("synced");
        setGoogleSyncMessage(
          `${snapshot.tournees.matin.length + snapshot.tournees.soir.length} passages synchronisés avec Google Drive.`,
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "La synchronisation a échoué.";
        setGoogleSyncError(message);
        setGoogleSyncStatus(/expiré|401/i.test(message) ? "disconnected" : "error");
        if (/expiré|401/i.test(message)) setGoogleAccessToken(null);
      }
    },
    [googleAccessToken, googleConfig],
  );

  useEffect(() => {
    let savedData: Tournees | null = null;
    let savedProgress: Progress | null = null;
    let savedDeferred: DeferredPatients | null = null;
    let savedDurations: DurationHistory | null = null;
    let savedRoute: TourneeId | null = null;
    let savedNurse: NurseName | null = null;
    let cancelled = false;

    try {
      const storedData = localStorage.getItem(STORAGE_DATA);
      const storedProgress = localStorage.getItem(STORAGE_PROGRESS);
      const storedDeferred = localStorage.getItem(STORAGE_DEFERRED);
      const storedDurations = localStorage.getItem(STORAGE_DURATIONS);
      const storedNurse = localStorage.getItem(STORAGE_NURSE);
      if (storedData) savedData = JSON.parse(storedData) as Tournees;
      if (storedProgress) savedProgress = JSON.parse(storedProgress) as Progress;
      if (storedDeferred) {
        savedDeferred = JSON.parse(storedDeferred) as DeferredPatients;
      }
      if (storedDurations) {
        savedDurations = JSON.parse(storedDurations) as DurationHistory;
      }
      if (storedNurse === "Manon" || storedNurse === "Aurore") {
        savedNurse = storedNurse;
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
      if (savedNurse) setNurseName(savedNurse);
      setHydrated(true);
    });

    loadGoogleSyncConfig()
      .then((config) => {
        if (cancelled) return;
        setGoogleConfig(config);
        setGoogleSyncStatus(
          isGoogleSyncConfigured(config) ? "disconnected" : "unconfigured",
        );
      })
      .catch((error) => {
        if (cancelled) return;
        setGoogleSyncStatus("error");
        setGoogleSyncError(
          error instanceof Error
            ? error.message
            : "La configuration Google n’a pas pu être chargée.",
        );
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
    if (!hydrated || !nurseName) return;
    localStorage.setItem(STORAGE_NURSE, nurseName);
  }, [nurseName, hydrated]);

  useEffect(() => {
    if (!googleAccessToken || !googleConfig) return;

    const refresh = () => {
      if (Date.now() >= googleTokenExpiresAt.current - 30_000) {
        setGoogleAccessToken(null);
        setGoogleSyncStatus("disconnected");
        setGoogleSyncMessage("Reconnectez Google pour reprendre la synchronisation.");
        return;
      }
      void syncFromGoogle();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const timer = window.setInterval(refresh, 60_000);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [googleAccessToken, googleConfig, syncFromGoogle]);

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
  const activePatientTransmissions = activePatient
    ? transmissions
        .filter(
          (transmission) =>
            transmission.patientId === activePatient.id &&
            transmission.status !== "Archivée",
        )
        .slice(-5)
        .reverse()
    : [];
  const unreadTransmissionCount = activePatientTransmissions.filter(
    (transmission) => isUnreadForNurse(transmission, nurseName),
  ).length;
  const unreadTransmissions = useMemo(
    () =>
      transmissions.filter(
        (transmission) =>
          transmission.status !== "Archivée" &&
          isUnreadForNurse(transmission, nurseName),
      ),
    [nurseName, transmissions],
  );
  const unreadCountByPatientId = useMemo(() => {
    const counts = new Map<string, number>();
    unreadTransmissions.forEach((transmission) => {
      counts.set(
        transmission.patientId,
        (counts.get(transmission.patientId) ?? 0) + 1,
      );
    });
    return counts;
  }, [unreadTransmissions]);
  const yesterdayUnreadTransmissions = unreadTransmissions
    .filter((transmission) =>
      isTransmissionFromYesterday(transmission.dateTime),
    )
    .sort(
      (left, right) =>
        parseTransmissionDate(right.dateTime).getTime() -
        parseTransmissionDate(left.dateTime).getTime(),
    );
  const yesterdayLabel = formatYesterday();
  const activeIndex = activePatient
    ? activePatients.findIndex((patient) => patient.id === activePatient.id)
    : -1;
  const completedCount = activePatients.filter((patient) =>
    completedIds.includes(patient.id),
  ).length;
  const routeComplete =
    activePatients.length > 0 && completedCount >= activePatients.length;

  useEffect(() => {
    if (!hydrated || screen !== "tournee") return;

    if (activePatient) {
      setNavigationPrompt((current) => {
        if (!current) return null;
        const refreshedPatient = activePatients.find(
          (patient) => patient.id === current.patient.id,
        );
        if (!refreshedPatient) return null;
        return refreshedPatient === current.patient
          ? current
          : { ...current, patient: refreshedPatient };
      });
      return;
    }

    // Un identifiant absent signifie une pause volontaire (par exemple quand
    // tous les patients restants ont été reportés). Seul un ancien identifiant
    // devenu introuvable après actualisation doit être remplacé.
    if (activePatientId === null) return;

    const next = nextPatientInOriginalOrder(
      activePatients,
      completedIds,
      deferredIds,
    );
    if ((next?.id ?? null) === activePatientId) return;

    setActivePatientId(next?.id ?? null);
    setCareStartedAt(null);
    setElapsedSeconds(0);
    setNavigationPrompt(null);
  }, [
    activePatient,
    activePatientId,
    activePatients,
    completedIds,
    deferredIds,
    hydrated,
    screen,
  ]);

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

  async function connectGoogle() {
    if (!nurseName) {
      setGoogleSyncError("Choisissez d’abord Manon ou Aurore.");
      return;
    }
    if (!googleConfig || !isGoogleSyncConfigured(googleConfig)) {
      setGoogleSyncStatus("unconfigured");
      setGoogleSyncError(
        "La feuille Google et l’autorisation de l’application doivent encore être configurées.",
      );
      return;
    }

    setGoogleSyncStatus("connecting");
    setGoogleSyncError("");
    try {
      const token = await requestGoogleAccessToken(googleConfig.clientId);
      googleTokenExpiresAt.current = token.expiresAt;
      setGoogleAccessToken(token.accessToken);
      await syncFromGoogle(token.accessToken, googleConfig);
    } catch (error) {
      setGoogleSyncStatus("error");
      setGoogleSyncError(
        error instanceof Error ? error.message : "La connexion Google a échoué.",
      );
    }
  }

  async function saveTransmission() {
    const message = transmissionMessage.trim();
    if (!activePatient || !message) {
      setTransmissionError("Écrivez la transmission avant de l’envoyer.");
      return;
    }
    if (!nurseName || !googleAccessToken || !googleConfig) {
      setTransmissionError(
        "Connectez Google Drive depuis l’écran Synchroniser avant d’envoyer.",
      );
      return;
    }
    const newValue = transmissionNewValue.trim() || message;
    if (transmissionUpdatesFile && !newValue) {
      setTransmissionError("Indiquez la nouvelle information de la fiche.");
      return;
    }

    setIsSavingTransmission(true);
    setTransmissionError("");
    try {
      await appendTransmission(googleAccessToken, googleConfig.spreadsheetId, {
        patient: activePatient,
        route: selectedRoute,
        author: nurseName,
        category: transmissionCategory,
        priority: transmissionPriority,
        message,
        updateFile: transmissionUpdatesFile,
        targetField: transmissionUpdatesFile ? transmissionTargetField : "",
        newValue: transmissionUpdatesFile ? newValue : "",
      });
      if (transmissionUpdatesFile) {
        await updatePatientFile(
          googleAccessToken,
          googleConfig.spreadsheetId,
          sheetRowReferences,
          activePatient.id,
          selectedRoute,
          transmissionTargetField,
          newValue,
          nurseName,
        );
      }
      setTransmissionMessage("");
      setTransmissionNewValue("");
      setTransmissionUpdatesFile(false);
      setTransmissionPriority("Normale");
      await syncFromGoogle();
    } catch (error) {
      setTransmissionError(
        error instanceof Error
          ? error.message
          : "La transmission n’a pas pu être enregistrée.",
      );
    } finally {
      setIsSavingTransmission(false);
    }
  }

  async function markAsRead(transmission: Transmission) {
    if (!nurseName || !googleAccessToken || !googleConfig) return;
    setTransmissionError("");
    try {
      await markTransmissionRead(
        googleAccessToken,
        googleConfig.spreadsheetId,
        transmission.sheetRow,
        nurseName,
      );
      setTransmissions((current) =>
        current.map((item) =>
          item.id === transmission.id
            ? {
                ...item,
                readByManon:
                  nurseName === "Manon" ? true : item.readByManon,
                readByAurore:
                  nurseName === "Aurore" ? true : item.readByAurore,
              }
            : item,
        ),
      );
    } catch (error) {
      setTransmissionError(
        error instanceof Error
          ? error.message
          : "La transmission n’a pas pu être marquée comme lue.",
      );
    }
  }

  async function markAllYesterdayAsRead() {
    if (
      !nurseName ||
      !googleAccessToken ||
      !googleConfig ||
      yesterdayUnreadTransmissions.length === 0
    ) {
      return;
    }

    setIsMarkingAllTransmissions(true);
    setTransmissionError("");
    const transmissionIds = new Set(
      yesterdayUnreadTransmissions.map((transmission) => transmission.id),
    );

    try {
      await Promise.all(
        yesterdayUnreadTransmissions.map((transmission) =>
          markTransmissionRead(
            googleAccessToken,
            googleConfig.spreadsheetId,
            transmission.sheetRow,
            nurseName,
          ),
        ),
      );
      setTransmissions((current) =>
        current.map((transmission) =>
          transmissionIds.has(transmission.id)
            ? {
                ...transmission,
                readByManon:
                  nurseName === "Manon" ? true : transmission.readByManon,
                readByAurore:
                  nurseName === "Aurore" ? true : transmission.readByAurore,
              }
            : transmission,
        ),
      );
    } catch (error) {
      setTransmissionError(
        error instanceof Error
          ? error.message
          : "Les transmissions n’ont pas pu être marquées comme lues.",
      );
    } finally {
      setIsMarkingAllTransmissions(false);
    }
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

  if (screen === "transmissions") {
    return (
      <main className="app-shell compact-shell transmissions-screen">
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

        <section className="page-intro transmissions-page-intro">
          <p className="eyebrow">Relève Manon & Aurore</p>
          <h1>Transmissions de la veille</h1>
          <p>
            Informations encore non lues du {yesterdayLabel}. Une alerte reste
            visible dans la liste tant que la transmission n’est pas marquée
            comme lue.
          </p>
        </section>

        {!googleAccessToken ? (
          <button
            className="transmissions-connect-card"
            type="button"
            onClick={() => setScreen("import")}
          >
            <span className="alert-symbol" aria-hidden="true">!</span>
            <span>
              <strong>Connecter Google Drive</strong>
              <small>Pour afficher les transmissions de la veille</small>
            </span>
            <span aria-hidden="true">›</span>
          </button>
        ) : yesterdayUnreadTransmissions.length === 0 ? (
          <section className="transmissions-empty" aria-live="polite">
            <span aria-hidden="true">✓</span>
            <h2>Tout a été lu</h2>
            <p>Aucune nouvelle transmission de la veille.</p>
          </section>
        ) : (
          <>
            <div className="transmissions-summary" role="status">
              <span className="alert-symbol" aria-hidden="true">!</span>
              <strong>
                {yesterdayUnreadTransmissions.length} nouvelle
                {yesterdayUnreadTransmissions.length > 1 ? "s" : ""}
              </strong>
              <span>à lire</span>
            </div>

            <section
              className="yesterday-transmission-list"
              aria-label="Nouvelles transmissions de la veille"
            >
              {yesterdayUnreadTransmissions.map((transmission) => (
                <article
                  className={`transmission-item transmission-center-item priority-${transmission.priority.toLowerCase()} is-unread`}
                  key={transmission.id}
                >
                  <div className="transmission-patient-heading">
                    <span className="alert-symbol small-alert" aria-hidden="true">!</span>
                    <div>
                      <strong>{transmission.patientName}</strong>
                      <small>
                        Tournée du {transmission.tournee} · {transmission.category}
                      </small>
                    </div>
                  </div>
                  <div className="transmission-meta">
                    <strong>{transmission.author}</strong>
                    <span>{transmission.priority}</span>
                    <time>{formatTransmissionDate(transmission.dateTime)}</time>
                  </div>
                  <p>{transmission.message}</p>
                  <button
                    type="button"
                    onClick={() => void markAsRead(transmission)}
                  >
                    Marquer comme lue
                  </button>
                </article>
              ))}
            </section>

            {transmissionError && (
              <p className="transmission-error center-error" role="alert">
                {transmissionError}
              </p>
            )}
            <button
              className="mark-all-transmissions-button"
              type="button"
              onClick={() => void markAllYesterdayAsRead()}
              disabled={isMarkingAllTransmissions}
            >
              {isMarkingAllTransmissions
                ? "Enregistrement…"
                : "Tout marquer comme lu"}
            </button>
          </>
        )}
      </main>
    );
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
          <p className="eyebrow">Manon & Aurore</p>
          <h1>Synchroniser la tournée</h1>
          <p>
            La feuille Google Drive partagée met automatiquement à jour les
            tournées, les fiches et les transmissions.
          </p>
        </section>

        <section className="google-sync-card" aria-labelledby="google-sync-title">
          <div className="sync-card-heading">
            <span
              className={`sync-status-dot sync-${googleSyncStatus}`}
              aria-hidden="true"
            />
            <div>
              <p className="eyebrow">Google Sheets</p>
              <h2 id="google-sync-title">
                {googleSyncStatus === "synced"
                  ? "Tournée synchronisée"
                  : googleSyncStatus === "unconfigured"
                    ? "Configuration en préparation"
                    : "Connecter la feuille partagée"}
              </h2>
            </div>
          </div>

          <p className="sync-description">
            Choisissez votre prénom sur cet iPhone. Ce choix est mémorisé pour
            identifier les transmissions et les lectures.
          </p>
          <div className="nurse-selector" role="group" aria-label="Choisir l’infirmière">
            {(["Manon", "Aurore"] as NurseName[]).map((name) => (
              <button
                key={name}
                type="button"
                className={nurseName === name ? "is-selected" : ""}
                onClick={() => setNurseName(name)}
              >
                {name}
              </button>
            ))}
          </div>

          {googleSyncMessage && !googleSyncError && (
            <div className="sync-note sync-note-success" role="status">
              <strong>{googleSyncMessage}</strong>
              {lastSyncAt && (
                <span>
                  Dernière mise à jour à {lastSyncAt.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
            </div>
          )}
          {googleSyncError && (
            <div className="sync-note sync-note-error" role="alert">
              {googleSyncError}
            </div>
          )}

          <button
            className="google-connect-button"
            type="button"
            onClick={googleSyncStatus === "synced" ? () => void syncFromGoogle() : () => void connectGoogle()}
            disabled={googleSyncStatus === "connecting" || googleSyncStatus === "syncing"}
          >
            {googleSyncStatus === "connecting"
              ? "Connexion Google…"
              : googleSyncStatus === "syncing"
                ? "Synchronisation…"
                : googleSyncStatus === "synced"
                  ? "Actualiser maintenant"
                  : "Se connecter avec Google"}
          </button>
          {googleConfig?.spreadsheetName && (
            <small className="sheet-name">{googleConfig.spreadsheetName}</small>
          )}
        </section>

        <div className="manual-divider"><span>Secours hors connexion</span></div>

        <section className="import-card" aria-labelledby="import-title">
          <div className="file-mark" aria-hidden="true">
            CSV
            <span>+</span>
            XLSX
          </div>
          <h2 id="import-title">Importer manuellement</h2>
          <p>Utilisez un fichier seulement si Google Drive est indisponible.</p>
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

                <section className="patient-transmissions" aria-labelledby="transmissions-title">
                  <div className="transmissions-heading">
                    <div>
                      <span>Partagé Manon / Aurore</span>
                      <h2 id="transmissions-title">Transmissions</h2>
                    </div>
                    {unreadTransmissionCount > 0 && (
                      <strong>{unreadTransmissionCount} non lue{unreadTransmissionCount > 1 ? "s" : ""}</strong>
                    )}
                  </div>

                  {!googleAccessToken ? (
                    <button
                      className="transmission-connect"
                      type="button"
                      onClick={() => setScreen("import")}
                    >
                      Connecter Google Drive pour voir et ajouter les transmissions
                    </button>
                  ) : (
                    <>
                      {activePatientTransmissions.length === 0 ? (
                        <p className="no-transmission">Aucune transmission active.</p>
                      ) : (
                        <div className="transmission-list">
                          {activePatientTransmissions.map((transmission) => {
                            const isUnread =
                              nurseName === "Manon"
                                ? !transmission.readByManon
                                : nurseName === "Aurore"
                                  ? !transmission.readByAurore
                                  : false;
                            return (
                              <article
                                className={`transmission-item priority-${transmission.priority.toLowerCase()}${isUnread ? " is-unread" : ""}`}
                                key={transmission.id}
                              >
                                <div className="transmission-meta">
                                  <strong>{transmission.author}</strong>
                                  <span>{transmission.priority}</span>
                                  <time>{formatTransmissionDate(transmission.dateTime)}</time>
                                </div>
                                <p>{transmission.message}</p>
                                {isUnread && (
                                  <button type="button" onClick={() => void markAsRead(transmission)}>
                                    Marquer comme lue
                                  </button>
                                )}
                              </article>
                            );
                          })}
                        </div>
                      )}

                      <div className="transmission-form">
                        <label>
                          Nouvelle transmission
                          <textarea
                            value={transmissionMessage}
                            onChange={(event) => setTransmissionMessage(event.target.value)}
                            placeholder="Information à transmettre à la collègue…"
                            rows={3}
                          />
                        </label>
                        <div className="transmission-options">
                          <label>
                            Catégorie
                            <select
                              value={transmissionCategory}
                              onChange={(event) => setTransmissionCategory(event.target.value)}
                            >
                              <option>Soin</option>
                              <option>Traitement</option>
                              <option>Accès</option>
                              <option>Rendez-vous</option>
                              <option>Matériel</option>
                              <option>Autre</option>
                            </select>
                          </label>
                          <label>
                            Priorité
                            <select
                              value={transmissionPriority}
                              onChange={(event) =>
                                setTransmissionPriority(event.target.value as TransmissionPriority)
                              }
                            >
                              <option>Normale</option>
                              <option>Importante</option>
                              <option>Urgente</option>
                            </select>
                          </label>
                        </div>
                        <label className="update-file-toggle">
                          <input
                            type="checkbox"
                            checked={transmissionUpdatesFile}
                            onChange={(event) => setTransmissionUpdatesFile(event.target.checked)}
                          />
                          <span>
                            <strong>Mettre aussi à jour la fiche</strong>
                            <small>La collègue verra la nouvelle consigne dans la tournée.</small>
                          </span>
                        </label>
                        {transmissionUpdatesFile && (
                          <div className="file-update-fields">
                            <label>
                              Information à remplacer
                              <select
                                value={transmissionTargetField}
                                onChange={(event) => setTransmissionTargetField(event.target.value)}
                              >
                                <option value="soin">Soin de cette tournée</option>
                                <option value="notes_permanentes">Notes permanentes</option>
                                <option value="adresse">Adresse</option>
                              </select>
                            </label>
                            <label>
                              Nouvelle valeur complète
                              <textarea
                                value={transmissionNewValue}
                                onChange={(event) => setTransmissionNewValue(event.target.value)}
                                placeholder="Si vide, le texte de la transmission sera utilisé."
                                rows={3}
                              />
                            </label>
                          </div>
                        )}
                        {transmissionError && (
                          <p className="transmission-error" role="alert">{transmissionError}</p>
                        )}
                        <button
                          className="send-transmission-button"
                          type="button"
                          onClick={() => void saveTransmission()}
                          disabled={isSavingTransmission}
                        >
                          {isSavingTransmission ? "Enregistrement…" : `Envoyer comme ${nurseName ?? "infirmière"}`}
                        </button>
                      </div>
                    </>
                  )}
                </section>
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
                  const patientUnreadCount =
                    unreadCountByPatientId.get(patient.id) ?? 0;
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
                        <span className="patient-list-aside">
                          {patientUnreadCount > 0 && (
                            <span
                              className="patient-list-alert"
                              aria-label={`${patientUnreadCount} nouvelle${patientUnreadCount > 1 ? "s" : ""} transmission${patientUnreadCount > 1 ? "s" : ""}`}
                            >
                              <span aria-hidden="true">!</span>
                              {patientUnreadCount}
                            </span>
                          )}
                          <span className="patient-status">{status}</span>
                        </span>
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
          <span aria-hidden="true">↻</span> Synchroniser
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
          <span aria-hidden="true">●</span>{" "}
          {googleSyncStatus === "synced"
            ? `Drive connecté · ${nurseName ?? ""}`
            : "Mode local"}
        </div>
      </section>

      <button
        className={`home-sync-banner sync-banner-${googleSyncStatus}`}
        type="button"
        onClick={() => setScreen("import")}
      >
        <span className={`sync-status-dot sync-${googleSyncStatus}`} aria-hidden="true" />
        <span>
          <strong>
            {googleSyncStatus === "synced"
              ? "Google Drive synchronisé"
              : googleSyncStatus === "unconfigured"
                ? "Connexion Google en préparation"
                : "Connecter la tournée partagée"}
          </strong>
          <small>
            {lastSyncAt
              ? `Mis à jour à ${lastSyncAt.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`
              : "Touchez pour ouvrir les réglages"}
          </small>
        </span>
        <span aria-hidden="true">›</span>
      </button>

      {importMessage && (
        <div className="home-feedback" role="status">
          <span aria-hidden="true">✓</span>
          {importMessage}
        </div>
      )}

      <section
        className={`home-transmissions${yesterdayUnreadTransmissions.length > 0 ? " has-alerts" : ""}`}
        aria-labelledby="home-transmissions-title"
      >
        <div className="home-transmissions-heading">
          <div className="home-transmissions-title">
            <span
              className={`alert-symbol${yesterdayUnreadTransmissions.length === 0 ? " alert-symbol-clear" : ""}`}
              aria-hidden="true"
            >
              {yesterdayUnreadTransmissions.length > 0 ? "!" : "✓"}
            </span>
            <div>
              <p className="eyebrow">Relève · {yesterdayLabel}</p>
              <h2 id="home-transmissions-title">Nouvelles transmissions</h2>
            </div>
          </div>
          {googleAccessToken && yesterdayUnreadTransmissions.length > 0 && (
            <span className="home-transmissions-count">
              {yesterdayUnreadTransmissions.length}
            </span>
          )}
        </div>

        {!googleAccessToken ? (
          <button
            className="home-transmissions-connect"
            type="button"
            onClick={() => setScreen("import")}
          >
            <span>Connectez Google Drive pour afficher la relève</span>
            <span aria-hidden="true">›</span>
          </button>
        ) : yesterdayUnreadTransmissions.length === 0 ? (
          <p className="home-transmissions-empty">
            Aucune nouvelle transmission de la veille.
          </p>
        ) : (
          <div className="home-transmissions-list">
            {yesterdayUnreadTransmissions.slice(0, 3).map((transmission) => (
              <button
                type="button"
                key={transmission.id}
                onClick={() => setScreen("transmissions")}
                aria-label={`Voir les transmissions de la veille pour ${transmission.patientName}`}
              >
                <span className="small-alert" aria-hidden="true">!</span>
                <span>
                  <strong>{transmission.patientName}</strong>
                  <small>{transmission.message}</small>
                </span>
                <span aria-hidden="true">›</span>
              </button>
            ))}
            <button
              className="view-all-transmissions"
              type="button"
              onClick={() => setScreen("transmissions")}
            >
              Voir toutes les transmissions de la veille
              <span aria-hidden="true">→</span>
            </button>
          </div>
        )}
      </section>

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
