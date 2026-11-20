# AcoDyslex V0.3.2 — sept exercices interactifs

## Sélection

`GET /v1/progress/children/{child_id}/recommendations` retourne exactement sept exercices distincts pour le parcours V0.3.2. La sélection classe d'abord les activités liées aux observations humaines vérifiées, puis complète avec des consolidations. Elle tient compte de la maîtrise estimée, de l'assistance déjà nécessaire, des répétitions récentes, du niveau et des priorités structurelles. Les différences isolées de longueur vocalique restent moins prioritaires.

Les sept familles implémentées sont :

- `auditory_discrimination` ;
- `phoneme_grapheme_matching` ;
- `syllable_ordering` ;
- `missing_letter` ;
- `letter_ordering` ;
- `extra_phoneme_detection` ;
- `guided_reading`.

Une séance peut contenir plusieurs activités d'une même famille lorsque les observations et l'historique le justifient. Les sept familles ne sont donc pas imposées mécaniquement à chaque enfant.

## Contrat d'un exercice

Les exercices existants de `recommendation/exercises.json` gardent leurs identifiants. Le backend les enrichit avec :

```json
{
  "activity_family": "missing_letter",
  "activity_family_label_fr": "Lettre manquante",
  "objective_fr": "Retrouver le graphème absent dans un mot.",
  "instruction_ar": "اِخْتَرِ الْحَرْفَ النَّاقِصَ فِي الْكَلِمَةِ.",
  "example_ar": "كِتَا_ٌ ← ب",
  "interaction": {
    "kind": "choice",
    "options": ["ر", "د", "س"],
    "answer": "ر",
    "hint": "الْكَلِمَةُ هِيَ مَدْرَسَةٌ."
  },
  "audio": {
    "status": "not_required",
    "url": null,
    "message_fr": "Cette activité ne nécessite pas de fichier audio."
  }
}
```

Les réponses restent dans le contrat applicatif pour permettre la correction locale, mais elles ne sont pas affichées avant la tentative.

## Audio

Aucun fichier audio pédagogique validé n'est présent dans le dépôt. Les activités qui exigent un modèle sonore déclarent donc :

```json
{"status": "unavailable", "url": null}
```

L'interface n'affiche aucun faux bouton de réécoute. Elle indique l'indisponibilité et fournit un espace accompagnateur replié avec le modèle à prononcer en direct. La lecture guidée peut enregistrer une production locale ; sa réussite reste évaluée par l'accompagnateur et la sortie ASR n'est jamais utilisée comme vérité terrain.

## Tentatives et clôture

`POST /v1/progress/sessions/{session_id}/attempts` conserve le contrat V0.2 et accepte aussi :

- `activity_family` ;
- `interaction_attempts` ;
- `help_used` ;
- `outcome` : `independent_success`, `assisted_success` ou `not_yet_success`.

Pour une session ayant un parcours de sept exercices, le backend refuse :

- un exercice extérieur au parcours ;
- une seconde tentative finale pour le même exercice ;
- une clôture avant sept résultats distincts.

Le bouton d'abandon place la session dans l'état `abandoned`. Les résultats déjà enregistrés restent présents et les activités non réalisées ne créent aucune tentative ni aucun échec.

## Vérification manuelle

1. Lancer `uvicorn app:app --reload`.
2. Réaliser une analyse groupée et confirmer les observations du bilan.
3. Vérifier que l'écran annonce « Exercice 1 sur 7 » et n'affiche qu'une activité.
4. Donner une mauvaise réponse, contrôler la rétroaction, demander une aide, puis réessayer.
5. Recharger la page et vérifier la reprise sur l'exercice non terminé.
6. Contrôler l'absence de bouton « Réécouter » quand `audio.status` vaut `unavailable`.
7. Terminer les sept activités, puis clôturer la séance.
8. Tester l'abandon sur une autre séance et vérifier que seules les tentatives réellement terminées apparaissent dans l'historique.
