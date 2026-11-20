# AcoDyslex V0.4 — lecture mixte

La séance conserve quinze unités de lecture. Le mode par défaut (`mixed`) prépare aléatoirement huit mots et sept phrases courtes arabes (deux ou trois mots). Les identifiants et les champs `reading_words` / `word_id` restent présents pour la compatibilité V0.3, mais chaque entrée peut désormais être une unité `word` ou `short_sentence`.

## Configuration

Les valeurs sont locales au serveur FastAPI :

| Variable | Valeur par défaut | Rôle |
| --- | --- | --- |
| `ACODYSLEX_READING_MODE` | `mixed` | `word_only`, `mixed` ou `adaptive` |
| `ACODYSLEX_WORD_MAX_SECONDS` | `10` | Limite par mot |
| `ACODYSLEX_SENTENCE_MAX_SECONDS` | `15` | Limite par phrase courte |

Le mode `adaptive` conserve le format 8 + 7 et priorise les unités de difficulté plus élevée. Les sessions déjà créées conservent leur plan et leur ordre; elles ne sont jamais re-planifiées.

La banque initiale est dans `static/reading_words.json`. Les phrases ont `word_count`, `difficulty_level`, `target_skills`, `language_variety` (`ar-MSA`) et `max_recording_seconds`. Toute phrase est validée à deux ou trois mots par les contrats FastAPI.

## Contrat d'analyse par lot

`POST /v1/reading/analyze-batch` reçoit toujours quinze WAV, dans l'ordre du plan de séance. Chaque élément de `manifest_json.words` accepte les champs suivants :

```json
{
  "word_id": "s01",
  "unit_id": "s01",
  "unit_type": "short_sentence",
  "word_order": 11,
  "reference_text": "هَذَا كِتَابٌ",
  "expected_phonemes": [],
  "word_count": 2,
  "max_recording_seconds": 15
}
```

Extrait de réponse pour une phrase :

```json
{
  "word_id": "s01",
  "unit_id": "s01",
  "unit_type": "short_sentence",
  "word_order": 11,
  "reference_text": "هَذَا كِتَابٌ",
  "analysis_status": "ok",
  "lexical_candidates": [{"text": "هذا كتاب", "confidence": 0.81}],
  "word_alignment": [{"reference": "هَذَا", "observed": "هذا"}],
  "acoustic_indicators": {"speech_rate": 1.0}
}
```

Le résumé ajoute `analyzed_word_units` et `analyzed_sentence_units`. Un lot partiel reste stocké avec son statut `partial_results`; il ne transforme pas une suggestion automatique en constat pédagogique vérifié.

La remédiation guidée `INV03` dispose de variantes de phrases distinctes (`unit_type: short_sentence`). Elles sont présentées séparément des exercices mot-à-mot et restent évaluées par l'accompagnant. Les recommandations longitudinales restent fondées uniquement sur les observations explicitement vérifiées et les tentatives enregistrées.

## Vérification locale

```powershell
python -m unittest tests.test_batch_analysis tests.test_app tests.test_v03_flow
npx playwright test tests/browser/session_flow.spec.cjs
```

Dans le navigateur, créez ou choisissez un profil, démarrez une séance et vérifiez : les quinze unités mélangent huit mots et sept phrases; le premier élément est visible avant le démarrage du micro; les suivants apparaissent 250 ms après le démarrage de leur capture; une phrase bénéficie de 15 secondes; le rapport reçoit les candidats lexicaux et l'alignement lorsque le service les fournit.

## Limites

Cette version ne télécharge ni ne met en cache les poids Modal. Le cache existant ne concerne que les métadonnées de configuration du modèle. La détection RMS/peak écarte les enregistrements trop faibles, mais ne peut pas prouver que la voix est physiquement la plus proche du microphone. Les sorties acoustiques et lexicales restent des suggestions à examiner par un accompagnant, pas un diagnostic.
