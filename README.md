# AcoDyslex Frontend v0.3.7 — Interface arabe et anglaise

Interface Web autonome pour **enregistrer, réécouter, télécharger, sauvegarder et analyser** des fichiers audio en lecture arabe. Ce projet **ne remplace pas** votre `modal_service.py` v0.2 : il se connecte à l'API déjà déployée sur Modal.

## Fonctionnalités

- Capture **PCM directe** du microphone avec **AudioWorklet**, ou **ScriptProcessor** comme solution de repli. Suppression de la conversion intermédiaire WebM/Opus → WAV : le même flux d’échantillons sert au niveau de capture et au **WAV mono 16 kHz PCM 16 bits** (limite 20 s). Le niveau est contrôlé sur le signal PCM (AC RMS/crête) : un fichier silencieux ou quasi silencieux ne peut pas être sauvegardé ; le téléchargement du diagnostic reste possible.
- Import d'un WAV déjà préparé, écoute et téléchargement local.
- Enregistrement local dans `recordings/` avec un **code pseudonyme** de lecteur, texte de référence et phonèmes cibles facultatifs. Le backend bloque également les WAV silencieux (HTTP 422), y compris les imports. Ce contrôle ne prouve pas qu’une voix intelligible est présente.
- Liste des audios sauvegardés, sélection, écoute, suppression.
- Analyse via le backend FastAPI local, qui appelle Modal avec `ACODYSLEX_API_KEY` **sans transmettre la clé au navigateur**.
- Visualisation des phonèmes, descripteurs acoustiques, erreurs candidates, export JSON.
- Classification phonémique : omissions, inversions, insertions et substitutions candidates, provenance de la référence et détails des opérations. Les références G2P restent provisoires ; les résultats ambigus ou indisponibles sont indiqués explicitement.
- Suivi longitudinal V0.2 : séances, recommandations présentées, tentatives idempotentes, progression par compétence, historique paginé et adaptation explicable. Voir `PROGRESS_V02.md`.
- Parcours guidé V0.3 : profils pseudonymes, sélection adaptative de 15 mots, lecture RTL accessible, bilan avec validation humaine signée et reprise après rechargement. Voir `FRONTEND_V03.md`.
- Remédiation V0.3.2 : sept exercices personnalisés, une activité à la fois, correction interactive, aide, reprise et abandon explicite. Voir [`REMEDIATION_V032.md`](REMEDIATION_V032.md).
- Interface V0.3.3 : hiérarchie enfant/accompagnateur, progression en sept étapes, arabe agrandi, audio réel conditionnel et responsive 1440/768/375 px. Voir [`REMEDIATION_V033.md`](REMEDIATION_V033.md).
- Lecture V0.3.4 : un clic démarre une chaîne de 15 enregistrements WAV isolés, avec passage automatique au mot suivant, limite de 10 secondes, forme d’onde issue du PCM réel et réutilisation du flux microphone autorisé. L’analyse groupée reste une action explicite après le récapitulatif. Voir [`READING_V034.md`](READING_V034.md).
- Analyse V0.3.5 : écran dédié « Analyse Acoustique AI », résumé des 15 audios, flux FastAPI → Modal Acoustic AI → bilan, progression accessible, consentement explicite et reprise après erreur sans perdre le lot local. Voir [`ACOUSTIC_AI_V035.md`](ACOUSTIC_AI_V035.md).
- Interface V0.3.7 : arabe par défaut en RTL, anglais en LTR, chiffres latins dans les deux langues, avatars SVG locaux persistants, résultats pédagogiques expliqués et provenance IA/humaine visible. Le contenu de lecture arabe reste en RTL dans les deux langues. Voir [`I18N_V036.md`](I18N_V036.md).
- Parcours V0.3.1 : 15 WAV isolés dans IndexedDB, pause et reprise, réenregistrement ciblé, puis une seule requête d'analyse groupée. Voir [`V031_BATCH_ANALYSIS.md`](V031_BATCH_ANALYSIS.md).
- Laboratoire audio isolé dans une page technique ouverte à la demande depuis le menu principal; aucune détection de microphone ni lecture des archives au chargement de l’accueil.
- **Whisper optionnel** pour la transcription de mots, *sans* jamais remplacer les erreurs phonémiques candidates ni constituer un diagnostic.

## Démarrage Windows / PowerShell

Ouvrez un terminal dans ce nouveau dossier et exécutez :

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt

# Mettez la même clé que celle créée dans le secret Modal acodyslex-api
$env:ACODYSLEX_API_KEY = "VOTRE_CLE_API_MODAL"

# Facultatif : l'URL par défaut correspond au déploiement connu
$env:ACODYSLEX_MODAL_BASE_URL = "https://azzeddine-hlali--acodyslex-acoustic-create-api.us-east.modal.run"

python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Ouvrez **http://localhost:8000** dans Chrome / Edge / Firefox. Autorisez l'accès au microphone.

