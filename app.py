"""AcoDyslex v0.4 - local prototype for mixed reading and Modal analysis.

IMPORTANT: This server is intentionally for LOCAL evaluation only. It has no account
system, parental consent verification, storage encryption or production audit trail.
Do not deploy publicly or use with identifiable recordings of minors.
"""

from __future__ import annotations

import asyncio
import hashlib
import math
import sys
import time
from array import array
import io
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID, uuid4
import wave

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from arabic_g2p import (
    arabic_to_model_phonemes,
    validate_manual_phonemes,
    G2PError,
    G2P_VERSION,
)
from recommendation.api import router as recommendation_router
from progress.api import router as progress_router
from progress import service as progress_service
from batch_analysis import (
    BatchAnalysisResponse,
    BatchManifest,
    BatchWordResult,
    build_global_summary,
)
from learning_guide import build_learning_guide
from pydantic import ValidationError

ROOT = Path(__file__).resolve().parent
# Railway mounts persistent disks outside the application image.  Keeping this
# configurable also makes local tests and local development retain their
# existing `recordings/` default.
STORAGE = Path(os.getenv("ACODYSLEX_STORAGE_DIR", ROOT / "recordings"))
STORAGE.mkdir(parents=True, exist_ok=True)
MAX_WAV_BYTES = 1_000_000
MAX_AUDIO_SECONDS = 20.0
MAX_BATCH_WORDS = 15
# The 10 s pedagogical timer is checked asynchronously. One final AudioWorklet
# PCM block can land after the tick; this margin accepts that block only.
WORD_DURATION_TOLERANCE_SECONDS = 0.25
# Match the browser-side quiet-voice policy.  Silence remains rejected while
# softly spoken readings amplified during capture can be saved.
MIN_READING_RMS = 0.003
MIN_READING_PEAK = 0.01
DEFAULT_MODAL_URL = (
    "https://azzeddine-hlali--acodyslex-acoustic-create-api.us-east.modal.run"
)
DEFAULT_MODEL_INFO_CACHE_TTL_SECONDS = 86_400
PHONEME_PRESENTATION_PATH = ROOT / "acodyslex_phonemes_ar.json"

VERIFIED_ACOUSTIC_MODELS = {
    "MostafaMaroof/wav2vec2-arabic-phoneme-asr": {
        "display_name": "Arabic Phoneme ASR v2",
        "release": "v2",
        "publisher": "MostafaMaroof",
        "task": "Reconnaissance phonémique de la parole arabe",
        "arabic_capability": "Arabe standard moderne et récitation coranique ; parole dialectale hors domaine validé.",
        "base_model": "facebook/wav2vec2-large-xlsr-53",
        "base_developer": "Meta (Facebook AI)",
        "base_developer_confirmed": True,
        "metadata_url": "https://huggingface.co/MostafaMaroof/wav2vec2-arabic-phoneme-asr",
        "base_model_url": "https://huggingface.co/facebook/wav2vec2-large-xlsr-53",
    }
}

app = FastAPI(title="AcoDyslex Frontend Prototype", version="0.4.0")
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
app.mount("/guideres", StaticFiles(directory=ROOT / "guideres"), name="guideres")
app.include_router(recommendation_router)
app.include_router(progress_router)


def configured_word_max_seconds() -> float:
    try:
        value = float(os.getenv("ACODYSLEX_WORD_MAX_SECONDS", "10"))
    except ValueError:
        return 10.0
    return value if 1 <= value <= 20 else 10.0


def configured_sentence_max_seconds() -> float:
    try:
        value = float(os.getenv("ACODYSLEX_SENTENCE_MAX_SECONDS", "15"))
    except ValueError:
        return 15.0
    return value if 1 <= value <= 20 else 15.0


def configured_reading_mode() -> str:
    value = os.getenv("ACODYSLEX_READING_MODE", "mixed").strip().lower()
    return value if value in {"word_only", "mixed", "adaptive"} else "mixed"


def model_info_cache_path() -> Path:
    """Return the local cache file for non-sensitive Modal model metadata."""
    configured = os.getenv("ACODYSLEX_MODEL_INFO_CACHE_PATH", "").strip()
    return Path(configured) if configured else ROOT / ".acodyslex-model-info.json"


