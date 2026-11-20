# AcoDyslex Frontend V0.3

## Parcours livré

1. L’accompagnant crée ou choisit un profil pseudonyme local (alias, âge, sexe facultatif).
2. Le client construit une liste ordonnée de **15 mots** depuis `static/reading_words.json`. Il privilégie les mots non vus dans les deux dernières séances et répartit la liste en révision, consolidation et transfert.
3. Chaque mot est présenté en RTL. La taille est réglable et le mode couleur applique un dégradé au mot façonné d’un seul bloc, sans séparer les lettres de leurs diacritiques ni rompre les liaisons cursives.
4. L’audio est limité à 10 secondes dans ce parcours. Un WAV peut aussi être importé. La sauvegarde et l’analyse passent par les routes audio existantes.
5. Le bilan distingue les candidats acoustiques des observations humaines. La confirmation appelle la route signée existante, puis rattache les observations à la session dans une transaction qui consomme les reçus.
6. Le moteur longitudinal fournit exactement sept exercices interactifs issus de `recommendation/exercises.json`. Sans signal vérifié suffisant, il complète par des activités de consolidation et l’indique explicitement.
7. Chaque tentative est enregistrée avec `evaluation_context: practice`. La clôture actualise la progression et permet à la séance suivante d’éviter les mots récents.

L’état local reprend une séance après rechargement. L’état serveur suit `created → reading → analyzing → review → remediation → completed` et refuse les transitions incohérentes.

Le **Laboratoire audio** est une page technique séparée, masquée par défaut et ouverte depuis le menu principal. Son initialisation est paresseuse : la détection des microphones, le chargement des archives et la configuration Modal commencent seulement lors de son ouverture. Le retour restaure l’écran enfant courant; un enregistrement technique actif déclenche une confirmation avant son arrêt.

## Contrats ajoutés

Les routes V0.1 et V0.2 restent inchangées. V0.3 ajoute :

| Méthode | Route | Rôle |
|---|---|---|
| `POST` | `/v1/progress/children` | créer un profil pseudonyme |
| `GET` | `/v1/progress/children` | lister les profils locaux |
| `PATCH` | `/v1/progress/children/{child_id}` | modifier alias, âge ou sexe |
| `DELETE` | `/v1/progress/children/{child_id}` | supprimer le profil et ses données locales |
| `PATCH` | `/v1/progress/sessions/{session_id}/state` | avancer d’une étape |
| `POST` | `/v1/progress/sessions/{session_id}/words/{word_id}/analysis` | associer une analyse et un enregistrement au mot |
| `POST` | `/v1/progress/sessions/{session_id}/observations` | consommer les reçus et rattacher un lot idempotent |
| `POST` | `/v1/progress/sessions/{session_id}/recommendations` | figer sept exercices uniques |

`SessionCreate` accepte `reading_words`: soit une liste vide pour garder la compatibilité V0.2, soit exactement 15 mots uniques avec les ordres 1 à 15. `GET .../recommendations` accepte `session_id` en query pour inclure les observations vérifiées de la session ouverte et renvoie aussi `recommended_exercises`, toujours de longueur 7 pour le parcours actuel.

## Exécution

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
npm install
npx playwright install chromium

$env:ACODYSLEX_API_KEY = "VOTRE_CLE_MODAL"
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Ouvrir `http://127.0.0.1:8000`. L’application est un prototype local : les profils ne doivent utiliser que des alias.

## Tests

```powershell
python -m pytest -q
python -m unittest -v test_arabic_g2p.py
npm test
npm run test:pcm:worklet
npm run test:pcm:smoke
```

`tests/test_v03_flow.py` couvre la chaîne profils → 15 mots → analyse associée → reçu humain → 7 exercices → tentatives → clôture, l’isolation entre enfants et le refus d’un reçu falsifié ou réutilisé. `tests/browser/session_flow.spec.cjs` couvre le parcours visible complet avec Modal simulé, les interactions, la reprise après rechargement et le mobile.

## Captures

Les tests navigateur régénèrent les captures dans `artifacts/v03/` : profils, lecture, bilan, exercices, progrès et laboratoire mobile.

## Limites

- La banque de mots et les consignes du catalogue sont des contenus de démonstration à valider par des spécialistes de la lecture arabe.
- La précision acoustique sur la parole d’enfants et le service Modal réel ne sont pas validés par les tests locaux.
- Le prototype ne fournit ni authentification, ni chiffrement au repos, ni gestion réglementaire du consentement.
- Les scores sont des indicateurs pédagogiques provisoires et ne constituent pas un diagnostic.
