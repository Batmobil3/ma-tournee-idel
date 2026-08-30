export type TourneeId = "matin" | "soir";

export type Patient = {
  id: string;
  nom: string;
  adresse: string;
  soin: string;
  duree: number;
  notes: string;
  kilometres: number;
};

export type Tournees = Record<TourneeId, Patient[]>;

export const TOURNEE_CONFIG: Record<
  TourneeId,
  { label: string; start: string; eyebrow: string }
> = {
  matin: { label: "Matin", start: "07:00", eyebrow: "Bonne tournée" },
  soir: { label: "Soir", start: "17:00", eyebrow: "Fin de journée" },
};

export const DEMO_TOURNEES: Tournees = {
  matin: [
    {
      id: "demo-m-1",
      nom: "Camille Martin",
      adresse: "12 rue des Tilleuls, 44000 Nantes",
      soin: "Pansement simple",
      duree: 20,
      notes: "Données fictives — sonner à l’interphone Démo.",
      kilometres: 3.2,
    },
    {
      id: "demo-m-2",
      nom: "Noah Bernard",
      adresse: "8 avenue des Glycines, 44000 Nantes",
      soin: "Injection sous-cutanée",
      duree: 15,
      notes: "Données fictives — passage avant 8 h 30.",
      kilometres: 2.4,
    },
    {
      id: "demo-m-3",
      nom: "Louise Robert",
      adresse: "24 passage des Alouettes, 44000 Nantes",
      soin: "Prise de sang",
      duree: 15,
      notes: "Données fictives — à jeun.",
      kilometres: 4.1,
    },
    {
      id: "demo-m-4",
      nom: "Arthur Petit",
      adresse: "3 impasse des Mimosas, 44000 Nantes",
      soin: "Surveillance glycémie",
      duree: 20,
      notes: "Données fictives — matériel dans l’entrée.",
      kilometres: 2.8,
    },
  ],
  soir: [
    {
      id: "demo-s-1",
      nom: "Jade Moreau",
      adresse: "17 rue des Coquelicots, 44000 Nantes",
      soin: "Injection anticoagulant",
      duree: 15,
      notes: "Données fictives — appeler en arrivant.",
      kilometres: 3.6,
    },
    {
      id: "demo-s-2",
      nom: "Gabriel Laurent",
      adresse: "5 allée des Lavandes, 44000 Nantes",
      soin: "Préparation pilulier",
      duree: 25,
      notes: "Données fictives — vérifier l’ordonnance.",
      kilometres: 2.1,
    },
    {
      id: "demo-s-3",
      nom: "Anna Simon",
      adresse: "31 boulevard des Érables, 44000 Nantes",
      soin: "Pansement complexe",
      duree: 30,
      notes: "Données fictives — accès par le portail bleu.",
      kilometres: 4.7,
    },
  ],
};

export function appleMapsUrl(address: string) {
  return `https://maps.apple.com/?daddr=${encodeURIComponent(address)}&dirflg=d`;
}

export function roundKilometres(value: number) {
  return Math.round(value * 10) / 10;
}

export function getTourneeSummary(patients: Patient[], start: string) {
  const kilometres = roundKilometres(
    patients.reduce((total, patient) => total + patient.kilometres, 0),
  );
  const soinsMinutes = patients.reduce(
    (total, patient) => total + patient.duree,
    0,
  );
  // Estimation simple et explicable : 30 km/h en moyenne sur la tournée.
  const trajetMinutes = Math.round(kilometres * 2);
  const totalMinutes = soinsMinutes + trajetMinutes;
  const [hours, minutes] = start.split(":").map(Number);
  const endMinutes = hours * 60 + minutes + totalMinutes;
  const endHour = Math.floor(endMinutes / 60) % 24;
  const endMinute = endMinutes % 60;

  return {
    patients: patients.length,
    kilometres,
    totalMinutes,
    end: `${String(endHour).padStart(2, "0")}:${String(endMinute).padStart(2, "0")}`,
  };
}
