import type { Patient, TourneeId, Tournees } from "./tournee-data";

export type NurseName = "Manon" | "Aurore";

export type GoogleSyncConfig = {
  clientId: string;
  spreadsheetId: string;
  spreadsheetName?: string;
};

export type TransmissionPriority = "Normale" | "Importante" | "Urgente";

export type Transmission = {
  id: string;
  sheetRow: number;
  dateTime: string;
  patientId: string;
  patientName: string;
  tournee: TourneeId | "autre";
  author: NurseName;
  category: string;
  priority: TransmissionPriority;
  message: string;
  updateFile: boolean;
  targetField: string;
  newValue: string;
  readByManon: boolean;
  readByAurore: boolean;
  status: string;
};

export type SheetRowReferences = {
  ficheRowByPatientId: Record<string, number>;
  importRowsByPatientId: Record<string, Array<{ row: number; route: TourneeId }>>;
};

export type SharedSheetSnapshot = {
  tournees: Tournees;
  transmissions: Transmission[];
  rowReferences: SheetRowReferences;
};

type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type GoogleTokenClient = {
  requestAccessToken: (options?: { prompt?: string }) => void;
};

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (options: {
            client_id: string;
            scope: string;
            callback: (response: GoogleTokenResponse) => void;
            error_callback?: (error: unknown) => void;
          }) => GoogleTokenClient;
        };
      };
    };
  }
}

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const GOOGLE_IDENTITY_SCRIPT = "https://accounts.google.com/gsi/client";

function normalizeHeader(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function parseNumber(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function valueFromRow(row: unknown[], headers: unknown[], aliases: string[]) {
  const wanted = new Set(aliases.map(normalizeHeader));
  const index = headers.findIndex((header) => wanted.has(normalizeHeader(header)));
  if (index < 0) return "";
  return row[index] ?? "";
}

function toBoolean(value: unknown) {
  return /^(oui|yes|true|1)$/i.test(String(value ?? "").trim());
}

function toRoute(value: unknown): TourneeId | "autre" {
  const normalized = String(value ?? "").toLowerCase();
  if (/soir|evening|pm/.test(normalized)) return "soir";
  if (/matin|morning|am/.test(normalized)) return "matin";
  return "autre";
}

function normalizePriority(value: unknown): TransmissionPriority {
  const priority = String(value ?? "Normale");
  if (priority === "Urgente" || priority === "Importante") return priority;
  return "Normale";
}

function rangeUrl(spreadsheetId: string, range: string) {
  return `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
}

async function googleRequest<T>(
  accessToken: string,
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    const message =
      detail?.error?.message ??
      (response.status === 401
        ? "La connexion Google a expiré. Reconnectez-vous."
        : `Google Sheets a répondu avec l’erreur ${response.status}.`);
    throw new Error(message);
  }

  return (await response.json()) as T;
}

export async function loadGoogleSyncConfig(): Promise<GoogleSyncConfig> {
  const url = new URL("google-config.json", document.baseURI);
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("La configuration Google n’est pas disponible.");
  const config = (await response.json()) as GoogleSyncConfig;
  return {
    clientId: String(config.clientId ?? "").trim(),
    spreadsheetId: String(config.spreadsheetId ?? "").trim(),
    spreadsheetName: String(config.spreadsheetName ?? "Ma Tournée IDEL"),
  };
}

export function isGoogleSyncConfigured(config: GoogleSyncConfig | null) {
  return Boolean(
    config?.clientId &&
      !config.clientId.startsWith("À_CONFIGURER") &&
      config?.spreadsheetId &&
      !config.spreadsheetId.startsWith("À_CONFIGURER"),
  );
}

export async function loadGoogleIdentity() {
  if (window.google?.accounts.oauth2) return;

  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${GOOGLE_IDENTITY_SCRIPT}"]`,
    );
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("La connexion Google n’a pas pu être chargée.")),
        { once: true },
      );
      return;
    }

    const script = document.createElement("script");
    script.src = GOOGLE_IDENTITY_SCRIPT;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error("La connexion Google n’a pas pu être chargée.")),
      { once: true },
    );
    document.head.appendChild(script);
  });
}

export async function requestGoogleAccessToken(clientId: string) {
  await loadGoogleIdentity();

  return new Promise<{ accessToken: string; expiresAt: number }>((resolve, reject) => {
    const oauth2 = window.google?.accounts.oauth2;
    if (!oauth2) {
      reject(new Error("Le service de connexion Google est indisponible."));
      return;
    }

    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: SHEETS_SCOPE,
      callback: (response) => {
        if (response.error || !response.access_token) {
          reject(
            new Error(
              response.error_description ??
                "La connexion Google a été annulée ou refusée.",
            ),
          );
          return;
        }
        resolve({
          accessToken: response.access_token,
          expiresAt: Date.now() + Math.max(60, response.expires_in ?? 3600) * 1000,
        });
      },
      error_callback: () => reject(new Error("La fenêtre Google a été fermée.")),
    });

    // Google affichera l'accord au premier accès, puis évitera de le redemander
    // inutilement aux connexions suivantes sur le même compte.
    client.requestAccessToken({ prompt: "" });
  });
}

