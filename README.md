# Ma Tournée IDEL

PWA mobile pour suivre simplement deux tournées infirmières, le matin et le soir. L’application importe les patients depuis un fichier CSV/XLSX, affiche le nombre de passages, les kilomètres et l’heure de fin estimée, puis accompagne l’IDEL patient après patient.

Toutes les données fournies dans ce dépôt sont fictives. L’application peut fonctionner localement ou se connecter, avec l’accord de l’utilisatrice, à un Google Sheet privé partagé entre Manon et Aurore. Les identifiants Google restent gérés par Google : aucun mot de passe n’est demandé ni conservé par l’application.

## Fonctions principales

- tournées du matin et du soir ;
- import CSV, XLSX ou XLS ;
- synthèse patients, kilomètres et fin estimée ;
- fiche patient avec adresse, soin, durée et notes ;
- chronomètre « Commencer le soin » / « Soin terminé » ;
- apprentissage local de la durée moyenne sur les 5 derniers passages ;
- ouverture d’Apple Plans, compatible avec l’affichage CarPlay ;
- passage immédiat au patient suivant après « Soin terminé » ;
- bouton « Patient non vu » pour reporter un passage à la fin de la tournée ;
- liste complète accessible pendant la tournée pour choisir un patient hors ordre ;
- reprise automatique de la chronologie initiale après un passage choisi manuellement ;
- installation sur l’écran d’accueil de l’iPhone et fonctionnement hors ligne ;
- interface responsive avec de grandes zones tactiles.
- synchronisation des tournées et fiches depuis un Google Sheet partagé ;
- transmissions par patient avec auteur, priorité et statut lu/non lu ;
- mise à jour immédiate d’un soin, d’une note ou d’une adresse dans la feuille partagée ;
- actualisation automatique chaque minute et au retour dans l’application ;
- import manuel conservé comme solution de secours hors connexion.

## Synchronisation Google Sheets

La configuration publique non secrète se trouve dans `public/google-config.json` :

- `clientId` : identifiant OAuth Web Google autorisé pour `https://batmobil3.github.io` ;
- `spreadsheetId` : identifiant du Google Sheet privé partagé ;
- `spreadsheetName` : libellé affiché dans l’application.

Le projet Google Cloud doit activer **Google Sheets API** et demander uniquement le droit d’accès aux feuilles Google. Manon et Aurore doivent toutes les deux avoir accès au classeur dans Drive. À l’ouverture de leur PWA, elles choisissent leur prénom puis se connectent à Google ; la tournée est ensuite actualisée automatiquement, sans réimport de fichier.

Le dépôt et le site GitHub Pages étant publics, ne jamais publier le classeur Google ni y placer de véritables données de santé sans avoir vérifié les obligations de confidentialité, d’hébergement et de sécurité applicables.

## Format d’import

La première feuille est utilisée. Les colonnes attendues sont :

| Colonne | Requise | Exemple |
| --- | --- | --- |
| `tournee` | non | `matin` ou `soir` |
| `nom` | oui | `Emma Dubois` |
| `adresse` | oui | `10 rue des Fleurs 44000 Nantes` |
| `soin` | non | `Pansement` |
| `duree` | non | `20` (minutes) |
| `notes` | non | `Appeler en arrivant` |
| `kilometres` | non | `3,2` |

Sans tournée, la ligne est ajoutée au matin. Sans durée, 15 minutes sont utilisées comme estimation initiale. Après chaque soin chronométré, l’application recalcule localement la moyenne des 5 derniers passages pour affiner l’heure de fin. Un fichier fictif est disponible dans `public/exemple-patients.csv`.

## Développement

Prérequis : Node.js 22 et pnpm.

```bash
pnpm install
pnpm dev
```

Vérifier les deux cibles :

```bash
pnpm build
pnpm build:pages
```

## GitHub Pages

Le workflow `.github/workflows/deploy-pages.yml` compile et publie automatiquement `dist-pages` à chaque push sur `main`.

Dans GitHub, ouvrez **Settings → Pages**, puis choisissez **GitHub Actions** comme source. Le site sera disponible à l’adresse `https://batmobil3.github.io/ma-tournee-idel/` après le prochain déploiement.

## Installation sur iPhone

1. Ouvrir l’URL GitHub Pages dans Safari.
2. Toucher **Partager**.
3. Choisir **Sur l’écran d’accueil** puis **Ajouter**.

Pour CarPlay, le bouton **Naviguer** ouvre une destination dans Apple Plans. Si l’iPhone est connecté à CarPlay, le guidage apparaît dans Plans sur l’écran du véhicule.
