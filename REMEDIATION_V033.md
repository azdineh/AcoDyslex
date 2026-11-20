# AcoDyslex V0.3.3 — Interface de remédiation

Cette version modifie uniquement la présentation et l’interaction des sept activités. Les recommandations, les scores, les reçus de validation humaine, la persistance et les routes FastAPI restent inchangés.

## Parcours

- Une seule activité est affichée.
- La progression montre les sept étapes et distingue les activités terminées, courante et à venir.
- La carte sépare le titre, la consigne arabe, l’interaction de l’enfant, les actions et l’évaluation de l’accompagnateur.
- Le panneau accompagnateur apparaît après une réponse correcte ou après la lecture guidée.
- La correction automatique reste décisionnaire pour les réponses fermées. Le choix humain précise uniquement le niveau d’assistance.
- Le bouton de fin de séance reste masqué jusqu’à la septième activité enregistrée.

## Arabe et accessibilité

- Les zones arabes utilisent `dir="rtl"`, `lang="ar"` et une pile de polices adaptée : Noto Naskh Arabic, Traditional Arabic, Amiri et Tahoma.
- Les mots utilisent une taille responsive de 48 à 72 px et les consignes de 25 à 31 px.
- Les boutons natifs restent utilisables au clavier et les messages sont annoncés avec `aria-live`.
- Les cibles tactiles mesurent au moins 48 px.
- `prefers-reduced-motion` supprime les transitions et le défilement animé.

## Audio

- Le bouton d’écoute est créé uniquement quand `audio.status` vaut `available` et qu’une URL existe.
- Sans ressource audio, aucun faux bouton d’écoute n’est affiché.
- La lecture guidée conserve la capture locale, l’arrêt, la réécoute et la reprise.

## Captures

- `artifacts/v033/remediation-desktop-1440.png`
- `artifacts/v033/remediation-tablet-768.png`
- `artifacts/v033/remediation-mobile-375.png`

Les captures sont produites par le test Playwright responsive avec le renderer et les données réelles de l’application.
