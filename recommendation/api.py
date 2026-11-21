"""Validated API schemas and routes for the V0.1 pedagogical prototype."""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import sqlite3
import re
import secrets
import time
from typing import Literal
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .engine import recommend

logger = logging.getLogger("acodyslex.recommendations")
router = APIRouter(prefix="/v1/recommendations", tags=["recommendations"])

ErrorType = Literal[
    "inversion", "omission", "insertion", "consonant_substitution",
    "short_vowel_confusion", "long_vowel_confusion",
]
VerificationStatus = Literal["human_verified", "automated_unverified"]
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_RECEIPT_RE = re.compile(r"^[a-f0-9]{32}\.[a-f0-9]{64}$")
RECEIPT_TTL_SECONDS = 15 * 60
STORAGE_DIR = Path(os.getenv(
    "ACODYSLEX_STORAGE_DIR",
    Path(__file__).resolve().parents[1] / "recordings",
))
REVIEW_DB_PATH = Path(os.getenv(
    "ACODYSLEX_REVIEW_DB",
    STORAGE_DIR / ".recommendation-reviews.sqlite3",
))
REVIEW_KEY_PATH = Path(os.getenv(
    "ACODYSLEX_REVIEW_KEY_FILE",
    STORAGE_DIR / ".recommendation-review-key",
))


class ObservationFields(BaseModel):
    model_config = ConfigDict(extra="forbid")

    error_type: ErrorType | None
    target: str | None = Field(default=None, max_length=300)
    observed: str | None = Field(default=None, max_length=300)
    count: int = Field(ge=0, le=10000, strict=True)
    opportunities: int = Field(ge=0, le=10000, strict=True)
    distinct_items: int = Field(ge=0, le=10000, strict=True)
    meaning_changed: bool = False
    provenance: str = Field(default="manual_observation", min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_.:-]+$")
    language_variety: str | None = Field(default=None, max_length=80)
    dialect_context: str | None = Field(default=None, max_length=300)


class PreviewObservation(ObservationFields):
    verification_status: VerificationStatus = "automated_unverified"
    verification_provenance: str | None = Field(default=None, max_length=40)
    verified_by: str | None = Field(default=None, max_length=64)
    verification_receipt: str | None = Field(default=None, max_length=128)


class RecommendationPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    child_id: str | None = Field(default=None, max_length=64)
    session_id: str | None = Field(default=None, max_length=64)
    observations: list[PreviewObservation] = Field(default_factory=list, max_length=200)
    mastery: dict[ErrorType, float] = Field(default_factory=dict)

    @field_validator("child_id", "session_id")
    @classmethod
    def pseudonymous_identifier(cls, value: str | None) -> str | None:
        if value is not None and not _ID_RE.fullmatch(value):
            raise ValueError("Utiliser un identifiant pseudonyme (lettres, chiffres, _ ou -)")
        return value

    @field_validator("mastery")
    @classmethod
    def mastery_range(cls, value: dict[str, float]) -> dict[str, float]:
        if any(not 0.0 <= score <= 1.0 for score in value.values()):
            raise ValueError("Les valeurs de mastery doivent être comprises entre 0 et 1")
        return value

    @model_validator(mode="after")
    def require_receipt_for_human_verified(self):
        for obs in self.observations:
            if obs.verification_status == "human_verified":
                if not obs.verified_by or not obs.verification_receipt or obs.verification_provenance != "human_review":
                    raise ValueError("Une observation vérifiée doit provenir de /observations/verify")
                if not _ID_RE.fullmatch(obs.verified_by):
                    raise ValueError("verified_by doit être un identifiant pseudonyme")
                if not _RECEIPT_RE.fullmatch(obs.verification_receipt):
                    raise ValueError("Reçu de validation humaine invalide, expiré ou déjà utilisé")
        return self


