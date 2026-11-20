# AcoDyslex V0.3.5 — Analyse Acoustique AI

## Objectif de l’écran

Après les 15 lectures, l’interface présente une étape dédiée avant le bilan. Elle explique que les WAV locaux sont envoyés en un seul lot à FastAPI, puis traités par Modal Acoustic AI afin de préparer le bilan et les exercices personnalisés.

L’envoi reste impossible sans les 15 fichiers et sans autorisation explicite. Aucun audio n’est transmis à l’ouverture de l’écran.

## États affichés

1. **Lot prêt** : résumé des 15 audios, lecteur pseudonyme et consentement.
2. **Vérification** : contrôle du lot local avant transmission.
3. **Envoi groupé** : un seul lot est envoyé à FastAPI.
4. **Analyse Acoustique AI** : l’étape Modal est mise en évidence.
5. **Préparation du bilan** : organisation des résultats reçus.
6. **Succès** : confirmation avant l’ouverture du bilan.
7. **Erreur** : message lisible et bouton de nouvelle tentative.

La progression représente les quatre étapes du traitement. Elle ne prétend pas afficher un pourcentage réseau, car l’appel `fetch` actuel ne fournit pas cette mesure.

## Conservation et reprise

En cas d’erreur FastAPI ou Modal, les 15 WAV restent dans IndexedDB. Le bouton **Réessayer l’Analyse Acoustique AI** renvoie le même lot sans demander une nouvelle lecture. Les fichiers locaux sont supprimés uniquement après une réponse groupée réussie.

Le détail des WAV est disponible dans **Vérifier ou recommencer une lecture**. Un mot peut être repris avant l’envoi ; son ancien fichier reste conservé jusqu’à la réussite de son remplacement.

## Accessibilité et responsive

- Le statut dynamique utilise une zone `aria-live`.
- La progression expose `role="progressbar"`, sa valeur et son texte courant.
- Les quatre étapes restent compréhensibles sans animation.
- `prefers-reduced-motion` désactive les pulsations et transitions.
- Les cartes passent sur deux colonnes en tablette et une colonne sur mobile.

Les captures de référence sont disponibles dans `artifacts/v035/`.

## Provenance du modèle

L’écran interroge `GET /api/acoustic-model`. Cet endpoint lit directement `/health` et `/openapi.json` sur l’URL Modal configurée. L’interface ne repose donc pas sur un nom de modèle écrit en dur côté navigateur.

Le déploiement contrôlé le 10 novembre 2026 expose :

- modèle chargé : `MostafaMaroof/wav2vec2-arabic-phoneme-asr` ;
- nom publié : **Arabic Phoneme ASR v2** ;
- adaptation arabe publiée par **MostafaMaroof** ;
- modèle de base : `facebook/wav2vec2-large-xlsr-53`, développé par Facebook AI, aujourd’hui Meta ;
- infrastructure d’exécution : **Modal**, déploiement `modal-single-provider` ;
- version de l’API acoustique : `0.3.0`.

La fiche du modèle documente une spécialisation en reconnaissance phonémique arabe sur de l’arabe standard moderne et de la récitation coranique. La parole dialectale est indiquée comme hors domaine. Cette limite est affichée dans l’interface.

Le service actif n’expose aucune révision de poids ou empreinte de commit. L’interface affiche donc **Non exposée par Modal** au lieu d’inventer une version technique. Si l’identifiant renvoyé par Modal ne correspond plus exactement au modèle vérifié, la fiche passe en état non documenté et l’attribution Meta est masquée.

Références de vérification :

- <https://huggingface.co/MostafaMaroof/wav2vec2-arabic-phoneme-asr>
- <https://huggingface.co/facebook/wav2vec2-large-xlsr-53>
- <https://commons.wikimedia.org/wiki/File:Meta_Platforms_Inc._logo.svg>
