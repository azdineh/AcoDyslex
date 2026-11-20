# AcoDyslex V0.3.4 — Lecture continue segmentée

## Parcours

La page de lecture affiche un seul mot arabe à la fois. Le premier clic sur le bouton rouge ouvre le microphone et démarre le premier segment. Le bouton **Terminer ce mot**, la limite de 10 secondes ou deux secondes de silence consécutives après détection de la voix finalisent le WAV courant. Il est sauvegardé dans IndexedDB avec l’identifiant du mot, puis le mot suivant s’affiche et démarre immédiatement un nouveau segment. Le silence initial n’est pas utilisé pour passer un mot avant que l’enfant commence à parler.

Après le quinzième mot, le microphone est libéré et le récapitulatif affiche les 15 fichiers. Aucun appel Modal n’est effectué pendant la lecture. L’unique requête `/v1/reading/analyze-batch` part après le consentement et le clic explicite sur **Analyser les lectures**.

## États de capture

- `idle` : le premier démarrage ou une reprise explicite est possible.
- `recording` : le PCM du mot courant est capturé et la forme d’onde réelle est animée.
- `paused` : le contexte audio, le chronomètre et la forme d’onde sont suspendus.
- `finalizing` : les échantillons sont drainés puis encodés en WAV.
- `transitioning` : le mot suivant est affiché avant le redémarrage automatique.
- `ready_to_analyze` : les 15 WAV sont disponibles pour le récapitulatif.
- `recording_error` : le démarrage ou la sauvegarde a échoué et une reprise explicite est proposée.

Le changement d’état est synchrone avant toute finalisation asynchrone. Il bloque ainsi les doubles clics, les deux transitions simultanées et les captures concurrentes.

## Audio et reprise

Le `MediaStream` autorisé reste vivant entre deux mots. Chaque segment utilise toutefois un nouveau contexte de capture et un nouveau tampon PCM. La piste est arrêtée à la fin du quinzième mot, lors d’un retour à l’accueil ou après une libération explicite.

Un réenregistrement conserve l’ancien WAV tant que le nouveau fichier n’a pas été inspecté et écrit avec succès. Les WAV déjà sauvegardés sont restaurés depuis IndexedDB après rechargement ; l’utilisateur reprend ensuite manuellement au mot affiché.

La forme d’onde lit `getLiveSamples()` et ne génère aucune donnée décorative. Sa boucle `requestAnimationFrame` tourne seulement pendant `recording`, s’arrête en pause et respecte `prefers-reduced-motion`.

## Vérifications automatisées

Les tests navigateur couvrent :

- le clic initial suivi des 15 segments et l’absence de chevauchement ;
- l’association unique des WAV aux 15 mots ;
- la pause et la reprise sur le même mot ;
- la transition automatique à la limite configurée ;
- la transition après deux secondes de silence suivant une voix confirmée, sans transition sur le silence initial ;
- l’absence d’analyse pendant la lecture puis un seul lot après l’action explicite ;
- la réutilisation d’un seul `MediaStream` avec le microphone virtuel de Chromium ;
- la forme d’onde PCM, son arrêt en pause et le mouvement réduit ;
- l’absence de débordement à 768 px et 375 px.

Les captures de référence sont dans `artifacts/v034/`.