class HumanVerificationRequest(ObservationFields):
    model_config = ConfigDict(extra="forbid")

    reviewer_id: str = Field(min_length=1, max_length=64)
    human_confirmed: bool

    @field_validator("reviewer_id")
    @classmethod
    def pseudonymous_reviewer(cls, value: str) -> str:
        if not _ID_RE.fullmatch(value):
            raise ValueError("Utiliser un identifiant pseudonyme de relecteur")
        return value


def _now() -> int:
    return int(time.time())


def _canonical_observation(obs: ObservationFields) -> str:
    base = ObservationFields.model_validate(obs.model_dump(include=set(ObservationFields.model_fields)))
    payload = base.model_dump(mode="json", exclude_none=False)
    return json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def _load_signing_key() -> bytes:
    """Use configured key material, or a persistent local key shared by workers/restarts."""
    configured = os.getenv("ACODYSLEX_REVIEW_SIGNING_KEY", "")
    if configured:
        return configured.encode("utf-8")

    key_path = REVIEW_KEY_PATH
    key_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(str(key_path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        key = key_path.read_bytes()
        if len(key) < 32:
            raise RuntimeError("Le fichier de clé de validation humaine est invalide")
        return key

    key = secrets.token_bytes(32)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(key)
        stream.flush()
        os.fsync(stream.fileno())
    try:
        os.chmod(key_path, 0o600)
    except OSError:
        pass  # Windows ACLs govern access; POSIX mode bits are best-effort elsewhere.
    return key


def _review_store() -> sqlite3.Connection:
    REVIEW_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(REVIEW_DB_PATH, timeout=10, isolation_level=None)
    connection.execute("PRAGMA busy_timeout = 10000")
    connection.execute(
        """CREATE TABLE IF NOT EXISTS review_receipts (
            nonce_hash TEXT PRIMARY KEY,
            observation_hash TEXT NOT NULL,
            reviewer_id TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            consumed_at INTEGER
        )"""
    )
    try:
        os.chmod(REVIEW_DB_PATH, 0o600)
    except OSError:
        pass
    return connection


def _receipt_signature(nonce: str, reviewer_id: str, observation_hash: str, expires_at: int) -> str:
    payload = json.dumps(
        [nonce, reviewer_id, observation_hash, expires_at],
        separators=(",", ":"), ensure_ascii=True,
    )
    return hmac.new(_load_signing_key(), payload.encode("ascii"), hashlib.sha256).hexdigest()


def _issue_receipt(obs: ObservationFields, reviewer_id: str) -> str:
    observation_hash = hashlib.sha256(_canonical_observation(obs).encode("utf-8")).hexdigest()
    nonce = secrets.token_hex(16)
    expires_at = _now() + RECEIPT_TTL_SECONDS
    signature = _receipt_signature(nonce, reviewer_id, observation_hash, expires_at)
    connection = _review_store()
    try:
        connection.execute(
            "INSERT INTO review_receipts (nonce_hash, observation_hash, reviewer_id, expires_at) VALUES (?, ?, ?, ?)",
            (hashlib.sha256(nonce.encode("ascii")).hexdigest(), observation_hash, reviewer_id, expires_at),
        )
    finally:
        connection.close()
    return f"{nonce}.{signature}"


def _consume_receipts(
    observations: list[PreviewObservation],
    connection: sqlite3.Connection | None = None,
) -> None:
    """Validate all attestations and atomically mark them used exactly once."""
    verified = [obs for obs in observations if obs.verification_status == "human_verified"]
    if not verified:
        return
    now = _now()
    owns_connection = connection is None
    connection = connection or _review_store()
    try:
        if owns_connection:
            connection.execute("BEGIN IMMEDIATE")
        consumed = []
        seen = set()
        for obs in verified:
            nonce, signature = obs.verification_receipt.split(".", 1)
            nonce_hash = hashlib.sha256(nonce.encode("ascii")).hexdigest()
            if nonce_hash in seen:
                raise HTTPException(422, "Reçu de validation humaine invalide, expiré ou déjà utilisé")
            seen.add(nonce_hash)
            row = connection.execute(
                "SELECT observation_hash, reviewer_id, expires_at, consumed_at FROM review_receipts WHERE nonce_hash = ?",
                (nonce_hash,),
            ).fetchone()
            observation_hash = hashlib.sha256(_canonical_observation(obs).encode("utf-8")).hexdigest()
            if row is None:
                raise HTTPException(422, "Reçu de validation humaine invalide, expiré ou déjà utilisé")
            stored_hash, reviewer_id, expires_at, consumed_at = row
            if expires_at <= now:
                raise HTTPException(422, "Reçu de validation humaine invalide, expiré ou déjà utilisé")
            if consumed_at is not None:
                raise HTTPException(422, "Reçu de validation humaine invalide, expiré ou déjà utilisé")
            if reviewer_id != obs.verified_by or stored_hash != observation_hash:
                raise HTTPException(422, "Reçu de validation humaine invalide, expiré ou déjà utilisé")
            expected = _receipt_signature(nonce, reviewer_id, stored_hash, expires_at)
            if not hmac.compare_digest(signature, expected):
                raise HTTPException(422, "Reçu de validation humaine invalide, expiré ou déjà utilisé")
            consumed.append(nonce_hash)

        for nonce_hash in consumed:
            cursor = connection.execute(
                "UPDATE review_receipts SET consumed_at = ? WHERE nonce_hash = ? AND consumed_at IS NULL AND expires_at > ?",
                (now, nonce_hash, now),
            )
            if cursor.rowcount != 1:
                raise HTTPException(422, "Reçu de validation humaine invalide, expiré ou déjà utilisé")
        if owns_connection:
            connection.execute("COMMIT")
    except Exception:
        if owns_connection and connection.in_transaction:
            connection.execute("ROLLBACK")
        raise
    finally:
        if owns_connection:
            connection.close()


@router.post("/observations/verify")
def verify_observation(payload: HumanVerificationRequest):
    """Record an explicit reviewer attestation; ASR output alone is never promoted."""
    base = ObservationFields.model_validate(payload.model_dump(exclude={"reviewer_id", "human_confirmed"}))
    if not payload.human_confirmed:
        logger.info("recommendation_review rule_version=0.1.0 reviewer_id=%s provenance=%s decision=rejected", payload.reviewer_id, payload.provenance)
        return {**base.model_dump(), "verification_status": "automated_unverified", "verification_provenance": "human_review_rejected"}
    receipt = _issue_receipt(base, payload.reviewer_id)
    logger.info("recommendation_review rule_version=0.1.0 reviewer_id=%s provenance=%s decision=confirmed", payload.reviewer_id, payload.provenance)
    return {
        **base.model_dump(), "verification_status": "human_verified",
        "verification_provenance": "human_review", "verified_by": payload.reviewer_id,
        "verification_receipt": receipt,
    }


@router.post("/preview")
def preview_recommendations(payload: RecommendationPreviewRequest):
    _consume_receipts(payload.observations)
    session = payload.model_dump(exclude={"observations"}, exclude_none=True)
    session["observations"] = [obs.model_dump(exclude_none=True) for obs in payload.observations]
    result = recommend(session)
    sources = sorted({obs.provenance for obs in payload.observations}) or ["none"]
    reasons = sorted({item.get("error_type") or "unmapped_candidate" for item in result["needs_verification"]})
    proposal_reasons = sorted(
        f"{item['taxonomy_code']}:{item['error_frequency']}"
        for item in result["individualized_recommendations"]
    )
    logger.info(
        "recommendation_preview rule_version=%s observation_provenance=%s proposal_count=%d recommendation_reasons=%s review_reasons=%s",
        result["rule_version"], ",".join(sources), len(result["individualized_recommendations"]),
        ",".join(proposal_reasons) or "none", ",".join(map(str, reasons)) or "none",
    )
    return result
