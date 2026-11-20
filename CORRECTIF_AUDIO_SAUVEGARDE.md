# AcoDyslex — Correctif audio et sauvegarde (05/11/2026)

## Constat dans le ZIP reçu

- L'interface détectait un WAV silencieux après conversion mais exécutait tout de même `setAudio(wav, ...)`, qui activait « Sauvegarder ».
- Le serveur FastAPI contrôlait le conteneur WAV (mono/16 kHz/PCM 16 bits), la durée et la taille, mais **pas** les échantillons PCM : il acceptait un WAV composé uniquement de zéros.
- Le précédent diagnostic avec microphone virtuel démontrait qu'un signal audible de test traversait capture, conversion, lecture et sauvegarde, mais ne reproduisait pas le problème du microphone réel.

## Modifications

1. `static/app.js` : mesure du signal utile après conversion (RMS AC, crête corrigée du DC) ; `audioSaveAllowed` empêche la sauvegarde si RMS < 0,0005 ou crête < 0,002. Le téléchargement de diagnostic reste disponible. Même vérification avant la sauvegarde d'un WAV importé.
2. `app.py` : vérification indépendant des échantillons PCM **avant écriture** dans `recordings/`, HTTP 422 avec explication en cas de silence ou quasi-silence. Le serveur enregistre `audio_rms` et `audio_peak` en métadonnées pour les nouveaux audios valides.
3. Tests : remplacement des anciens WAV *de test* totalement silencieux (qui produisaient des faux positifs) par des signaux synthétiques audibles ; nouvelles régressions silence, quasi-silence, offset continu et égalité binaire après sauvegarde.
4. Aucun changement de `X-AcoDyslex-Key`, Modal, G2P, phonèmes ni de l'algorithme de classification.

## Contrôles exécutés dans cet environnement

- 23 tests Python backend et intégration : réussis.
- 16 tests G2P : réussis.
- Syntaxe `static/app.js`, `phoneme_classification_ui.js` et des tests navigateur : valide.
- La suite Playwright *n'a pas pu être validée ici* : le Chromium de cet environnement bloque la navigation vers le serveur local avec `net::ERR_BLOCKED_BY_ADMINISTRATOR`. Il ne s'agit donc pas d'un échec démontré du code mais d'une limite de vérification.
- L'appareil microphone réel de l'utilisateur n'est pas accessible ici, donc la cause physique du silence (périphérique, autorisation ou configuration OS) n'est pas prouvée ni corrigée par ce paquet.

## Essai à réaliser sur la machine Windows

1. Remplacer les fichiers de l'application par ce paquet, conserver ses propres enregistrements existants **hors du dossier remplacé**, puis relancer Uvicorn.
2. Ouvrir `http://localhost:8000` et presser `Ctrl+F5` pour recharger le nouveau JavaScript.
3. Choisir le bon **Microphone utilisé**, appuyer sur **Commencer**, parler pendant 3 à 5 secondes : le **Niveau reçu** doit bouger.
4. Cliquer sur **Arrêter** puis **Réécouter** ; sauvegarder uniquement si le WAV est audible. Le serveur refusera désormais un WAV silencieux, même si l'interface était contournée.
5. Si le niveau micro bouge et que le fichier est encore silencieux, télécharger ce WAV de diagnostic et comparer avec un enregistrement Windows du même microphone. L'enregistrer ne répare pas le micro, mais empêche de polluer les archives et l'analyse phonémique.
6. Sur une machine équipée des dépendances de test : `npm ci`, `npx playwright install chromium`, `npm test`.

**Limite importante** : un signal non nul (p. ex. bruit de fond) n'est pas automatiquement une lecture intelligible. Les seuils sont une protection technique, non une validation pédagogique ou clinique.
