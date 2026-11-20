# AcoDyslex V0.2 — suivi longitudinal

L'API V0.2 enregistre les séances, les recommandations présentées, les exercices réellement effectués et une estimation pédagogique évolutive par compétence. Ces estimations sont des signaux d'ingénierie provisoires. Elles ne constituent ni une mesure clinique validée, ni un diagnostic.

## Endpoints

| Méthode | Route | Rôle |
| --- | --- | --- |
| `POST` | `/v1/progress/sessions` | Créer une séance et, si nécessaire, le profil pseudonymisé |
| `POST` | `/v1/progress/sessions/{session_id}/attempts` | Enregistrer une tentative idempotente |
| `POST` | `/v1/progress/sessions/{session_id}/complete` | Clôturer la séance et recalculer les estimations |
| `GET` | `/v1/progress/children/{child_id}` | Lire le profil actuel |
| `GET` | `/v1/progress/children/{child_id}/history` | Lire l'historique paginé |
| `GET` | `/v1/progress/children/{child_id}/recommendations` | Obtenir l'adaptation explicable V0.2 |

Les schémas, contraintes et exemples sont disponibles dans Swagger à `http://127.0.0.1:8000/docs`.

## Exemple Swagger complet : deux séances fictives

Les reçus sont valables 15 minutes et à usage unique. Un reçu utilisé pour créer une séance ne peut pas ensuite servir à `/v1/recommendations/preview`, et inversement.

### 1. Vérifier humainement l'observation de la première séance

`POST /v1/recommendations/observations/verify`

```json
{
  "error_type": "omission",
  "target": "item-fictif-a/item-fictif-b",
  "observed": "réponse-fictive",
  "count": 2,
  "opportunities": 3,
  "distinct_items": 2,
  "meaning_changed": false,
  "provenance": "swagger_demo",
  "language_variety": "ar-MA",
  "dialect_context": "contexte fictif",
  "reviewer_id": "teacher_demo",
  "human_confirmed": true
}
```

Copier l'objet retourné, y compris `verification_receipt`, dans `observations` à l'étape suivante.

### 2. Créer la première séance

`POST /v1/progress/sessions`

```json
{
  "session_id": "session_demo_01",
  "child_id": "child_demo_01",
  "started_at": "2026-11-08T09:00:00Z",
  "recommendation_engine_version": "0.2.0",
  "pedagogical_settings": {
    "initial_mastery": 0.5,
    "learning_rate": 0.25,
    "mastery_threshold": 0.8,
    "review_threshold": 0.55,
    "max_recent_repetitions": 2,
    "retention_days": 365
  },
  "recommended_exercise_ids": ["OMI01", "OMI02"],
  "observations": [
    {
      "error_type": "omission",
      "target": "item-fictif-a/item-fictif-b",
      "observed": "réponse-fictive",
      "count": 2,
      "opportunities": 3,
      "distinct_items": 2,
      "meaning_changed": false,
      "provenance": "swagger_demo",
      "language_variety": "ar-MA",
      "dialect_context": "contexte fictif",
      "verification_status": "human_verified",
      "verification_provenance": "human_review",
      "verified_by": "teacher_demo",
      "verification_receipt": "COLLER_LE_RECU_RETOURNE"
    }
  ]
}
```

### 3. Enregistrer puis clôturer la première séance

`POST /v1/progress/sessions/session_demo_01/attempts`

```json
{
  "attempt_id": "attempt_demo_01",
  "child_id": "child_demo_01",
  "exercise_id": "OMI01",
  "skill": "phoneme_detection",
  "correct_count": 3,
  "total_count": 5,
  "assistance_level": "moderate",
  "evaluation_context": "practice",
  "item_set_id": "set_demo_a",
  "novel_items": false,
  "completed_at": "2026-11-08T09:20:00Z"
}
```

`POST /v1/progress/sessions/session_demo_01/complete`

```json
{
  "child_id": "child_demo_01",
  "completed_at": "2026-11-08T09:30:00Z"
}
```

### 4. Créer et clôturer la deuxième séance

Créer un nouveau reçu avec `/v1/recommendations/observations/verify`, puis créer `session_demo_02` avec ce nouveau reçu et une date ultérieure. Enregistrer une tentative distincte :

`POST /v1/progress/sessions/session_demo_02/attempts`

```json
{
  "attempt_id": "attempt_demo_02",
  "child_id": "child_demo_01",
  "exercise_id": "OMI01",
  "skill": "phoneme_detection",
  "correct_count": 5,
  "total_count": 5,
  "assistance_level": "independent",
  "evaluation_context": "transfer",
  "item_set_id": "set_demo_b",
  "novel_items": true,
  "completed_at": "2026-11-15T09:20:00Z"
}
```

Clôturer avec `POST /v1/progress/sessions/session_demo_02/complete` et `completed_at: 2026-11-15T09:30:00Z`.

### 5. Examiner le résultat longitudinal

Appeler successivement :

- `GET /v1/progress/children/child_demo_01`
- `GET /v1/progress/children/child_demo_01/history?offset=0&limit=20`
- `GET /v1/progress/children/child_demo_01/recommendations`

La dernière réponse explique le choix des exercices, indique l'estimation par compétence et évite autant que possible les exercices récemment répétés ou associés à un signal provisoire de maîtrise.

## Persistance et migrations

Les tables V0.2 et les reçus partagent `recordings/.recommendation-reviews.sqlite3`. La consommation du reçu et la création d'une séance appartiennent ainsi à la même transaction. Les migrations sont versionnées dans `schema_migrations` et s'exécutent lors du premier appel V0.2. Les clés étrangères et transactions empêchent les tentatives orphelines ou rattachées au mauvais enfant. Les tentatives et événements de progression restent append-only; `skill_progress` est l'agrégat courant.

`ACODYSLEX_REVIEW_DB` permet de choisir le fichier SQLite partagé. `ACODYSLEX_REVIEW_SIGNING_KEY` reste recommandé pour un déploiement contrôlé.

## Limites restantes

Le prototype local ne possède toujours pas d'authentification ni de contrôle d'accès par rôle. `retention_until`, les suppressions en cascade du schéma et l'absence de données directement identifiantes préparent une politique de conservation, mais aucune suppression planifiée n'est exécutée automatiquement. Avant tout déploiement, il faut ajouter authentification, autorisation par profil, chiffrement au repos, sauvegardes contrôlées et procédure de suppression vérifiable.

Le moteur ne conserve pas les identités des items d'observation; il utilise donc le maximum de `distinct_items` observé, sans additionner aveuglément les séances. Les comparaisons scientifiques doivent s'appuyer sur `evaluation_context`, `item_set_id` et `novel_items`, avec un protocole validé séparément.

