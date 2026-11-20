# AcoDyslex V0.3.1 — enregistrement local et analyse groupée

## Parcours

La séance enfant enregistre les 15 mots avant tout appel réseau d'analyse. Chaque WAV est finalisé en mono 16 kHz PCM 16 bits, contrôlé localement, puis stocké dans IndexedDB sous la clé composée `child_id + session_id + word_id`. `localStorage` ne contient que l'état léger de l'interface.

La limite par mot vaut 10 secondes par défaut. Elle se configure avec `ACODYSLEX_WORD_MAX_SECONDS` entre 1 et 20 secondes. Une pause suspend le contexte audio, exclut les nouveaux échantillons et arrête le temps actif.

Après le quinzième mot, le récapitulatif permet la réécoute et le remplacement d'un seul WAV. Le bouton **Analyser les lectures** reste désactivé tant que les 15 fichiers exploitables et le consentement explicite ne sont pas présents.

Les audios IndexedDB sont supprimés après un lot entièrement traité. Ils sont conservés après un échec ou un résultat partiel afin de permettre une reprise. Un nettoyage local supprime aussi les lots âgés de plus de sept jours. IndexedDB reste un stockage de reprise temporaire.

## API FastAPI

### `POST /v1/reading/analyze-batch`

Corps `multipart/form-data` :

- `manifest_json` : objet JSON contenant `analysis_id`, `child_id`, `session_id` et exactement 15 mots ordonnés ;
- `transfer_consent=true` ;
- 15 parties `files`, dans l'ordre du manifeste.

Extrait du manifeste :

```json
{
  "analysis_id": "batch_123",
  "child_id": "child_123",
  "session_id": "session_123",
  "words": [{"word_id": "word_01", "word_order": 1, "reference_text": "مَدْرَسَة", "expected_phonemes": ["m", "a"]}]
}
```

La route vérifie le consentement, les identifiants, l'appartenance de la session, l'ordre, les doublons, le texte de référence, le nombre de fichiers, le format WAV, la taille, la durée et le signal. Les noms de fichiers ne servent jamais à établir une association.

La réponse Pydantic contient `analysis_id`, `session_id`, `batch_status`, quinze `word_results`, `global_summary`, `model_versions` et `processing_metadata`. La synthèse sépare `candidate_error_count`, le nombre d'occurrences candidates, de `words_with_candidates`, le nombre de mots concernés. Les résultats restent des hypothèses automatisées jusqu'à la confirmation humaine et ne constituent pas un diagnostic.

### `GET /v1/reading/analyze-batch/{analysis_id}`

Cette route récupère le résultat persistant d'un lot. Un nouvel envoi avec le même `analysis_id` et les mêmes données retourne le résultat existant sans nouvelle invocation Modal. Un contenu différent avec le même identifiant est refusé. La route individuelle V0.3 `/api/recordings/{record_id}/analyze` reste disponible.

## Traitement Modal

FastAPI effectue exactement une requête vers `${ACODYSLEX_MODAL_BASE_URL}/v1/reading/analyze-batch`, avec le manifeste et les 15 WAV. Il n'existe aucune boucle de 15 appels HTTP masquée dans FastAPI.

Le service Modal déployé doit fournir cette route et traiter les 15 éléments dans une seule invocation, en chargeant le modèle une seule fois. Le contrat accepte une inférence séquentielle au sein de cette invocation lorsque le modèle ne permet pas un lot tensoriel. Le champ `processing_metadata.inference_mode` documente ce choix. Le code source du service Modal ne figure pas dans ce dépôt ; sa mise à jour selon ce contrat est requise avant un essai distant réel.

Le délai FastAPI est borné à 300 secondes. Les erreurs conservent les WAV locaux et placent la session dans `batch_failed`. Les résultats partiels conservent les quinze statuts et placent la session dans `partial_results`.

## Validation manuelle avec 15 audios de démonstration

1. Définir `ACODYSLEX_API_KEY`, `ACODYSLEX_MODAL_BASE_URL` et, si nécessaire, `ACODYSLEX_WORD_MAX_SECONDS=10`.
2. Lancer `uvicorn app:app --reload` depuis le dossier du projet.
3. Ouvrir `http://127.0.0.1:8000` dans Chromium.
4. Créer un profil pseudonyme et importer ou enregistrer quinze WAV de démonstration.
5. Vérifier dans l'onglet Réseau qu'aucun appel Modal n'a lieu pendant les enregistrements.
6. Réécouter un mot, le recommencer, puis confirmer que le récapitulatif contient toujours quinze éléments uniques.
7. Cocher le consentement et cliquer une fois sur **Analyser les lectures**.
8. Vérifier une seule requête navigateur vers `/v1/reading/analyze-batch` et une seule invocation du endpoint batch Modal dans les journaux techniques, sans contenu audio ni transcription dans les journaux.
9. Contrôler le bilan individuel, la synthèse, la correction ou le rejet humain des candidats, puis les trois exercices.

Utiliser uniquement des audios synthétiques ou de démonstration tant qu'un contrôle d'accès et une politique de conservation adaptés aux données d'enfants ne sont pas déployés.