La variable `ACODYSLEX_API_KEY` est nécessaire uniquement pour l'analyse Modal, pas pour la sauvegarde locale. Ne placez pas cette clé dans le JavaScript, GitHub ou un fichier livré aux utilisateurs.

## Test rapide

1. Conservez le code anonyme `lecteur-001`, indiquez le texte attendu `سمكة`.
2. Sélectionnez le bon microphone et vérifiez que **Niveau reçu** bouge lorsque vous parlez. Enregistrez jusqu’à 20 secondes, puis cliquez sur **Arrêter**.
3. Ouvrez **Diagnostic du microphone** : un RMS supérieur à 0 et une crête visible confirment le signal capté. Réécoutez l'audio avant de cocher l'autorisation et de cliquer sur **Sauvegarder la lecture**. Si le RMS et la crête sont proches de 0, vérifiez **Paramètres Windows > Système > Son > Entrée**, puis l’accès microphone dans Chrome/Edge.
4. Sélectionnez cette lecture dans la liste, cochez séparément l'autorisation d'envoi au service Modal et cliquez sur **Analyser l'audio**.
5. Vérifiez les phonèmes reconnus et la provenance de la référence. Pour essayer le G2P conservateur, utilisez un mot vocalisé pris en charge, par exemple `كَتَبَ`. Une conversion réussie ne constitue pas une validation humaine.
6. Vous pouvez télécharger le WAV, exporter le JSON et supprimer l'audio local.

## Activer Whisper si nécessaire

Le mode par défaut laisse Whisper **désactivé** afin de privilégier la détection phonémique. Pour l'activer en complément local :

```powershell
python -m pip install -r requirements-whisper.txt
$env:ACODYSLEX_ENABLE_WHISPER = "1"
$env:ACODYSLEX_WHISPER_MODEL = "tiny"  # ou base/small selon les ressources disponibles
python -m uvicorn app:app --host 127.0.0.1 --port 8000
```

Cochez ensuite **Activer la transcription Whisper** avant de lancer une analyse. La première utilisation peut télécharger les poids du modèle et demander du temps CPU. Whisper s'exécute ici sur votre machine, et n'est pas un second fournisseur d'inférence distant. **Sa transcription est indicative** et peut normaliser les erreurs de lecture de l'enfant.

## Sécurité et limites importantes

**Prototype local uniquement. Ne pas déployer publiquement ni utiliser avec de vrais enregistrements identifiables d'enfants dans cet état.**

- Les fichiers sont conservés en clair dans `recordings/`. Il n'y a **pas** d'authentification, de chiffrement, de gestion vérifiable du consentement parental, de contrôle d'accès par rôle ni de politique de rétention automatisée.
- Les deux cases servent à guider l'opérateur ; elles **ne remplacent pas** le consentement parental vérifié et documenté.
- Pour une expérimentation auprès d'enfants : gouvernance des données, autorisations éthiques et parentales appropriées, chiffrement au repos et en transit, accès restreint, durée de conservation, suppression vérifiable et hébergement adapté au contexte réglementaire.
- Le serveur écoute volontairement uniquement sur **127.0.0.1**. Ne le publiez pas avec `--host 0.0.0.0`.
- Aucun audio n'est transmis à Modal à la seule sauvegarde ; l'envoi a lieu uniquement quand l'utilisateur lance l'analyse en cochant la case séparée.
- Le modèle Modal conserve sa logique actuelle : `candidate_errors` n'est renseigné que si `expected_phonemes` est fourni. Une liste vide **sans** référence phonémique n'indique pas une lecture correcte.
- La conversion audio client est un rééchantillonnage simple, suffisant pour une démonstration technique. Pour la collecte scientifique, contrôler micro, bruit, protocole et qualité du signal, idéalement avec conversion validée.

## Organisation

```text
AcoDyslex_Frontend_v0.3/
├── app.py                  # FastAPI local, sauvegarde, proxy Modal, Whisper facultatif
├── requirements.txt
├── requirements-whisper.txt
├── README.md
├── recordings/             # WAV + JSON locaux (ne pas publier)
└── static/
    ├── index.html          # Interface
    ├── i18n.js             # Chargement central des traductions et gestion RTL/LTR
    ├── locales/            # Catalogues arabe et anglais
    ├── styles.css
    ├── laboratory.css      # Styles cantonnés à la page technique
    ├── app.js              # Microphone PCM, WAV, opérations UI
    ├── session_app.js      # Parcours profils → lecture → bilan → exercices → progrès
    ├── reading_waveform.js # Forme d’onde PCM de la lecture, active uniquement pendant la capture
    ├── reading_words.json  # Banque locale structurée de 30 mots de démonstration
    ├── pcm-processor.js    # Worklet de capture PCM directe
    └── phoneme_classification_ui.js # Affichage prudent de la classification
```

## Vérifications locales de l'intégration

Le service doit retourner `phoneme_classification` directement dans le JSON de `/v1/reading/analyze`. Le backend local transmet cet objet sans recalcul, ajoute la provenance et renseigne `classification_available`. Si Modal omet la classification, l'interface affiche « Classification indisponible », sans inventer quatre zéros. Aucun déploiement Modal n'est effectué par ces tests.