def model_info_cache_ttl_seconds() -> int:
    try:
        value = int(os.getenv("ACODYSLEX_MODEL_INFO_CACHE_TTL_SECONDS", DEFAULT_MODEL_INFO_CACHE_TTL_SECONDS))
    except ValueError:
        return DEFAULT_MODEL_INFO_CACHE_TTL_SECONDS
    return max(0, min(value, 604_800))


def read_model_info_cache(modal_url: str, *, allow_stale: bool = False) -> dict | None:
    """Read a cache entry only when it belongs to the active Modal endpoint."""
    try:
        cache = json.loads(model_info_cache_path().read_text(encoding="utf-8"))
        saved_at = float(cache["saved_at"])
        payload = cache["payload"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if cache.get("modal_url") != modal_url or not isinstance(payload, dict):
        return None
    if not allow_stale and time.time() - saved_at > model_info_cache_ttl_seconds():
        return None
    return payload


def save_model_info_cache(modal_url: str, payload: dict) -> None:
    """Persist model *metadata* atomically; no audio, credentials or model weights."""
    path = model_info_cache_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(f"{path.suffix}.tmp")
        temporary.write_text(
            json.dumps({"modal_url": modal_url, "saved_at": time.time(), "payload": payload}),
            encoding="utf-8",
        )
        temporary.replace(path)
    except OSError:
        # The live Modal response remains usable when this optional local cache cannot be written.
        return


def model_phoneme_presentation(model_id: str | None) -> dict[str, dict[str, object]]:
    """Return documented Arabic labels for the exact active acoustic model."""
    if not isinstance(model_id, str) or not model_id:
        return {}
    try:
        document = json.loads(PHONEME_PRESENTATION_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {}
    if not isinstance(document, dict) or document.get("model") != model_id:
        return {}
    entries = document.get("phonemes")
    if not isinstance(entries, list):
        return {}
    presentation: dict[str, dict[str, object]] = {}
    for entry in entries:
        if not isinstance(entry, dict) or entry.get("mapping_status") != "documente_dans_recapitulatif":
            continue
        symbol, arabic, name_ar = entry.get("symbol"), entry.get("arabic"), entry.get("name_ar")
        if not all(isinstance(value, str) and value for value in (symbol, arabic, name_ar)):
            continue
        presentation[symbol] = {
            "arabic": arabic,
            "name_ar": name_ar,
            "category": entry.get("category"),
        }
    return presentation


def with_model_phoneme_presentation(payload: dict) -> dict:
    """Expose the display map while preserving raw model tokens for analysis."""
    return {
        **payload,
        "phoneme_presentation": model_phoneme_presentation(payload.get("model_id")),
    }


def validated_uuid(record_id: str) -> str:
    try:
        return str(UUID(record_id))
    except ValueError as exc:
        raise HTTPException(404, "Enregistrement introuvable") from exc


def get_paths(record_id: str) -> tuple[Path, Path]:
    safe_id = validated_uuid(record_id)
    return STORAGE / f"{safe_id}.json", STORAGE / f"{safe_id}.wav"


def read_metadata(record_id: str) -> dict:
    metadata_path, audio_path = get_paths(record_id)
    if not metadata_path.exists() or not audio_path.exists():
        raise HTTPException(404, "Enregistrement introuvable")
    return json.loads(metadata_path.read_text(encoding="utf-8"))


def wav_duration(data: bytes) -> float:
    if len(data) > MAX_WAV_BYTES:
        raise HTTPException(413, "Fichier trop volumineux")
    try:
        with wave.open(io.BytesIO(data), "rb") as wav:
            if (
                wav.getnchannels() != 1
                or wav.getframerate() != 16000
                or wav.getsampwidth() != 2
                or wav.getcomptype() != "NONE"
            ):
                raise HTTPException(400, "WAV requis : mono, 16 kHz, PCM 16 bits")
            frame_count = wav.getnframes()
            duration = frame_count / 16000.0
            if len(wav.readframes(frame_count)) != frame_count * 2:
                raise HTTPException(400, "Fichier WAV incomplet")
    except (wave.Error, EOFError, OSError) as exc:
        raise HTTPException(400, "Fichier WAV invalide") from exc
    if not (0.15 <= duration <= MAX_AUDIO_SECONDS):
        raise HTTPException(400, "Durée acceptée : de 0,15 à 20 secondes")
    return round(duration, 3)


def wav_quality(data: bytes) -> dict:
    """Check the *stored PCM bytes*, not only the RIFF header or file size.

    Compute AC RMS (remove DC bias): a DC offset is not audible speech.
    This is a technical guard, not speech/activity/clinical validation.
    """
    with wave.open(io.BytesIO(data), "rb") as wav:
        pcm = wav.readframes(wav.getnframes())
    samples = array("h")
    samples.frombytes(pcm)
    if sys.byteorder != "little":
        samples.byteswap()
    n = len(samples)
    if not n:
        raise HTTPException(400, "WAV vide")
    mean = sum(samples) / n
    rms = math.sqrt(max(0.0, sum(v * v for v in samples) / n - mean * mean)) / 32768.0
    peak = max(abs(v - mean) for v in samples) / 32768.0
    if rms < MIN_READING_RMS or peak < MIN_READING_PEAK:
        raise HTTPException(422, "WAV silencieux ou quasi silencieux : sauvegarde refusée. Vérifiez le microphone et recommencez.")
    return {"audio_rms": round(rms, 6), "audio_peak": round(peak, 6)}


@app.get("/")
def homepage():
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/health")
def healthcheck():
    """Small, dependency-free readiness endpoint for Railway deployments."""
    return {"status": "ok"}


@app.get("/api/config")
def config():
    return {
        "whisper_enabled": os.getenv("ACODYSLEX_ENABLE_WHISPER", "0") == "1",
        "modal_ready": bool(os.getenv("ACODYSLEX_API_KEY", "").strip()),
        "storage": "local-only",
        "max_seconds": MAX_AUDIO_SECONDS,
        "word_max_seconds": configured_word_max_seconds(),
        "sentence_max_seconds": configured_sentence_max_seconds(),
        "reading_mode": configured_reading_mode(),
        "word_duration_tolerance_seconds": WORD_DURATION_TOLERANCE_SECONDS,
    }


@app.get("/api/acoustic-model")
async def acoustic_model_config():
    """Read the model identity from the configured Modal deployment.

    Developer and capability metadata are attached only for an exact, reviewed
    runtime model id. An unrecognised deployment never inherits the Meta label.
    """
    modal_url = os.getenv("ACODYSLEX_MODAL_BASE_URL", DEFAULT_MODAL_URL).rstrip("/")
    if not modal_url.startswith("https://"):
        raise HTTPException(503, "Configuration Modal non sécurisée")
    cached = read_model_info_cache(modal_url)
    if cached is not None:
        return {**with_model_phoneme_presentation(cached), "cache_status": "cached"}
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            health_response, schema_response = await asyncio.gather(
                client.get(f"{modal_url}/health"),
                client.get(f"{modal_url}/openapi.json"),
            )
        health_response.raise_for_status()
        health = health_response.json()
        schema = schema_response.json() if schema_response.is_success else {}
    except (httpx.HTTPError, ValueError, TypeError) as exc:
        stale_cache = read_model_info_cache(modal_url, allow_stale=True)
        if stale_cache is not None:
            return {**with_model_phoneme_presentation(stale_cache), "cache_status": "stale"}
        raise HTTPException(503, "Métadonnées du modèle Modal indisponibles") from exc
    model_id = health.get("model") if isinstance(health, dict) else None
    if not isinstance(model_id, str) or not model_id.strip():
        raise HTTPException(502, "Le déploiement Modal n’expose pas son modèle acoustique")
    verified = VERIFIED_ACOUSTIC_MODELS.get(model_id.strip())
    api_info = schema.get("info") if isinstance(schema, dict) and isinstance(schema.get("info"), dict) else {}
    payload = {
        "runtime_source": "Modal /health",
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "model_id": model_id.strip(),
        "runtime_revision": health.get("model_revision") or None,
        "metadata_verified": verified is not None,
        "model": verified or {
            "display_name": model_id.strip(),
            "release": None,
            "publisher": None,
            "task": "Capacité non documentée pour ce déploiement",
            "arabic_capability": "Non confirmée",
            "base_model": None,
            "base_developer": None,
            "base_developer_confirmed": False,
            "metadata_url": None,
            "base_model_url": None,
        },
        "infrastructure": {
            "provider": "Modal",
            "deployment": health.get("deployment") or "non renseigné",
            "api_title": api_info.get("title") or "non renseigné",
            "api_version": api_info.get("version") or "non renseignée",
        },
    }
    save_model_info_cache(modal_url, payload)
    return {**with_model_phoneme_presentation(payload), "cache_status": "remote"}


@app.get("/v1/reports/sessions/{session_id}/pdf")
def session_learning_guide(session_id: str, lang: str = Query(default="ar", pattern="^(ar|en)$")):
    """Generate a local, non-persisted A4 guide from one stored session only."""
    if not session_id or len(session_id) > 64 or not all(char.isalnum() or char in "_-" for char in session_id):
        raise HTTPException(422, "session_id invalide")
    try:
        pdf = build_learning_guide(session_id, lang)
    except KeyError as exc:
        raise HTTPException(404, "Session introuvable") from exc
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc
    filename = f"acodyslex-learning-guide-{session_id[:24]}-{lang}.pdf"
    return StreamingResponse(
        io.BytesIO(pdf), media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{filename}"', "Cache-Control": "no-store"},
    )


@app.get("/api/recordings")
def list_recordings():
    entries = []
    for item in STORAGE.glob("*.json"):
        try:
            record = json.loads(item.read_text(encoding="utf-8"))
            if (STORAGE / f"{record['id']}.wav").exists():
                entries.append(record)
        except (ValueError, KeyError, OSError):
            continue
    return sorted(entries, key=lambda e: e["created_at"], reverse=True)


@app.delete("/api/reset")
def reset_application():
    """Delete the local prototype's learner data and locally stored WAV files."""
    removed_profiles = progress_service.reset_all_data()
    removed_recordings = 0
    for pattern in ("*.wav", "*.json"):
        for item in STORAGE.glob(pattern):
            try:
                item.unlink()
                removed_recordings += 1
            except OSError as exc:
                raise HTTPException(500, "Impossible de supprimer toutes les données locales") from exc
    return {"status": "reset", "removed_profiles": removed_profiles, "removed_recording_files": removed_recordings}


@app.post("/api/recordings", status_code=201)
async def save_recording(
    file: UploadFile = File(...),
    learner_code: str = Form(...),
    target_text: str = Form(...),
    expected_phonemes: str = Form(""),
    verified_error_type: str = Form(""),
    local_consent: bool = Form(False),
    session_id: str | None = Form(None),
    word_id: str | None = Form(None),
):
    if not local_consent:
        raise HTTPException(403, "Autorisation de sauvegarde requise")
    learner_code = learner_code.strip()
    target_text = target_text.strip()
    expected_phonemes = expected_phonemes.strip()
    session_id = session_id.strip() if session_id else None
    word_id = word_id.strip() if word_id else None

    
    reference_source = "manual" if expected_phonemes else "missing"
    reference_warning = None

    if expected_phonemes:
        try:
            tokens = validate_manual_phonemes(expected_phonemes)
            expected_phonemes = " ".join(tokens)
        except G2PError as exc:
            raise HTTPException(400, str(exc)) from exc
    else:
        try:
            tokens = arabic_to_model_phonemes(target_text)
            expected_phonemes = " ".join(tokens)
            reference_source = G2P_VERSION
        except G2PError as exc:
            reference_warning = str(exc)


    if not (1 <= len(learner_code) <= 40) or any(c not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-" for c in learner_code):
        raise HTTPException(400, "Utiliser un code anonyme (lettres, chiffres, tiret)")
    if not (1 <= len(target_text) <= 300) or len(expected_phonemes) > 1000:
        raise HTTPException(400, "Texte de référence ou phonèmes invalides")
    if verified_error_type not in {"", "inversion", "omission", "insertion", "substitution"}:
        raise HTTPException(400, "Type d'erreur non reconnu")
    for label, value in (("session_id", session_id), ("word_id", word_id)):
        if value is not None and (len(value) > 64 or any(c not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-" for c in value)):
            raise HTTPException(400, f"{label} pseudonyme invalide")
    if not (file.filename or "").lower().endswith(".wav"):
        raise HTTPException(400, "Le fichier doit avoir l'extension .wav")
    data = await file.read(MAX_WAV_BYTES + 1)
    duration = wav_duration(data)
    audio_quality = wav_quality(data)

    record_id = str(uuid4())
    meta = {
        "id": record_id,
        "learner_code": learner_code,
        "target_text": target_text,
        "expected_phonemes": expected_phonemes,
        "verified_error_type": verified_error_type,
        "duration_seconds": duration,
        **audio_quality,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "reference_source": reference_source,
        "reference_warning": reference_warning,
        "session_id": session_id,
        "word_id": word_id,
    }
    meta.update(reference_metadata(meta))
    metadata_path, audio_path = get_paths(record_id)
    audio_path.write_bytes(data)
    metadata_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return meta


@app.get("/api/recordings/{record_id}/audio")
def fetch_audio(record_id: str):
    read_metadata(record_id)
    _, audio_path = get_paths(record_id)
    return FileResponse(audio_path, media_type="audio/wav", filename=f"{record_id}.wav")


@app.delete("/api/recordings/{record_id}")
def delete_recording(record_id: str):
    read_metadata(record_id)
    meta_path, wav_path = get_paths(record_id)
    wav_path.unlink()
    meta_path.unlink()
    return {"status": "deleted", "id": record_id}


def _run_whisper(audio_path: Path) -> str:
    """Optional separate local transcript, never used to infer confirmed errors."""
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise RuntimeError("Installer requirements-whisper.txt") from exc
    model_name = os.getenv("ACODYSLEX_WHISPER_MODEL", "tiny")
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, _info = model.transcribe(str(audio_path), language="ar", beam_size=3)
    return " ".join(seg.text.strip() for seg in segments).strip()


def reference_metadata(record: dict) -> dict:
    """Saved references are provisional; manual input is not human verification."""
    source = record.get("reference_source") or (
        "manual" if record.get("expected_phonemes") else "missing"
    )
    if not record.get("expected_phonemes"):
        validation_status = "missing"
    elif source.startswith("g2p_"):
        validation_status = "g2p_provisional"
    else:
        validation_status = "provided_unverified"
    return {
        "reference_source": source,
        "reference_warning": record.get("reference_warning"),
        "reference_validation_status": validation_status,
    }


def recommendation_observations(result: dict, record: dict) -> list[dict]:
    """Expose ASR error candidates as unverified review items, never confirmed errors."""
    classification = result.get("phoneme_classification")
    if not isinstance(classification, dict) or classification.get("status") != "candidate_only":
        return []
    analysis = classification.get("analysis")
    errors = analysis.get("errors") if isinstance(analysis, dict) else None
    if not isinstance(errors, list):
        return []
    allowed = {"inversion", "omission", "insertion", "consonant_substitution", "short_vowel_confusion", "long_vowel_confusion"}
    observations = []
    for item in errors:
        if not isinstance(item, dict):
            continue
        candidate_type = item.get("type")
        observations.append({
            "error_type": candidate_type if candidate_type in allowed else None,
            "target": record.get("target_text"),
            "observed": " ".join(token for token in item.get("observed_tokens", []) if isinstance(token, str)) if isinstance(item.get("observed_tokens"), list) else None,
            "count": 1,
            # One ASR comparison does not establish the number of reading opportunities.
            "opportunities": 0,
            "distinct_items": 1,
            "verification_status": "automated_unverified",
            "provenance": "phoneme_classification_candidate",
        })
    return observations


def _batch_request_fingerprint(manifest: BatchManifest, audio_items: list[bytes]) -> str:
    digest = hashlib.sha256(manifest.model_dump_json().encode("utf-8"))
    for data in audio_items:
        digest.update(hashlib.sha256(data).digest())
    return digest.hexdigest()


def _normalize_batch_word(raw: dict, word, duration: float, analysis_id: str) -> BatchWordResult:
    if not isinstance(raw, dict):
        raise HTTPException(502, "Modal a retourné un résultat de mot invalide")
    if raw.get("word_id") != word.word_id or raw.get("word_order") != word.word_order:
        raise HTTPException(502, "Modal a modifié l'association entre un audio et son mot")
    if raw.get("reference_text", word.reference_text) != word.reference_text:
        raise HTTPException(502, "Modal a retourné un texte de référence incohérent")
    status = raw.get("analysis_status", raw.get("status", "failed"))
    if status == "success":
        status = "ok"
    if status not in {"ok", "failed", "insufficient_audio"}:
        raise HTTPException(502, "Modal a retourné un statut d'analyse inconnu")
    candidates = raw.get("recommendation_observations") or raw.get("candidate_errors") or []
    if not isinstance(candidates, list):
        raise HTTPException(502, "Modal a retourné des erreurs candidates invalides")
    expected = raw.get("expected_phonemes") or word.expected_phonemes
    predicted = raw.get("predicted_phonemes") or []
    if isinstance(expected, str):
        expected = expected.split()
    if not isinstance(expected, list) or not isinstance(predicted, list):
        raise HTTPException(502, "Modal a retourné des phonèmes invalides")
    acoustics = raw.get("acoustics") if isinstance(raw.get("acoustics"), dict) else {}
    return BatchWordResult(
        word_id=word.word_id,
        unit_id=word.unit_id,
        unit_type=word.unit_type,
        word_order=word.word_order,
        reference_text=word.reference_text,
        recognized_text=raw.get("recognized_text") or raw.get("whisper_transcript"),
        analysis_status=status,
        candidate_errors=candidates,
        expected_phonemes=[str(item) for item in expected],
        phonemes_by_word=raw.get("phonemes_by_word") if isinstance(raw.get("phonemes_by_word"), list) else word.phonemes_by_word,
        predicted_phonemes=[str(item) for item in predicted],
        phoneme_classification=raw.get("phoneme_classification") if isinstance(raw.get("phoneme_classification"), dict) else None,
        lexical_candidates=raw.get("lexical_candidates") if isinstance(raw.get("lexical_candidates"), list) else [],
        word_alignment=raw.get("word_alignment") if isinstance(raw.get("word_alignment"), list) else [],
        acoustic_indicators=raw.get("acoustic_indicators") if isinstance(raw.get("acoustic_indicators"), dict) else {},
        confidence=raw.get("confidence") if isinstance(raw.get("confidence"), (int, float)) else None,
        uncertainty=raw.get("uncertainty") if isinstance(raw.get("uncertainty"), str) else None,
        duration_seconds=duration if duration else acoustics.get("duration_seconds"),
        audio_id=f"batch:{analysis_id}:{word.word_id}",
    )


@app.post("/v1/reading/analyze-batch", response_model=BatchAnalysisResponse)
async def analyze_batch(
    manifest_json: str = Form(...),
    transfer_consent: bool = Form(False),
    files: list[UploadFile] = File(...),
):
    """Validate 15 WAVs, invoke Modal once, aggregate and persist the result."""
    if not transfer_consent:
        raise HTTPException(403, "Autorisation explicite d'envoi des audios requise")
    try:
        manifest = BatchManifest.model_validate_json(manifest_json)
    except ValidationError as exc:
        raise HTTPException(422, "Manifeste de lot invalide") from exc
    if len(files) != MAX_BATCH_WORDS:
        raise HTTPException(422, "Le lot doit contenir exactement 15 fichiers WAV")
    default_word_seconds = configured_word_max_seconds()
    max_sentence_seconds = configured_sentence_max_seconds()
    audio_items: list[bytes] = []
    durations: list[float] = []
    for word_index, upload in enumerate(files, start=1):
        if upload.content_type not in {"audio/wav", "audio/x-wav", "application/octet-stream"}:
            raise HTTPException(400, "Chaque fichier doit être un WAV")
        data = await upload.read(MAX_WAV_BYTES + 1)
        duration = wav_duration(data)
        unit = manifest.words[word_index - 1]
        configured_limit = max_sentence_seconds if unit.unit_type == "short_sentence" else default_word_seconds
        max_word_seconds = min(configured_limit, unit.max_recording_seconds)
        if duration > max_word_seconds + WORD_DURATION_TOLERANCE_SECONDS:
            raise HTTPException(
                400,
                f"Mot {word_index} : durée {duration:g} s ; maximum {max_word_seconds:g} s "
                f"(+ {WORD_DURATION_TOLERANCE_SECONDS:g} s de tolérance technique)",
            )
        wav_quality(data)
        audio_items.append(data)
        durations.append(duration)
    manifest_data = manifest.model_dump(mode="json")
    request_hash = _batch_request_fingerprint(manifest, audio_items)
    existing = progress_service.claim_batch_analysis(manifest_data, request_hash)
    if existing is not None:
        return BatchAnalysisResponse.model_validate(existing)

    api_key = os.getenv("ACODYSLEX_API_KEY", "").strip()
    if not api_key:
        progress_service.fail_batch_analysis(manifest.analysis_id, manifest.session_id)
        raise HTTPException(503, "ACODYSLEX_API_KEY manquante sur le serveur local")
    modal_url = os.getenv("ACODYSLEX_MODAL_BASE_URL", DEFAULT_MODAL_URL).rstrip("/")
    if not modal_url.startswith("https://"):
        progress_service.fail_batch_analysis(manifest.analysis_id, manifest.session_id)
        raise HTTPException(503, "ACODYSLEX_MODAL_BASE_URL doit utiliser HTTPS")
    outbound_files = [
        ("files", (f"word_{word.word_order:02d}.wav", data, "audio/wav"))
        for word, data in zip(manifest.words, audio_items, strict=True)
    ]
    try:
        timeout = httpx.Timeout(300.0, connect=20.0)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            response = await client.post(
                f"{modal_url}/v1/reading/analyze-batch",
                headers={"X-AcoDyslex-Key": api_key, "Idempotency-Key": manifest.analysis_id},
                data={"manifest_json": manifest.model_dump_json()},
                files=outbound_files,
            )
    except httpx.RequestError as exc:
        progress_service.fail_batch_analysis(manifest.analysis_id, manifest.session_id)
        raise HTTPException(502, f"Modal inaccessible : {type(exc).__name__}") from exc
    if response.status_code != 200:
        progress_service.fail_batch_analysis(manifest.analysis_id, manifest.session_id)
        raise HTTPException(502, f"Modal a répondu avec HTTP {response.status_code}")
    try:
        raw = response.json()
    except ValueError as exc:
        progress_service.fail_batch_analysis(manifest.analysis_id, manifest.session_id)
        raise HTTPException(502, "Modal n'a pas retourné de JSON valide") from exc
    raw_results = raw.get("word_results") if isinstance(raw, dict) else None
    if not isinstance(raw_results, list) or len(raw_results) != MAX_BATCH_WORDS:
        progress_service.fail_batch_analysis(manifest.analysis_id, manifest.session_id)
        raise HTTPException(502, "Modal doit retourner les 15 résultats individuels")
    by_order = {item.get("word_order"): item for item in raw_results if isinstance(item, dict)}
    if set(by_order) != set(range(1, 16)):
        progress_service.fail_batch_analysis(manifest.analysis_id, manifest.session_id)
        raise HTTPException(502, "Modal a retourné des ordres manquants ou dupliqués")
    try:
        results = [
            _normalize_batch_word(by_order[word.word_order], word, duration, manifest.analysis_id)
            for word, duration in zip(manifest.words, durations, strict=True)
        ]
        ok_count = sum(item.analysis_status == "ok" for item in results)
        batch_status = "completed" if ok_count == 15 else "partial_results" if ok_count else "batch_failed"
        result = BatchAnalysisResponse(
            analysis_id=manifest.analysis_id,
            session_id=manifest.session_id,
            batch_status=batch_status,
            word_results=results,
            global_summary=build_global_summary(results),
            model_versions={str(key): str(value) for key, value in (raw.get("model_versions") or {}).items()},
            processing_metadata={
                "modal_invocations": 1,
                "inference_mode": raw.get("processing_metadata", {}).get("inference_mode", "single_invocation_sequential_inference"),
                "word_count": 15,
                "completed_at": datetime.now(timezone.utc).isoformat(),
            },
        )
    except HTTPException:
        progress_service.fail_batch_analysis(manifest.analysis_id, manifest.session_id)
        raise
    except (ValidationError, AttributeError) as exc:
        progress_service.fail_batch_analysis(manifest.analysis_id, manifest.session_id)
        raise HTTPException(502, "Modal a retourné un lot incohérent") from exc
    return progress_service.complete_batch_analysis(manifest_data, result.model_dump(mode="json"))


@app.get("/v1/reading/analyze-batch/{analysis_id}")
def read_batch_analysis(analysis_id: str):
    if not analysis_id or len(analysis_id) > 64 or not all(char.isalnum() or char in "_-" for char in analysis_id):
        raise HTTPException(422, "analysis_id invalide")
    return progress_service.get_batch_analysis(analysis_id)


@app.post("/api/recordings/{record_id}/analyze")
async def analyze(record_id: str, transfer_consent: bool = Form(False), use_whisper: bool = Form(False)):
    if not transfer_consent:
        raise HTTPException(403, "Autorisation explicite d'envoi de l'audio requise")
    record = read_metadata(record_id)

    _, audio_path = get_paths(record_id)
    api_key = os.getenv("ACODYSLEX_API_KEY", "").strip()
    if not api_key:
        raise HTTPException(503, "ACODYSLEX_API_KEY manquante sur le serveur local")
    modal_url = os.getenv("ACODYSLEX_MODAL_BASE_URL", DEFAULT_MODAL_URL).rstrip("/")
    if not modal_url.startswith("https://"):
        raise HTTPException(503, "ACODYSLEX_MODAL_BASE_URL doit utiliser HTTPS")

    fields = {
        "target_text": record["target_text"],
        "expected_phonemes": record["expected_phonemes"],
        "verified_error_type": record["verified_error_type"],
    }
    try:
        timeout = httpx.Timeout(250.0, connect=20.0)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            response = await client.post(
                f"{modal_url}/v1/reading/analyze",
                headers={"X-AcoDyslex-Key": api_key},
                data=fields,
                files={"file": ("reading.wav", audio_path.read_bytes(), "audio/wav")},
            )
    except httpx.RequestError as exc:
        raise HTTPException(502, f"Modal inaccessible : {type(exc).__name__}") from exc
    if response.status_code != 200:
        raise HTTPException(502, f"Modal a répondu avec HTTP {response.status_code}")
    try:
        result = response.json()
    except ValueError as exc:
        raise HTTPException(502, "Modal n'a pas retourné de JSON valide") from exc

    if not isinstance(result, dict) or result.get("status") != "ok":
        raise HTTPException(502, "Modal a retourné une réponse d'analyse incohérente")

    # Pass the classification through unchanged, without recomputing its counts.
    result.update(reference_metadata(record))
    classification = result.get("phoneme_classification")
    result["classification_available"] = isinstance(classification, dict) and bool(classification)
    if not result["classification_available"]:
        result["classification_note"] = "Le service Modal n'a pas fourni de classification phonémique exploitable."

    result["recording_id"] = record_id
    result["learner_code"] = record["learner_code"]
    result["recommendation_observations"] = recommendation_observations(result, record)
    result["whisper_transcript"] = None
    result["whisper_note"] = "Whisper n'est pas utilisé pour confirmer des erreurs de lecture."
    if use_whisper:
        if os.getenv("ACODYSLEX_ENABLE_WHISPER", "0") != "1":
            raise HTTPException(400, "Whisper n'est pas activé sur le serveur local")
        try:
            result["whisper_transcript"] = await asyncio.to_thread(_run_whisper, audio_path)
        except Exception as exc:
            result["whisper_note"] = f"Whisper indisponible : {type(exc).__name__}"
    return result
