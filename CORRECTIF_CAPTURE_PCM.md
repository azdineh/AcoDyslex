# AcoDyslex v0.3.2 — Correction de la capture WAV silencieuse

## Diagnostic de départ

La précédente version déclenchait la capture via `MediaRecorder` (format WebM/Opus), puis décodait l'audio et rééchantillonnait le résultat en WAV. Le témoin de niveau du micro utilisait séparément `AudioContext` / `AnalyserNode`. Bloquer les fichiers silencieux dans l'UI ou le backend ne réparait pas le flux d'enregistrement.

## Nouveau circuit

1. `getUserMedia()` sélectionne le microphone Chrome/Edge.
2. Le `MediaStreamAudioSourceNode` envoie le son au `AudioWorkletNode` (`static/pcm-processor.js`), ou `ScriptProcessorNode` si le worklet n'est pas disponible.
3. Les **mêmes blocs Float32 PCM** servent à la barre `Niveau reçu` et au fichier final. La sortie Web Audio est reliée à un `GainNode` de gain 0 pour ne pas émettre le microphone dans les haut-parleurs.
4. Le flux est assemblé à l'arrêt, rééchantillonné en mono 16 kHz et encodé directement PCM 16 bits WAV.
5. Calculs RMS/crête et rapport détaillé : si le microphone ne fournit que des zéros, l'interface le montre et la sauvegarde reste bloquée (y compris côté serveur HTTP 422).

## Fichiers modifiés

- `static/app.js` : remplacement intégral de la voie MediaRecorder → decodeAudioData par capture PCM.
- `static/pcm-processor.js` : nouveau Worklet.
- `static/index.html`, `static/styles.css` : rapport technique visible dans un `<details>`.
- `tests/pcm_browser_smoke.cjs` : test Chromium de capture PCM avec micro synthétique audible, silencieux, quasi silencieux, et réécoute du WAV.
- `tests/pcm_worklet_unit.cjs` : tests unitaires du processeur Worklet, rétention des échantillons et flush final.
- `tests/browser/audio.spec.cjs` : attentes mises à jour pour la nouvelle capture.
- `app.py` : version 0.3.2 ; contrôle du WAV et classifications existants préservés.

## Résultats locaux

- Python : 39 tests + 18 sous-tests réussis.
- Chromium sans navigation réseau (test `page.setContent`, méthode de secours `ScriptProcessor`) : micro synthétique amplitude 0.3 → RMS ~0.209 et réécoute audible ; amplitude 0 et 0.00005 → RMS nul/très faible, sauvegarde désactivée.
- Worklet : test unitaire réussi pour des blocs émis, flush final et sortie silencieuse.
- Le parcours HTTP navigateur réel utilisant `AudioWorklet` n'a pas été validé dans ce conteneur car Chromium y interdit la navigation localhost et file://. Il reste à tester sur le poste Windows réel.

## Reprise sur le poste Windows

1. Décompresser et remplacer **tout le dossier static**, pas uniquement app.js : `pcm-processor.js` est nécessaire.
2. Dans le dossier contenant `app.py`, exécuter `python -m uvicorn app:app --host 127.0.0.1 --port 8000` (en utilisant le venv et les dépendances du projet).
3. Sur Chrome/Edge : ouvrir `http://localhost:8000`, faire `Ctrl+F5`, sélectionner le micro qui fonctionne dans Windows.
4. Parler pendant 3–5 s. Vérifier que `Niveau reçu` bouge, arrêter, ouvrir **Diagnostic du microphone**, puis réécouter.
5. Si le signal reste nul, comparer avec l'Enregistreur vocal de Windows ; vérifier **Paramètres > Système > Son > Entrée** et les permissions microphone de Chrome/Edge.

Les valeurs RMS/crête permettent d'isoler une source muette ; elles ne certifient pas la présence d'une voix humaine.