Depuis la racine du projet, une commande par ligne :

```powershell
.\.venv\Scripts\python.exe -m py_compile app.py arabic_g2p.py
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
.\.venv\Scripts\python.exe -m unittest -v test_arabic_g2p.py
node --check static/app.js
node --check static/phoneme_classification_ui.js
npm.cmd install
npx.cmd playwright install chromium
npm.cmd run test:pcm:worklet
npm.cmd run test:pcm:smoke
npm.cmd test
```

Les dépendances Node servent uniquement aux tests navigateur. L'application reste en JavaScript natif, sans compilation. `unittest` est fourni avec Python ; `pytest` n'est pas requis.

Les tests Python utilisent des WAV synthétiques, un stockage temporaire et des réponses Modal simulées. Les tests Chromium couvrent l'interface et un parcours complet navigateur → FastAPI local → transport Modal simulé → affichage, puis lecture du WAV et suppression. Leur serveur isolé écoute sur `127.0.0.1:8765`, utilise une fausse clé et ne contacte pas Modal. Les captures de test sont dans `test-results/`.

Cela ne valide ni l'inférence GPU réelle, ni la précision sur la parole d'enfants, ni le microphone physique. Le service Modal et ses tests de déploiement ne sont pas présents dans ce dossier.

## Aperçu de recommandations pédagogiques V0.1

Le backend local expose `POST /v1/recommendations/preview`. Il accepte des observations structurées et renvoie `individualized_recommendations`, `needs_verification`, `engine_version`, `rule_version` et `is_medical_diagnosis: false`. Les identifiants doivent être pseudonymes. Les observations ASR issues de `/api/recordings/{id}/analyze` sont ajoutées à `recommendation_observations` avec `verification_status: automated_unverified`; elles ne suffisent jamais à proposer des exercices.

La validation humaine est une action distincte via `POST /v1/recommendations/observations/verify`. Un relecteur indique son identifiant pseudonyme, son examen de l’audio et de la cible, puis confirme ou rejette l’observation. Une confirmation fournit un reçu HMAC lié aux champs de l’observation, valable 15 minutes et à usage unique; l’aperçu le consomme dans un stockage SQLite transactionnel. La clé HMAC peut être fournie par `ACODYSLEX_REVIEW_SIGNING_KEY`; sinon, une clé locale persistante est créée dans `recordings/` pour survivre aux redémarrages et être partagée entre workers. Ce reçu atteste l’action déclarée par l’appelant ; le prototype n’a ni authentification ni moyen de vérifier l’identité ou la formation du relecteur. Ne pas exposer ces routes sur Internet ni traiter ce mécanisme comme un contrôle d’accès.

Les données V0.1 sont sous `recommendation/` : taxonomie E01–E06, 16 exercices et moteur explicable. Les seuils de répétition, les scores et le seuil de maîtrise 0,6 restent provisoires et doivent être validés par des spécialistes. Les observations peuvent préciser la variété d’arabe et le contexte de diglossie ; ces champs ne transforment pas automatiquement une différence dialectale ou une voyelle non écrite en erreur. Les substitutions ASR génériques ne sont pas assimilées à une substitution consonantique.

Les événements d’aperçu et de validation consignent la version des règles, la provenance, le résultat et les motifs sans inclure les chaînes observées, les enregistrements audio ni les identifiants de lecture. Aucun audio n’est envoyé au moteur de recommandations.

Vérifier avec `.\.venv\Scripts\python.exe -m unittest discover -s tests -v`. Les tests de recommandation utilisent uniquement des données synthétiques et n’appellent pas Modal.

## Suivant (v0.4)

- Authentification enseignant / parent et stockage chiffré.
- Référentiel phonémique arabe annoté, dérivé du texte attendu et validé dans le vocabulaire du modèle.
- Validation humaine des inversions, omissions, insertions et substitutions.
- Suivi longitudinal et protocole d'évaluation pédagogique des recommandations.

## Diagnostic spécifique : fichiers WAV silencieux

Si le WAV est toujours silencieux, ouvrir **Diagnostic du microphone (RMS, crête, source)** et vérifier :

- **Échantillons capturés = 0** : le navigateur ne reçoit aucun bloc PCM ; contrôler la permission et la source.
- **Échantillons capturés > 0, RMS/Crête proches de zéro** : la source choisie ou le système transmet essentiellement du silence. Tester le micro dans **Enregistreur vocal Windows** et comparer.
- **RMS positif et WAV audible sur un autre lecteur**, mais aucune sortie dans la page : contrôler le volume et le périphérique de lecture.
- **Méthode `AudioWorklet PCM direct`** : chemin privilégié ; `ScriptProcessor ... (secours)` : ancien navigateur ou module Worklet inaccessible.

La source PCM du WAV est exactement celle utilisée par l'indicateur de niveau. En cas de problème persistant, copier le rapport de diagnostic (il ne contient pas les enregistrements).

La démonstration par test synthétique n'est pas une validation du microphone physique Windows.
