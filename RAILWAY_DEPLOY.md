# Déployer AcoDyslex sur Railway

Ce dépôt déploie l'interface et l'API FastAPI sur Railway. L'inférence
phonétique reste sur Modal : le navigateur n'accède jamais à la clé Modal.

## Pré-requis de sécurité

Cette version conserve encore les profils, les reçus de validation et, si les
routes historiques sont utilisées, des WAV sur le système de fichiers. C'est
un prototype : ne l'utilisez pas avec des données identifiables d'enfants avant
d'avoir ajouté authentification, contrôle d'accès, consentement vérifiable,
chiffrement et règles de rétention.

## Création du service

1. Créez un projet Railway et choisissez **Deploy from GitHub Repo**.
2. Sélectionnez ce dépôt. Railway détecte le `Dockerfile` à la racine.
3. Ajoutez un **Volume** Railway, monté sur `/data`.
4. Dans **Settings > Healthcheck**, définissez le chemin `/health` (timeout :
   300 secondes).
5. Générez le domaine public du service.

Le volume est indispensable pour conserver les données entre deux déploiements.
Le conteneur utilise `ACODYSLEX_STORAGE_DIR=/data` et y conserve le stockage
local ainsi que la base SQLite des reçus de revue.

## Variables Railway

Ajoutez ces variables dans l'onglet **Variables** du service. Marquez les
secrets comme *sealed*.

```text
ACODYSLEX_API_KEY=...                 # secret partagé avec le service Modal
ACODYSLEX_MODAL_BASE_URL=https://...modal.run
ACODYSLEX_REVIEW_SIGNING_KEY=...      # secret aléatoire stable, >= 32 octets
ACODYSLEX_STORAGE_DIR=/data
```

Optionnelles :

```text
ACODYSLEX_READING_MODE=mixed
ACODYSLEX_WORD_MAX_SECONDS=10
ACODYSLEX_SENTENCE_MAX_SECONDS=20
```

Ne configurez pas `PORT` : Railway le fournit automatiquement et le
`Dockerfile` démarre Uvicorn sur cette valeur.

## Contrôles de déploiement

- Railway appelle `GET /health` avant d'activer la nouvelle version.
- Vérifiez `https://<votre-domaine>/health` : la réponse doit être
  `{"status":"ok"}`.
- Vérifiez ensuite `GET /api/config` sans y exposer une clé.
- Gardez **une seule réplique** tant que l'application utilise SQLite sur le
  volume. Pour scaler horizontalement, migrez les données vers PostgreSQL et
  les enregistrements audio vers un stockage objet privé.

## Déploiement en ligne de commande (facultatif)

```powershell
railway login
railway init
railway up
```

Railway détecte le `Dockerfile` à la racine. Railway peut aussi déployer
automatiquement à chaque push GitHub.