export async function loadSharedSheet(
  accessToken: string,
  spreadsheetId: string,
): Promise<SharedSheetSnapshot> {
  const params = new URLSearchParams();
  params.append("ranges", "Import!A1:J300");
  params.append("ranges", "'Fiches Patients'!A4:I300");
  params.append("ranges", "Transmissions!A4:P1000");
  params.set("majorDimension", "ROWS");

  const data = await googleRequest<{
    valueRanges?: Array<{ range?: string; values?: unknown[][] }>;
  }>(
    accessToken,
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet?${params}`,
  );

  const importValues = data.valueRanges?.[0]?.values ?? [];
  const ficheValues = data.valueRanges?.[1]?.values ?? [];
  const transmissionValues = data.valueRanges?.[2]?.values ?? [];
  const importHeaders = importValues[0] ?? [];
  const ficheHeaders = ficheValues[0] ?? [];
  const transmissionHeaders = transmissionValues[0] ?? [];

  const ficheMap = new Map<
    string,
    { row: number; address: string; morningCare: string; eveningCare: string; notes: string; active: boolean }
  >();
  const ficheRowByPatientId: Record<string, number> = {};
  ficheValues.slice(1).forEach((row, index) => {
    const patientId = String(valueFromRow(row, ficheHeaders, ["patientid"])).trim();
    if (!patientId) return;
    const sheetRow = index + 5;
    ficheRowByPatientId[patientId] = sheetRow;
    ficheMap.set(patientId, {
      row: sheetRow,
      address: String(valueFromRow(row, ficheHeaders, ["adresse"]) ?? "").trim(),
      morningCare: String(valueFromRow(row, ficheHeaders, ["soinmatin"]) ?? "").trim(),
      eveningCare: String(valueFromRow(row, ficheHeaders, ["soinsoir"]) ?? "").trim(),
      notes: String(valueFromRow(row, ficheHeaders, ["notespermanentes", "notes"]) ?? "").trim(),
      active: !/^(non|no|false|0)$/i.test(
        String(valueFromRow(row, ficheHeaders, ["actif"]) ?? "Oui").trim(),
      ),
    });
  });

  const tournees: Tournees = { matin: [], soir: [] };
  const importRowsByPatientId: SheetRowReferences["importRowsByPatientId"] = {};
  importValues.slice(1).forEach((row, index) => {
    const patientId = String(
      valueFromRow(row, importHeaders, ["patientid"]) || `PAT-LIGNE-${index + 2}`,
    ).trim();
    const routeValue = toRoute(valueFromRow(row, importHeaders, ["tournee"]));
    if (routeValue === "autre") return;

    const fiche = ficheMap.get(patientId);
    if (fiche && !fiche.active) return;
    const nom = String(valueFromRow(row, importHeaders, ["nom", "patient"])).trim();
    const address = fiche?.address || String(valueFromRow(row, importHeaders, ["adresse"])).trim();
    if (!nom || !address) return;
    const routeCare = routeValue === "matin" ? fiche?.morningCare : fiche?.eveningCare;
    const patient: Patient = {
      id: patientId,
      nom,
      adresse: address,
      soin:
        routeCare ||
        String(valueFromRow(row, importHeaders, ["soin", "acte"]) || "Soin à préciser").trim(),
      duree: Math.max(
        1,
        Math.round(parseNumber(valueFromRow(row, importHeaders, ["duree", "minutes"]), 15)),
      ),
      notes:
        fiche?.notes || String(valueFromRow(row, importHeaders, ["notes", "commentaires"])).trim(),
      kilometres: Math.max(
        0,
        parseNumber(valueFromRow(row, importHeaders, ["kilometres", "km"]), 0),
      ),
    };
    tournees[routeValue].push(patient);
    (importRowsByPatientId[patientId] ??= []).push({ row: index + 2, route: routeValue });
  });

  const transmissions: Transmission[] = transmissionValues
    .slice(1)
    .map((row, index) => ({
      id: String(valueFromRow(row, transmissionHeaders, ["transmissionid"]) ?? "").trim(),
      sheetRow: index + 5,
      dateTime: String(valueFromRow(row, transmissionHeaders, ["dateheure"]) ?? "").trim(),
      patientId: String(valueFromRow(row, transmissionHeaders, ["patientid"]) ?? "").trim(),
      patientName: String(valueFromRow(row, transmissionHeaders, ["patient"]) ?? "").trim(),
      tournee: toRoute(valueFromRow(row, transmissionHeaders, ["tournee"])),
      author: String(valueFromRow(row, transmissionHeaders, ["auteur"]) ?? "Manon") === "Aurore" ? "Aurore" : "Manon",
      category: String(valueFromRow(row, transmissionHeaders, ["categorie"]) ?? "Autre").trim(),
      priority: normalizePriority(valueFromRow(row, transmissionHeaders, ["priorite"])),
      message: String(valueFromRow(row, transmissionHeaders, ["transmission"]) ?? "").trim(),
      updateFile: toBoolean(valueFromRow(row, transmissionHeaders, ["modifierfiche"])),
      targetField: String(valueFromRow(row, transmissionHeaders, ["champcible"]) ?? "").trim(),
      newValue: String(valueFromRow(row, transmissionHeaders, ["nouvellevaleur"]) ?? "").trim(),
      readByManon: toBoolean(valueFromRow(row, transmissionHeaders, ["lumanon"])),
      readByAurore: toBoolean(valueFromRow(row, transmissionHeaders, ["luaurore"])),
      status: String(valueFromRow(row, transmissionHeaders, ["statut"]) ?? "Active").trim(),
    }))
    .filter((transmission) => transmission.id && transmission.patientId && transmission.message);

  return {
    tournees,
    transmissions,
    rowReferences: { ficheRowByPatientId, importRowsByPatientId },
  };
}

export async function appendTransmission(
  accessToken: string,
  spreadsheetId: string,
  input: {
    patient: Patient;
    route: TourneeId;
    author: NurseName;
    category: string;
    priority: TransmissionPriority;
    message: string;
    updateFile: boolean;
    targetField: string;
    newValue: string;
  },
) {
  const now = new Date();
  const compactDate = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 12);
  const id = `TR-${compactDate}-${input.author.slice(0, 1).toUpperCase()}-${crypto.randomUUID().slice(0, 6)}`;
  const values = [[
    id,
    now.toISOString(),
    input.patient.id,
    input.patient.nom,
    input.route,
    input.author,
    input.category,
    input.priority,
    input.message,
    input.updateFile ? "Oui" : "Non",
    input.targetField,
    input.newValue,
    input.author === "Manon" ? "Oui" : "Non",
    input.author === "Aurore" ? "Oui" : "Non",
    "Active",
    "",
  ]];

  const params = new URLSearchParams({
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
  });
  await googleRequest(
    accessToken,
    `${rangeUrl(spreadsheetId, "Transmissions!A:P")}:append?${params}`,
    { method: "POST", body: JSON.stringify({ majorDimension: "ROWS", values }) },
  );
}

export async function markTransmissionRead(
  accessToken: string,
  spreadsheetId: string,
  sheetRow: number,
  nurse: NurseName,
) {
  const column = nurse === "Manon" ? "M" : "N";
  await googleRequest(
    accessToken,
    `${rangeUrl(spreadsheetId, `Transmissions!${column}${sheetRow}`)}?valueInputOption=RAW`,
    { method: "PUT", body: JSON.stringify({ values: [["Oui"]] }) },
  );
}

export async function updatePatientFile(
  accessToken: string,
  spreadsheetId: string,
  references: SheetRowReferences,
  patientId: string,
  route: TourneeId,
  targetField: string,
  newValue: string,
  author: NurseName,
) {
  const ficheRow = references.ficheRowByPatientId[patientId];
  if (!ficheRow) throw new Error("La fiche patient est introuvable dans Google Sheets.");

  const field = targetField === "soin" ? `soin_${route}` : targetField;
  const ficheColumn = {
    adresse: "C",
    soin_matin: "D",
    soin_soir: "E",
    notes_permanentes: "F",
  }[field];
  if (!ficheColumn) throw new Error("Choisissez la partie de la fiche à modifier.");

  const updates: Array<{ range: string; values: string[][] }> = [
    { range: `'Fiches Patients'!${ficheColumn}${ficheRow}`, values: [[newValue]] },
    { range: `'Fiches Patients'!H${ficheRow}:I${ficheRow}`, values: [[new Date().toISOString(), author]] },
  ];
  for (const reference of references.importRowsByPatientId[patientId] ?? []) {
    if (field.startsWith("soin_") && reference.route !== route) continue;
    const importColumn = field === "adresse" ? "C" : field.startsWith("soin_") ? "D" : "F";
    updates.push({ range: `Import!${importColumn}${reference.row}`, values: [[newValue]] });
    updates.push({ range: `Import!I${reference.row}:J${reference.row}`, values: [[new Date().toISOString(), author]] });
  }

  await googleRequest(
    accessToken,
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
    {
      method: "POST",
      body: JSON.stringify({ valueInputOption: "USER_ENTERED", data: updates }),
    },
  );
}
