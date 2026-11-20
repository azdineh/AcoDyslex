# Diagnostic de la capture microphone — 5 novembre 2026

La précision de l'utilisateur (« seuls les nouveaux enregistrements sont silencieux ») oriente le diagnostic vers la capture, plutôt que vers un problème général de sortie audio. Aucun WAV des derniers essais n'est présent dans `recordings/` au moment de la vérification : les fichiers locaux les plus récents datent du 4 novembre. La cause du silence réel n'est donc pas établie à partir de ces fichiers.

## Changements

- `static/index.html` : liste **Microphone utilisé**, indicateur **Niveau reçu** et message de signal.
- `static/app.js` : énumération des entrées disponibles et demande explicite du périphérique sélectionné ; affichage de son nom et du niveau pendant la capture ; mesure du signal après conversion WAV ; avertissements pour silence ou niveau très faible.
- La liste de microphones et les commandes de capture sont verrouillées pendant l'ouverture, l'enregistrement et la conversion. Les pistes et le contexte de mesure sont libérés à l'arrêt ou après un échec. Un refus d'accès conserve l'audio précédent.
- Le microphone de mesure n'est pas relié aux haut-parleurs. Aucun gain automatique supplémentaire, aucune amplification du WAV et aucun changement des contraintes mono/16 kHz/PCM 16 bits.
- `static/styles.css` : présentation du sélecteur et du niveau sur ordinateur et mobile.
- `tests/browser/audio.spec.cjs` : tests avec microphone virtuel et trois signaux (audible, silence numérique, très faible), sélection du périphérique, mesure du signal de lecture et nettoyage des ressources. Un autre test couvre le refus de permission.

Le niveau est un indicateur de signal, pas un détecteur de voix. Le bruit ambiant peut également faire bouger la barre. Les seuils de message sont des indications techniques ; ils ne constituent pas une évaluation de qualité clinique ou pédagogique. Un fichier silencieux reste téléchargeable pour permettre le diagnostic.

## Vérifications effectuées

```powershell
node --check static/app.js
npm.cmd test -- tests/browser/audio.spec.cjs
npm.cmd test
```

Résultats : **4 tests audio ciblés réussis**, puis **39 tests navigateur réussis** dans la suite complète. La capture audible produit un RMS de 0,172 ; un signal non nul est mesuré à la sortie du lecteur avant et après sauvegarde. La sauvegarde simulée conserve exactement les octets du WAV. Les cas silencieux et très faible affichent leurs avertissements attendus. Aucun microphone physique ni enregistrement personnel n'a été utilisé dans ces tests, et aucun appel Modal n'a été effectué.

La vue mobile a été inspectée sur la capture `test-results/classification-mobile.png`. Les fichiers `app.js` et `index.html` servis par `http://127.0.0.1:8000` correspondent aux fichiers modifiés.

## Essai à effectuer avec le microphone réel

1. Conserver d'abord tout audio en mémoire à garder, puis recharger avec **Ctrl+F5**.
2. Choisir le microphone souhaité dans **Microphone utilisé**. Si les noms ne sont pas encore accessibles, commencer un premier essai, autoriser le microphone dans le navigateur, puis arrêter pour choisir l'entrée.
3. Cliquer sur **Commencer** et parler : la barre **Niveau reçu** doit réagir.
4. Si elle reste vide, essayer une autre entrée. Si elle réagit mais que le WAV reste silencieux, le diagnostic doit continuer sur cette nouvelle capture ; ne pas attribuer automatiquement le problème au périphérique de sortie.
5. Arrêter puis cliquer sur **Réécouter**.

La résolution dans la session réelle reste à confirmer par cet essai. Le matériel, le pilote et la permission du navigateur n'ont pas été modifiés.

Sauvegarde avant modification : `.codex-backups/20261105T200151Z-microphone/`. Diff ciblé : `MICROPHONE_FIX.diff`.
