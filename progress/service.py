"""SQLite persistence and explainable longitudinal adaptation for V0.2."""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
from collections import defaultdict
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from pydantic import ValidationError

from recommendation import api as recommendation_api
from recommendation.engine import recommend
from .remediation import enrich_catalog
from .models import (
    ChildProfileCreate,
    ChildProfileUpdate,
    ExerciseAttemptCreate,
    ObservationBatchCreate,
    PedagogicalSettings,
    RecommendationSetCreate,
    SessionComplete,
    SessionCreate,
    SessionStateUpdate,
    WordAnalysisCreate,
)

ENGINE_VERSION = "0.2.0"
ASSISTANCE_MULTIPLIER = {"independent": 1.0, "light": 0.9, "moderate": 0.75, "full": 0.5}
CATALOG_PATH = Path(__file__).resolve().parents[1] / "recommendation" / "exercises.json"
CATALOG = enrich_catalog(json.loads(CATALOG_PATH.read_text(encoding="utf-8"))["exercises"])
EXERCISES = {item["id"]: item for item in CATALOG}
SKILLS_BY_ERROR: dict[str, set[str]] = defaultdict(set)
for _exercise in CATALOG:
    SKILLS_BY_ERROR[_exercise["error_type"]].add(_exercise["skill"])


MIGRATIONS = [
    (1, """
        CREATE TABLE IF NOT EXISTS child_profiles (
            child_id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            retention_until TEXT NOT NULL,
            pedagogical_settings_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS learning_sessions (
            session_id TEXT PRIMARY KEY,
            child_id TEXT NOT NULL,
            started_at TEXT NOT NULL,
            completed_at TEXT,
            status TEXT NOT NULL CHECK (status IN ('open', 'completed')),
            recommendation_engine_version TEXT NOT NULL,
            pedagogical_settings_json TEXT NOT NULL,
            request_fingerprint TEXT NOT NULL,
            FOREIGN KEY (child_id) REFERENCES child_profiles(child_id) ON DELETE CASCADE,
            UNIQUE (session_id, child_id)
        );
        CREATE TABLE IF NOT EXISTS session_observations (
            observation_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            error_type TEXT,
            count INTEGER NOT NULL CHECK (count >= 0),
            opportunities INTEGER NOT NULL CHECK (opportunities >= 0),
            distinct_items INTEGER NOT NULL CHECK (distinct_items >= 0),
            verification_status TEXT NOT NULL CHECK (verification_status IN ('human_verified', 'automated_unverified')),
            provenance TEXT NOT NULL,
            FOREIGN KEY (session_id) REFERENCES learning_sessions(session_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS exercise_attempts (
            attempt_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            child_id TEXT NOT NULL,
            exercise_id TEXT NOT NULL,
            skill TEXT NOT NULL,
            correct_count INTEGER NOT NULL CHECK (correct_count >= 0),
            total_count INTEGER NOT NULL CHECK (total_count > 0 AND correct_count <= total_count),
            assistance_level TEXT NOT NULL CHECK (assistance_level IN ('independent', 'light', 'moderate', 'full')),
            completed_at TEXT NOT NULL,
            request_fingerprint TEXT NOT NULL,
            FOREIGN KEY (session_id, child_id) REFERENCES learning_sessions(session_id, child_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS skill_progress (
            child_id TEXT NOT NULL,
            skill TEXT NOT NULL,
            mastery_estimate REAL NOT NULL CHECK (mastery_estimate >= 0 AND mastery_estimate <= 1),
            evidence_count INTEGER NOT NULL CHECK (evidence_count >= 0),
            updated_at TEXT NOT NULL,
            PRIMARY KEY (child_id, skill),
            FOREIGN KEY (child_id) REFERENCES child_profiles(child_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS skill_progress_events (
            event_id INTEGER PRIMARY KEY AUTOINCREMENT,
            child_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            skill TEXT NOT NULL,
            previous_mastery REAL NOT NULL,
            resulting_mastery REAL NOT NULL,
            effective_performance REAL NOT NULL,
            evidence_added INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (child_id) REFERENCES child_profiles(child_id) ON DELETE CASCADE,
            FOREIGN KEY (session_id) REFERENCES learning_sessions(session_id) ON DELETE CASCADE,
            UNIQUE (session_id, skill)
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_child_started ON learning_sessions(child_id, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_observations_session ON session_observations(session_id);
        CREATE INDEX IF NOT EXISTS idx_attempts_session ON exercise_attempts(session_id);
        CREATE INDEX IF NOT EXISTS idx_attempts_child_skill ON exercise_attempts(child_id, skill, completed_at DESC);
    """),
    (2, """
        CREATE TABLE IF NOT EXISTS session_recommendations (
            session_id TEXT NOT NULL,
            exercise_id TEXT NOT NULL,
            recommendation_rank INTEGER NOT NULL CHECK (recommendation_rank >= 1),
            PRIMARY KEY (session_id, exercise_id),
            FOREIGN KEY (session_id) REFERENCES learning_sessions(session_id) ON DELETE CASCADE
        );
        ALTER TABLE exercise_attempts ADD COLUMN evaluation_context TEXT NOT NULL DEFAULT 'practice';
        ALTER TABLE exercise_attempts ADD COLUMN item_set_id TEXT;
        ALTER TABLE exercise_attempts ADD COLUMN novel_items INTEGER NOT NULL DEFAULT 0 CHECK (novel_items IN (0, 1));
        CREATE INDEX IF NOT EXISTS idx_session_recommendations_session ON session_recommendations(session_id, recommendation_rank);
    """),
    (3, """
        ALTER TABLE child_profiles ADD COLUMN display_name TEXT;
        ALTER TABLE child_profiles ADD COLUMN age INTEGER;
        ALTER TABLE child_profiles ADD COLUMN sex TEXT;
        ALTER TABLE learning_sessions ADD COLUMN state TEXT NOT NULL DEFAULT 'created';
        CREATE TABLE IF NOT EXISTS session_reading_words (
            session_id TEXT NOT NULL,
            word_id TEXT NOT NULL,
            word_text TEXT NOT NULL,
            word_order INTEGER NOT NULL CHECK (word_order BETWEEN 1 AND 15),
            role TEXT NOT NULL CHECK (role IN ('revision', 'consolidation', 'transfer')),
            category TEXT NOT NULL,
            expected_phonemes_json TEXT NOT NULL,
            recording_id TEXT,
            analysis_status TEXT,
            observed_text TEXT,
            candidate_errors_json TEXT NOT NULL DEFAULT '[]',
            analyzed_at TEXT,
            PRIMARY KEY (session_id, word_id),
            UNIQUE (session_id, word_order),
            FOREIGN KEY (session_id) REFERENCES learning_sessions(session_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS observation_submissions (
            submission_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            request_fingerprint TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (session_id) REFERENCES learning_sessions(session_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_reading_words_session ON session_reading_words(session_id, word_order);
    """),
    (4, """
        CREATE TABLE IF NOT EXISTS batch_analyses (
            analysis_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            child_id TEXT NOT NULL,
            request_fingerprint TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'partial_results', 'batch_failed')),
            result_json TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (session_id, child_id) REFERENCES learning_sessions(session_id, child_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS batch_word_results (
            analysis_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            word_id TEXT NOT NULL,
            word_order INTEGER NOT NULL CHECK (word_order BETWEEN 1 AND 15),
            analysis_status TEXT NOT NULL,
            result_json TEXT NOT NULL,
            PRIMARY KEY (analysis_id, word_id),
            UNIQUE (analysis_id, word_order),
            FOREIGN KEY (analysis_id) REFERENCES batch_analyses(analysis_id) ON DELETE CASCADE,
            FOREIGN KEY (session_id, word_id) REFERENCES session_reading_words(session_id, word_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_batch_session ON batch_analyses(session_id, created_at DESC);
    """),
    (5, """
        ALTER TABLE exercise_attempts ADD COLUMN activity_family TEXT;
        ALTER TABLE exercise_attempts ADD COLUMN interaction_attempts INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE exercise_attempts ADD COLUMN help_used INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE exercise_attempts ADD COLUMN outcome TEXT;
    """),
    (6, """
        ALTER TABLE child_profiles ADD COLUMN avatar_id TEXT NOT NULL DEFAULT 'neutral';
    """),
    (7, """
        ALTER TABLE session_reading_words ADD COLUMN unit_type TEXT NOT NULL DEFAULT 'word';
        ALTER TABLE session_reading_words ADD COLUMN word_count INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE session_reading_words ADD COLUMN difficulty_level INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE session_reading_words ADD COLUMN target_skills_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE session_reading_words ADD COLUMN language_variety TEXT NOT NULL DEFAULT 'ar-MSA';
        ALTER TABLE session_reading_words ADD COLUMN max_recording_seconds REAL NOT NULL DEFAULT 10;
    """),
    (8, """
        ALTER TABLE session_reading_words ADD COLUMN phonemes_by_word_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE session_reading_words ADD COLUMN phoneme_reference_status TEXT NOT NULL DEFAULT 'missing';
        ALTER TABLE session_reading_words ADD COLUMN requires_linguistic_review INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE session_reading_words ADD COLUMN reference_warnings_json TEXT NOT NULL DEFAULT '[]';
    """),
    (9, """
        ALTER TABLE exercise_attempts ADD COLUMN activity_id TEXT;
        CREATE INDEX IF NOT EXISTS idx_attempts_activity ON exercise_attempts(session_id, activity_id, completed_at DESC);
    """),
    (10, """
        ALTER TABLE session_reading_words ADD COLUMN expected_phonemes_ar_json TEXT NOT NULL DEFAULT '[]';
    """),
]


def database_path() -> Path:
    # Progress and one-use receipts intentionally share a database so session
    # creation and receipt consumption can commit atomically.
    return recommendation_api.REVIEW_DB_PATH


def connect() -> sqlite3.Connection:
    path = database_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=10, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 10000")
    try:
        connection.execute("PRAGMA journal_mode = WAL")
    except sqlite3.OperationalError as exc:
        # Another worker may be establishing WAL on the same new local database.
        if "locked" not in str(exc).lower():
            raise
    migrate(connection)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return connection


def migrate(connection: sqlite3.Connection) -> None:
    connection.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)")
    for version, sql in MIGRATIONS:
        connection.execute("BEGIN IMMEDIATE")
        try:
            # Check after acquiring the write lock: another request may have
            # completed this migration while this connection was waiting.
            if connection.execute(
                "SELECT 1 FROM schema_migrations WHERE version = ?", (version,),
            ).fetchone():
                connection.execute("COMMIT")
                continue
            for statement in sql.split(";"):
                if statement.strip():
                    connection.execute(statement)
            connection.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                (version, iso_now()),
            )
            connection.execute("COMMIT")
        except Exception:
            if connection.in_transaction:
                connection.execute("ROLLBACK")
            raise



def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def fingerprint(value: Any) -> str:
    if hasattr(value, "model_dump"):
        value = value.model_dump(mode="json", exclude_none=False)
    canonical = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _settings(row: sqlite3.Row) -> PedagogicalSettings:
    return PedagogicalSettings.model_validate_json(row["pedagogical_settings_json"])


def _interpret(mastery: float, settings: PedagogicalSettings) -> str:
    if mastery >= settings.mastery_threshold:
        return "signal_de_maitrise_provisoire"
    if mastery < settings.review_threshold:
        return "revision_suggeree"
    return "progression_en_cours"


def _attempt_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {key: row[key] for key in (
        "attempt_id", "session_id", "child_id", "activity_id", "exercise_id", "skill",
        "correct_count", "total_count", "assistance_level", "evaluation_context",
        "item_set_id", "activity_family", "interaction_attempts", "outcome", "completed_at",
    )} | {"novel_items": bool(row["novel_items"]), "help_used": bool(row["help_used"])}


def _session_dict(connection: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    observations = [dict(item) for item in connection.execute(
        """SELECT observation_id, error_type, count, opportunities, distinct_items,
                  verification_status, provenance
           FROM session_observations WHERE session_id = ? ORDER BY observation_id""",
        (row["session_id"],),
    )]
    attempts = [_attempt_dict(item) for item in connection.execute(
        "SELECT * FROM exercise_attempts WHERE session_id = ? ORDER BY completed_at, attempt_id",
        (row["session_id"],),
    )]
    recommended = [item[0] for item in connection.execute(
        "SELECT exercise_id FROM session_recommendations WHERE session_id = ? ORDER BY recommendation_rank",
        (row["session_id"],),
    )]
    reading_words = []
    for item in connection.execute(
        """SELECT words.*, latest_batch.result_json AS batch_result_json
           FROM session_reading_words AS words
           LEFT JOIN batch_word_results AS latest_batch
             ON latest_batch.session_id = words.session_id
            AND latest_batch.word_id = words.word_id
            AND latest_batch.analysis_id = (
                SELECT analysis_id
                FROM batch_analyses
                WHERE session_id = words.session_id
                  AND status IN ('completed', 'partial_results')
                  AND result_json IS NOT NULL
                ORDER BY updated_at DESC
                LIMIT 1
            )
           WHERE words.session_id = ?
           ORDER BY words.word_order""",
        (row["session_id"],),
    ):
        try:
            batch_result = json.loads(item["batch_result_json"]) if item["batch_result_json"] else {}
        except (TypeError, json.JSONDecodeError):
            batch_result = {}
        predicted = batch_result.get("predicted_phonemes", []) if isinstance(batch_result, dict) else []
        if not isinstance(predicted, list):
            predicted = []
        reading_words.append({
        "word_id": item["word_id"], "text": item["word_text"],
        "order": item["word_order"], "role": item["role"],
        "category": item["category"],
        "expected_phonemes": json.loads(item["expected_phonemes_json"]),
        "expected_phonemes_ar": json.loads(item["expected_phonemes_ar_json"]),
        "phonemes_by_word": json.loads(item["phonemes_by_word_json"]),
        "phoneme_reference_status": item["phoneme_reference_status"],
        "requires_linguistic_review": bool(item["requires_linguistic_review"]),
        "reference_warnings": json.loads(item["reference_warnings_json"]),
        "unit_id": item["word_id"], "unit_type": item["unit_type"],
        "word_count": item["word_count"], "difficulty_level": item["difficulty_level"],
        "target_skills": json.loads(item["target_skills_json"]),
        "language_variety": item["language_variety"],
        "max_recording_seconds": item["max_recording_seconds"],
        "recording_id": item["recording_id"], "analysis_status": item["analysis_status"],
        "observed_text": item["observed_text"],
        "predicted_phonemes": [str(token) for token in predicted],
        "candidate_errors": json.loads(item["candidate_errors_json"]),
        "analyzed_at": item["analyzed_at"],
        })
    return {
        "session_id": row["session_id"], "child_id": row["child_id"],
        "started_at": row["started_at"], "completed_at": row["completed_at"],
        "status": row["status"], "state": row["state"],
        "recommendation_engine_version": row["recommendation_engine_version"],
        "recommended_exercise_ids": recommended,
        "observations": observations, "attempts": attempts, "reading_words": reading_words,
    }


def create_session(payload: SessionCreate) -> dict[str, Any]:
    unknown_recommendations = [item for item in payload.recommended_exercise_ids if item not in EXERCISES]
    if unknown_recommendations:
        raise HTTPException(422, f"Exercice recommandé inconnu: {unknown_recommendations[0]}")
    request_hash = fingerprint(payload)
    try:
        recommendation_api.RecommendationPreviewRequest(observations=payload.observations)
    except ValidationError as exc:
        raise HTTPException(422, "Une observation human_verified exige un reçu humain authentique et inutilisé") from exc

    connection = connect()
    try:
        connection.execute("BEGIN IMMEDIATE")
        existing = connection.execute(
            "SELECT * FROM learning_sessions WHERE session_id = ?", (payload.session_id,),
        ).fetchone()
        if existing:
            if existing["request_fingerprint"] != request_hash:
                raise HTTPException(409, "session_id déjà utilisé avec des données différentes")
            connection.execute("COMMIT")
            return _session_dict(connection, existing)

        # Validation, single-use consumption and session writes share this commit.
        recommendation_api._consume_receipts(payload.observations, connection=connection)
        now = iso_now()
        current = connection.execute(
            "SELECT * FROM child_profiles WHERE child_id = ?", (payload.child_id,),
        ).fetchone()
        settings = payload.pedagogical_settings or (_settings(current) if current else PedagogicalSettings())
        retention_until = (payload.started_at.astimezone(timezone.utc) + timedelta(days=settings.retention_days)).isoformat()
        if current is None:
            connection.execute(
                """INSERT INTO child_profiles
                   (child_id, created_at, updated_at, retention_until, pedagogical_settings_json)
                   VALUES (?, ?, ?, ?, ?)""",
                (payload.child_id, now, now, retention_until, settings.model_dump_json()),
            )
        elif payload.pedagogical_settings is not None:
            connection.execute(
                "UPDATE child_profiles SET updated_at = ?, retention_until = ?, pedagogical_settings_json = ? WHERE child_id = ?",
                (now, retention_until, settings.model_dump_json(), payload.child_id),
            )

        connection.execute(
            """INSERT INTO learning_sessions
               (session_id, child_id, started_at, completed_at, status,
                recommendation_engine_version, pedagogical_settings_json, request_fingerprint)
               VALUES (?, ?, ?, NULL, 'open', ?, ?, ?)""",
            (payload.session_id, payload.child_id, iso(payload.started_at),
             payload.recommendation_engine_version, settings.model_dump_json(), request_hash),
        )
        for index, observation in enumerate(payload.observations):
            observation_id = hashlib.sha256(f"{payload.session_id}:{index}".encode()).hexdigest()[:32]
            connection.execute(
                """INSERT INTO session_observations
                   (observation_id, session_id, error_type, count, opportunities,
                    distinct_items, verification_status, provenance)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (observation_id, payload.session_id, observation.error_type, observation.count,
                 observation.opportunities, observation.distinct_items,
                 observation.verification_status, observation.provenance),
            )
        for rank, exercise_id in enumerate(payload.recommended_exercise_ids, start=1):
            connection.execute(
                "INSERT INTO session_recommendations(session_id, exercise_id, recommendation_rank) VALUES (?, ?, ?)",
                (payload.session_id, exercise_id, rank),
            )
        for word in payload.reading_words:
            connection.execute(
                """INSERT INTO session_reading_words
                   (session_id, word_id, word_text, word_order, role, category, expected_phonemes_json, expected_phonemes_ar_json,
                    phonemes_by_word_json, phoneme_reference_status, requires_linguistic_review, reference_warnings_json,
                    unit_type, word_count, difficulty_level, target_skills_json, language_variety, max_recording_seconds)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (payload.session_id, word.word_id, word.text, word.order, word.role,
                 word.category, json.dumps(word.expected_phonemes, ensure_ascii=False), json.dumps([item.model_dump() for item in word.expected_phonemes_ar], ensure_ascii=False), json.dumps([item.model_dump() for item in word.phonemes_by_word], ensure_ascii=False),
                 word.phoneme_reference_status, int(word.requires_linguistic_review), json.dumps(word.reference_warnings, ensure_ascii=False), word.unit_type,
                 word.word_count, word.difficulty_level, json.dumps(word.target_skills, ensure_ascii=False),
                 word.language_variety, word.max_recording_seconds),
            )
        connection.execute("COMMIT")
        row = connection.execute("SELECT * FROM learning_sessions WHERE session_id = ?", (payload.session_id,)).fetchone()
        return _session_dict(connection, row)
    except sqlite3.IntegrityError as exc:
        if connection.in_transaction:
            connection.execute("ROLLBACK")
        raise HTTPException(409, "Conflit lors de la création de la session") from exc
    except Exception:
        if connection.in_transaction:
            connection.execute("ROLLBACK")
        raise
    finally:
        connection.close()


def create_profile(payload: ChildProfileCreate) -> dict[str, Any]:
    connection = connect()
    try:
        now = iso_now()
        settings = PedagogicalSettings()
        retention_until = (datetime.now(timezone.utc) + timedelta(days=settings.retention_days)).isoformat()
        try:
            connection.execute(
                """INSERT INTO child_profiles
                   (child_id, created_at, updated_at, retention_until, pedagogical_settings_json,
                    display_name, age, sex, avatar_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (payload.child_id, now, now, retention_until, settings.model_dump_json(),
                 payload.display_name, payload.age, payload.sex, payload.avatar_id),
            )
        except sqlite3.IntegrityError as exc:
            raise HTTPException(409, "child_id déjà utilisé") from exc
        return get_profile(payload.child_id)
    finally:
        connection.close()


def list_profiles() -> dict[str, Any]:
    connection = connect()
    try:
        ids = [row[0] for row in connection.execute(
            "SELECT child_id FROM child_profiles ORDER BY updated_at DESC, child_id"
        )]
    finally:
        connection.close()
    return {"children": [get_profile(child_id) for child_id in ids]}


def update_profile(child_id: str, payload: ChildProfileUpdate) -> dict[str, Any]:
    values = payload.model_dump(exclude_none=True)
    if not values:
        raise HTTPException(422, "Au moins un champ doit être fourni")
    connection = connect()
    try:
        if connection.execute("SELECT 1 FROM child_profiles WHERE child_id = ?", (child_id,)).fetchone() is None:
            raise HTTPException(404, "Profil enfant introuvable")
        assignments = ", ".join(f"{key} = ?" for key in values)
        connection.execute(
            f"UPDATE child_profiles SET {assignments}, updated_at = ? WHERE child_id = ?",
            (*values.values(), iso_now(), child_id),
        )
    finally:
        connection.close()
    return get_profile(child_id)


def delete_profile(child_id: str) -> None:
    connection = connect()
    try:
        cursor = connection.execute("DELETE FROM child_profiles WHERE child_id = ?", (child_id,))
        if cursor.rowcount == 0:
            raise HTTPException(404, "Profil enfant introuvable")
    finally:
        connection.close()


def reset_all_data() -> int:
    """Erase all local learner data while retaining the database schema."""
    connection = connect()
    try:
        connection.execute("BEGIN IMMEDIATE")
        profile_count = connection.execute("SELECT COUNT(*) FROM child_profiles").fetchone()[0]
        # Foreign-key cascades clear sessions, observations, analyses, attempts and skills.
        connection.execute("DELETE FROM child_profiles")
        if connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'review_receipts'"
        ).fetchone():
            connection.execute("DELETE FROM review_receipts")
        connection.execute("COMMIT")
        return profile_count
    except Exception:
        if connection.in_transaction:
            connection.execute("ROLLBACK")
        raise
    finally:
        connection.close()


def update_session_state(session_id: str, payload: SessionStateUpdate) -> dict[str, Any]:
    allowed = {
        "created": {"created", "reading", "recording"},
        "reading": {"reading", "analyzing", "recording"},
        "analyzing": {"analyzing", "review"},
        "recording": {"recording", "paused", "ready_to_analyze", "interrupted"},
        "paused": {"paused", "recording", "interrupted"},
        "ready_to_analyze": {"ready_to_analyze", "recording", "analyzing_batch"},
        "analyzing_batch": {"analyzing_batch", "review", "partial_results", "batch_failed"},
        "batch_failed": {"batch_failed", "ready_to_analyze", "recording"},
        "partial_results": {"partial_results", "review", "ready_to_analyze"},
        "interrupted": {"interrupted", "recording", "remediation"},
        "review": {"review", "remediation", "abandoned"},
        "remediation": {"remediation", "interrupted", "abandoned"},
        # A parent may deliberately leave a session and later return to its
        # printable/onscreen activities from the learner profile.
        "abandoned": {"abandoned", "remediation"},
        "completed": {"completed"},
    }
    connection = connect()
    try:
        connection.execute("BEGIN IMMEDIATE")
        session = connection.execute("SELECT * FROM learning_sessions WHERE session_id = ?", (session_id,)).fetchone()
        if session is None:
            raise HTTPException(404, "Session introuvable")
        if session["child_id"] != payload.child_id:
            raise HTTPException(409, "La session appartient à un autre enfant")
        current = session["state"]
        if payload.state == "completed":
            raise HTTPException(409, "Utilisez la route de clôture pour terminer la session")
        if payload.state not in allowed.get(current, set()):
            raise HTTPException(409, f"Transition invalide: {current} → {payload.state}")
        connection.execute("UPDATE learning_sessions SET state = ? WHERE session_id = ?", (payload.state, session_id))
        connection.execute("COMMIT")
        return _session_dict(connection, connection.execute(
            "SELECT * FROM learning_sessions WHERE session_id = ?", (session_id,),
        ).fetchone())
    except Exception:
        if connection.in_transaction:
            connection.execute("ROLLBACK")
        raise
    finally:
        connection.close()


def add_word_analysis(session_id: str, word_id: str, payload: WordAnalysisCreate) -> dict[str, Any]:
    connection = connect()
    try:
        connection.execute("BEGIN IMMEDIATE")
        session = connection.execute("SELECT * FROM learning_sessions WHERE session_id = ?", (session_id,)).fetchone()
        if session is None:
            raise HTTPException(404, "Session introuvable")
        if session["child_id"] != payload.child_id:
            raise HTTPException(409, "La session appartient à un autre enfant")
        if session["status"] != "open":
            raise HTTPException(409, "La session est déjà clôturée")
        word = connection.execute(
            "SELECT 1 FROM session_reading_words WHERE session_id = ? AND word_id = ?",
            (session_id, word_id),
        ).fetchone()
        if word is None:
            raise HTTPException(404, "Mot introuvable dans cette session")
        connection.execute(
            """UPDATE session_reading_words SET recording_id = ?, analysis_status = ?,
               observed_text = ?, candidate_errors_json = ?, analyzed_at = ?
               WHERE session_id = ? AND word_id = ?""",
            (payload.recording_id, payload.analysis_status, payload.observed_text,
             json.dumps(payload.candidate_errors, ensure_ascii=False), iso_now(), session_id, word_id),
        )
        connection.execute("COMMIT")
        row = connection.execute("SELECT * FROM learning_sessions WHERE session_id = ?", (session_id,)).fetchone()
        return _session_dict(connection, row)
    except Exception:
        if connection.in_transaction:
            connection.execute("ROLLBACK")
        raise
    finally:
        connection.close()


def claim_batch_analysis(manifest: dict[str, Any], request_hash: str) -> dict[str, Any] | None:
    """Claim one batch for processing, or return its persisted idempotent result."""
    connection = connect()
    try:
        connection.execute("BEGIN IMMEDIATE")
        session = connection.execute(
            "SELECT * FROM learning_sessions WHERE session_id = ?", (manifest["session_id"],),
        ).fetchone()
        if session is None:
            raise HTTPException(404, "Session introuvable")
        if session["child_id"] != manifest["child_id"]:
            raise HTTPException(409, "La session appartient à un autre enfant")
        if session["status"] != "open":
            raise HTTPException(409, "La session est déjà clôturée")
        expected = [dict(row) for row in connection.execute(
            """SELECT word_id, word_text, word_order, unit_type, word_count, max_recording_seconds
               FROM session_reading_words WHERE session_id = ? ORDER BY word_order""",
            (manifest["session_id"],),
        )]
        supplied = manifest["words"]
        if len(expected) != 15 or any(
            expected[index]["word_id"] != item["word_id"]
            or expected[index]["word_order"] != item["word_order"]
            or expected[index]["word_text"] != item["reference_text"]
            or expected[index]["unit_type"] != item.get("unit_type", "word")
            or expected[index]["word_count"] != item.get("word_count", 1)
            or float(expected[index]["max_recording_seconds"]) != float(item.get("max_recording_seconds", 10))
            for index, item in enumerate(supplied)
        ):
            raise HTTPException(409, "Le manifeste ne correspond pas au plan de lecture de la session")
        existing = connection.execute(
            "SELECT * FROM batch_analyses WHERE analysis_id = ?", (manifest["analysis_id"],),
        ).fetchone()
        if existing:
            if existing["request_fingerprint"] != request_hash:
                raise HTTPException(409, "analysis_id déjà utilisé avec un lot différent")
            if existing["result_json"]:
                result = json.loads(existing["result_json"])
                connection.execute("COMMIT")
                return result
            if existing["status"] == "processing":
                raise HTTPException(409, "Ce lot est déjà en cours d'analyse")
            connection.execute(
                "UPDATE batch_analyses SET status = 'processing', updated_at = ? WHERE analysis_id = ?",
                (iso_now(), manifest["analysis_id"]),
            )
        else:
            now = iso_now()
            connection.execute(
                """INSERT INTO batch_analyses
                   (analysis_id, session_id, child_id, request_fingerprint, status, result_json, created_at, updated_at)
                   VALUES (?, ?, ?, ?, 'processing', NULL, ?, ?)""",
                (manifest["analysis_id"], manifest["session_id"], manifest["child_id"], request_hash, now, now),
            )
        connection.execute(
            "UPDATE learning_sessions SET state = 'analyzing_batch' WHERE session_id = ?",
            (manifest["session_id"],),
        )
        connection.execute("COMMIT")
        return None
    except Exception:
        if connection.in_transaction:
            connection.execute("ROLLBACK")
        raise
    finally:
        connection.close()


def complete_batch_analysis(manifest: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    """Persist the batch and all word associations in one transaction."""
    connection = connect()
    try:
        connection.execute("BEGIN IMMEDIATE")
        current = connection.execute(
            "SELECT * FROM batch_analyses WHERE analysis_id = ?", (manifest["analysis_id"],),
        ).fetchone()
        if current is None:
            raise HTTPException(409, "Lot d'analyse non réservé")
        if current["result_json"]:
            connection.execute("COMMIT")
            return json.loads(current["result_json"])
        now = iso_now()
        for item in result["word_results"]:
            encoded = json.dumps(item, ensure_ascii=False, sort_keys=True)
            connection.execute(
                """INSERT INTO batch_word_results
                   (analysis_id, session_id, word_id, word_order, analysis_status, result_json)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (manifest["analysis_id"], manifest["session_id"], item["word_id"],
                 item["word_order"], item["analysis_status"], encoded),
            )
            connection.execute(
                """UPDATE session_reading_words SET recording_id = ?, analysis_status = ?,
                   observed_text = ?, candidate_errors_json = ?, analyzed_at = ?
                   WHERE session_id = ? AND word_id = ?""",
                (item["audio_id"], item["analysis_status"], item.get("recognized_text"),
                 json.dumps(item.get("candidate_errors", []), ensure_ascii=False), now,
                 manifest["session_id"], item["word_id"]),
            )
        connection.execute(
            "UPDATE batch_analyses SET status = ?, result_json = ?, updated_at = ? WHERE analysis_id = ?",
            (result["batch_status"], json.dumps(result, ensure_ascii=False), now, manifest["analysis_id"]),
        )
        next_state = "review" if result["batch_status"] == "completed" else result["batch_status"]
        connection.execute(
            "UPDATE learning_sessions SET state = ? WHERE session_id = ?",
            (next_state, manifest["session_id"]),
        )
        connection.execute("COMMIT")
        return result
    except Exception:
        if connection.in_transaction:
            connection.execute("ROLLBACK")
        raise
    finally:
        connection.close()


def fail_batch_analysis(analysis_id: str, session_id: str) -> None:
    connection = connect()
    try:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            "UPDATE batch_analyses SET status = 'batch_failed', updated_at = ? WHERE analysis_id = ?",
            (iso_now(), analysis_id),
        )
        connection.execute(
            "UPDATE learning_sessions SET state = 'batch_failed' WHERE session_id = ? AND state = 'analyzing_batch'",
            (session_id,),
        )
        connection.execute("COMMIT")
    except Exception:
        if connection.in_transaction:
            connection.execute("ROLLBACK")
        raise
    finally:
        connection.close()


def get_batch_analysis(analysis_id: str) -> dict[str, Any]:
    connection = connect()
    try:
        row = connection.execute(
            "SELECT status, result_json FROM batch_analyses WHERE analysis_id = ?", (analysis_id,),
        ).fetchone()
        if row is None:
            raise HTTPException(404, "Lot d'analyse introuvable")
        if row["result_json"]:
            return json.loads(row["result_json"])
        return {"analysis_id": analysis_id, "batch_status": row["status"]}
    finally:
        connection.close()


def add_observations(session_id: str, payload: ObservationBatchCreate) -> dict[str, Any]:
    request_hash = fingerprint(payload)
    try:
        recommendation_api.RecommendationPreviewRequest(observations=payload.observations)
    except ValidationError as exc:
        raise HTTPException(422, "Une observation human_verified exige un reçu humain authentique et inutilisé") from exc
    connection = connect()
    try:
        connection.execute("BEGIN IMMEDIATE")
        session = connection.execute("SELECT * FROM learning_sessions WHERE session_id = ?", (session_id,)).fetchone()
        if session is None:
            raise HTTPException(404, "Session introuvable")
        if session["child_id"] != payload.child_id:
            raise HTTPException(409, "La session appartient à un autre enfant")
        if session["status"] != "open":
            raise HTTPException(409, "La session est déjà clôturée")
        existing = connection.execute(
            "SELECT * FROM observation_submissions WHERE submission_id = ?", (payload.submission_id,),
        ).fetchone()
        if existing:
            if existing["session_id"] != session_id or existing["request_fingerprint"] != request_hash:
                raise HTTPException(409, "submission_id déjà utilisé avec des données différentes")
            connection.execute("COMMIT")
            return _session_dict(connection, session)
        recommendation_api._consume_receipts(payload.observations, connection=connection)
        for index, observation in enumerate(payload.observations):
            observation_id = hashlib.sha256(
                f"{session_id}:{payload.submission_id}:{index}".encode()
            ).hexdigest()[:32]
            connection.execute(
                """INSERT INTO session_observations
                   (observation_id, session_id, error_type, count, opportunities,
                    distinct_items, verification_status, provenance)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (observation_id, session_id, observation.error_type, observation.count,
                 observation.opportunities, observation.distinct_items,
                 observation.verification_status, observation.provenance),
            )
        connection.execute(
            "INSERT INTO observation_submissions VALUES (?, ?, ?, ?)",
            (payload.submission_id, session_id, request_hash, iso_now()),
        )
        connection.execute("COMMIT")
        return _session_dict(connection, connection.execute(
            "SELECT * FROM learning_sessions WHERE session_id = ?", (session_id,),
        ).fetchone())
    except Exception:
        if connection.in_transaction:
            connection.execute("ROLLBACK")
        raise
    finally:
        connection.close()


def set_recommendations(session_id: str, payload: RecommendationSetCreate) -> dict[str, Any]:
    unknown = [item for item in payload.exercise_ids if item not in EXERCISES]
    if unknown:
        raise HTTPException(422, f"Exercice recommandé inconnu: {unknown[0]}")
    connection = connect()
    try:
        connection.execute("BEGIN IMMEDIATE")
        session = connection.execute("SELECT * FROM learning_sessions WHERE session_id = ?", (session_id,)).fetchone()
        if session is None:
            raise HTTPException(404, "Session introuvable")
        if session["child_id"] != payload.child_id:
            raise HTTPException(409, "La session appartient à un autre enfant")
        current = [row[0] for row in connection.execute(
            "SELECT exercise_id FROM session_recommendations WHERE session_id = ? ORDER BY recommendation_rank",
            (session_id,),
        )]
        if current and current != payload.exercise_ids:
            raise HTTPException(409, "Les recommandations de cette session sont déjà fixées")
        if not current:
            for rank, exercise_id in enumerate(payload.exercise_ids, 1):
                connection.execute(
                    "INSERT INTO session_recommendations VALUES (?, ?, ?)",
                    (session_id, exercise_id, rank),
                )
        connection.execute("COMMIT")
        return _session_dict(connection, connection.execute(
            "SELECT * FROM learning_sessions WHERE session_id = ?", (session_id,),
        ).fetchone())
    except Exception:
        if connection.in_transaction:
            connection.execute("ROLLBACK")
        raise
    finally:
        connection.close()


def add_attempt(session_id: str, payload: ExerciseAttemptCreate) -> dict[str, Any]:
    exercise = EXERCISES.get(payload.exercise_id)
    if exercise is None:
        raise HTTPException(422, "exercise_id inconnu dans la banque V0.1")
    if exercise["skill"] != payload.skill:
        raise HTTPException(422, "skill ne correspond pas à l'exercice")
    if payload.activity_family is not None and exercise["activity_family"] != payload.activity_family:
        raise HTTPException(422, "activity_family ne correspond pas à l'exercice")
    if payload.outcome == "independent_success" and (payload.correct_count != payload.total_count or payload.assistance_level != "independent"):
        raise HTTPException(422, "Une réussite autonome exige une réponse correcte sans assistance")
    if payload.outcome == "assisted_success" and payload.correct_count != payload.total_count:
        raise HTTPException(422, "Une réussite aidée exige une réponse correcte")
    if payload.outcome == "not_yet_success" and payload.correct_count != 0:
        raise HTTPException(422, "Une activité à reprendre doit avoir un score nul")
    request_hash = fingerprint(payload)
    connection = connect()
    try:
        connection.execute("BEGIN IMMEDIATE")
        session = connection.execute("SELECT * FROM learning_sessions WHERE session_id = ?", (session_id,)).fetchone()
        if session is None:
            raise HTTPException(404, "Session introuvable")
        if session["child_id"] != payload.child_id:
            raise HTTPException(409, "La session appartient à un autre enfant")
        if session["status"] != "open":
            raise HTTPException(409, "La session est déjà clôturée")
        if iso(payload.completed_at) < session["started_at"]:
            raise HTTPException(422, "completed_at précède le début de la session")
        existing = connection.execute("SELECT * FROM exercise_attempts WHERE attempt_id = ?", (payload.attempt_id,)).fetchone()
        if existing:
            if existing["request_fingerprint"] != request_hash or existing["session_id"] != session_id:
                raise HTTPException(409, "attempt_id déjà utilisé avec des données différentes")
            connection.execute("COMMIT")
            return _attempt_dict(existing)
        planned = [row[0] for row in connection.execute(
            "SELECT exercise_id FROM session_recommendations WHERE session_id = ? ORDER BY recommendation_rank",
            (session_id,),
        )]
        if len(planned) == 7 and payload.activity_id is None:
            if payload.exercise_id not in planned:
                raise HTTPException(409, "Cet exercice ne fait pas partie du parcours de sept activités")
            duplicate = connection.execute(
                "SELECT 1 FROM exercise_attempts WHERE session_id = ? AND exercise_id = ?",
                (session_id, payload.exercise_id),
            ).fetchone()
            if duplicate:
                raise HTTPException(409, "Une tentative finale est déjà enregistrée pour cet exercice")
        connection.execute(
            """INSERT INTO exercise_attempts
               (attempt_id, session_id, child_id, activity_id, exercise_id, skill, correct_count,
                total_count, assistance_level, completed_at, request_fingerprint,
                evaluation_context, item_set_id, novel_items, activity_family,
                interaction_attempts, help_used, outcome)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (payload.attempt_id, session_id, payload.child_id, payload.activity_id, payload.exercise_id,
             payload.skill, payload.correct_count, payload.total_count,
             payload.assistance_level, iso(payload.completed_at), request_hash,
             payload.evaluation_context, payload.item_set_id, int(payload.novel_items),
             payload.activity_family, payload.interaction_attempts, int(payload.help_used), payload.outcome),
        )
        connection.execute("COMMIT")
        return _attempt_dict(connection.execute(
            "SELECT * FROM exercise_attempts WHERE attempt_id = ?", (payload.attempt_id,),
        ).fetchone())
    except Exception:
        if connection.in_transaction:
            connection.execute("ROLLBACK")
        raise
    finally:
        connection.close()


def complete_session(session_id: str, payload: SessionComplete) -> dict[str, Any]:
    connection = connect()
    try:
        connection.execute("BEGIN IMMEDIATE")
        session = connection.execute("SELECT * FROM learning_sessions WHERE session_id = ?", (session_id,)).fetchone()
        if session is None:
            raise HTTPException(404, "Session introuvable")
        if session["child_id"] != payload.child_id:
            raise HTTPException(409, "La session appartient à un autre enfant")
        if session["status"] == "completed":
            connection.execute("COMMIT")
            return {"session": _session_dict(connection, session), "profile": get_profile(payload.child_id), "already_completed": True}
        planned_count = connection.execute(
            "SELECT COUNT(*) FROM session_recommendations WHERE session_id = ?", (session_id,),
        ).fetchone()[0]
        if planned_count == 7:
            completed_count = connection.execute(
                "SELECT COUNT(DISTINCT exercise_id) FROM exercise_attempts WHERE session_id = ?", (session_id,),
            ).fetchone()[0]
            if completed_count != 7:
                raise HTTPException(409, "Les sept exercices doivent être terminés avant de clôturer la séance")
        completed_at = iso(payload.completed_at)
        if completed_at < session["started_at"]:
            raise HTTPException(422, "completed_at précède le début de la session")
        settings = PedagogicalSettings.model_validate_json(session["pedagogical_settings_json"])
        attempts = connection.execute("SELECT * FROM exercise_attempts WHERE session_id = ?", (session_id,)).fetchall()
        # A restarted V0.5 activity creates a new, traceable run.  Keep its earlier
        # attempts in history, but use only the latest run for mastery aggregation.
        # This prevents a child who repeats an activity from being double-counted.
        latest_runs: dict[str, int] = {}
        for attempt in attempts:
            match = re.match(r"^v05_([a-z_]+)_r(\d+)_t\d+$", attempt["item_set_id"] or "")
            if match and attempt["activity_id"] == match.group(1):
                latest_runs[match.group(1)] = max(latest_runs.get(match.group(1), 0), int(match.group(2)))
        if latest_runs:
            attempts = [attempt for attempt in attempts if not (match := re.match(r"^v05_([a-z_]+)_r(\d+)_t\d+$", attempt["item_set_id"] or "")) or int(match.group(2)) == latest_runs.get(match.group(1), 0)]
        grouped: dict[str, list[sqlite3.Row]] = defaultdict(list)
        for attempt in attempts:
            grouped[attempt["skill"]].append(attempt)

        for skill, items in grouped.items():
            evidence_added = sum(item["total_count"] for item in items)
            effective = sum(
                item["correct_count"] * ASSISTANCE_MULTIPLIER[item["assistance_level"]]
                for item in items
            ) / evidence_added
            current = connection.execute(
                "SELECT * FROM skill_progress WHERE child_id = ? AND skill = ?",
                (payload.child_id, skill),
            ).fetchone()
            previous = current["mastery_estimate"] if current else settings.initial_mastery
            resulting = round(max(0.0, min(1.0, previous + settings.learning_rate * (effective - previous))), 4)
            previous_evidence = current["evidence_count"] if current else 0
            connection.execute(
                """INSERT INTO skill_progress(child_id, skill, mastery_estimate, evidence_count, updated_at)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(child_id, skill) DO UPDATE SET
                     mastery_estimate = excluded.mastery_estimate,
                     evidence_count = excluded.evidence_count,
                     updated_at = excluded.updated_at""",
                (payload.child_id, skill, resulting, previous_evidence + evidence_added, completed_at),
            )
            connection.execute(
                """INSERT INTO skill_progress_events
                   (child_id, session_id, skill, previous_mastery, resulting_mastery,
                    effective_performance, evidence_added, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (payload.child_id, session_id, skill, previous, resulting,
                 round(effective, 4), evidence_added, completed_at),
            )
        connection.execute(
            "UPDATE learning_sessions SET status = 'completed', state = 'completed', completed_at = ? WHERE session_id = ?",
            (completed_at, session_id),
        )
        connection.execute("UPDATE child_profiles SET updated_at = ? WHERE child_id = ?", (completed_at, payload.child_id))
        connection.execute("COMMIT")
        completed = connection.execute("SELECT * FROM learning_sessions WHERE session_id = ?", (session_id,)).fetchone()
        return {"session": _session_dict(connection, completed), "profile": get_profile(payload.child_id), "already_completed": False}
    except Exception:
        if connection.in_transaction:
            connection.execute("ROLLBACK")
        raise
    finally:
        connection.close()


def get_profile(child_id: str) -> dict[str, Any]:
    connection = connect()
    try:
        profile = connection.execute("SELECT * FROM child_profiles WHERE child_id = ?", (child_id,)).fetchone()
        if profile is None:
            raise HTTPException(404, "Profil enfant introuvable")
        settings = _settings(profile)
        skills = [{
            "skill": row["skill"], "mastery_estimate": row["mastery_estimate"],
            "evidence_count": row["evidence_count"], "updated_at": row["updated_at"],
            "interpretation": _interpret(row["mastery_estimate"], settings),
        } for row in connection.execute(
            "SELECT * FROM skill_progress WHERE child_id = ? ORDER BY skill", (child_id,),
        )]
        return {
            "child_id": child_id, "created_at": profile["created_at"],
            "display_name": profile["display_name"], "age": profile["age"], "sex": profile["sex"],
            "avatar_id": profile["avatar_id"] or "neutral",
            "updated_at": profile["updated_at"], "retention_until": profile["retention_until"],
            "pedagogical_settings": settings.model_dump(), "skills": skills,
            "disclaimer": "Estimations pédagogiques provisoires issues d'exercices; elles ne constituent ni une mesure clinique validée ni un diagnostic.",
        }
    finally:
        connection.close()


def get_history(child_id: str, offset: int, limit: int) -> dict[str, Any]:
    connection = connect()
    try:
        if connection.execute("SELECT 1 FROM child_profiles WHERE child_id = ?", (child_id,)).fetchone() is None:
            raise HTTPException(404, "Profil enfant introuvable")
        total = connection.execute("SELECT COUNT(*) FROM learning_sessions WHERE child_id = ?", (child_id,)).fetchone()[0]
        rows = connection.execute(
            "SELECT * FROM learning_sessions WHERE child_id = ? ORDER BY started_at, session_id LIMIT ? OFFSET ?",
            (child_id, limit, offset),
        ).fetchall()
        return {
            "child_id": child_id, "offset": offset, "limit": limit, "total": total,
            "next_offset": offset + limit if offset + limit < total else None,
            "sessions": [_session_dict(connection, row) for row in rows],
        }
    finally:
        connection.close()


def get_recommendations(child_id: str, session_id: str | None = None) -> dict[str, Any]:
    profile = get_profile(child_id)
    settings = PedagogicalSettings.model_validate(profile["pedagogical_settings"])
    skill_mastery = {item["skill"]: item["mastery_estimate"] for item in profile["skills"]}
    connection = connect()
    try:
        if session_id is not None:
            selected = connection.execute(
                "SELECT child_id FROM learning_sessions WHERE session_id = ?", (session_id,),
            ).fetchone()
            if selected is None:
                raise HTTPException(404, "Session introuvable")
            if selected["child_id"] != child_id:
                raise HTTPException(409, "La session appartient à un autre enfant")
        rows = connection.execute(
            """SELECT o.* FROM session_observations o
               JOIN learning_sessions s ON s.session_id = o.session_id
               WHERE s.child_id = ? AND (s.status = 'completed' OR s.session_id = ?)""",
            (child_id, session_id or ""),
        ).fetchall()
        aggregates: dict[tuple[str | None, str], dict[str, Any]] = {}
        for row in rows:
            key = (row["error_type"], row["verification_status"])
            item = aggregates.setdefault(key, {
                "error_type": row["error_type"], "count": 0, "opportunities": 0,
                "distinct_items": 0, "verification_status": row["verification_status"],
                "meaning_changed": False,
                "provenance": "longitudinal_human_verified" if row["verification_status"] == "human_verified" else "longitudinal_automated_unverified",
            })
            item["count"] += row["count"]
            item["opportunities"] += row["opportunities"]
            # Item identities are deliberately not retained. Using the maximum avoids
            # claiming that repeated sessions necessarily contained different items.
            item["distinct_items"] = max(item["distinct_items"], row["distinct_items"])

        mastery_by_error = {}
        for error_type, skills in SKILLS_BY_ERROR.items():
            known = [skill_mastery[skill] for skill in skills if skill in skill_mastery]
            if known:
                mastery_by_error[error_type] = sum(known) / len(known)
        result = recommend({
            "child_id": child_id, "observations": list(aggregates.values()),
            "mastery": mastery_by_error,
        }, per_domain=16)

        recent_counts = dict(connection.execute(
            """SELECT a.exercise_id, COUNT(*) FROM exercise_attempts a
               JOIN learning_sessions s ON s.session_id = a.session_id
               WHERE a.child_id = ? AND s.status = 'completed'
                 AND s.session_id IN (
                   SELECT session_id FROM learning_sessions
                   WHERE child_id = ? AND status = 'completed'
                   ORDER BY completed_at DESC LIMIT 3
                 ) GROUP BY a.exercise_id""",
            (child_id, child_id),
        ).fetchall())
    finally:
        connection.close()

    for proposal in result["individualized_recommendations"]:
        pool = [deepcopy(EXERCISES[item["id"]]) for item in proposal["exercises"]]
        def rank(exercise: dict[str, Any]):
            mastery = skill_mastery.get(exercise["skill"], settings.initial_mastery)
            mastered = mastery >= settings.mastery_threshold
            repeated = recent_counts.get(exercise["id"], 0) >= settings.max_recent_repetitions
            target_level = 2 if mastery >= 0.6 else 1
            return (mastered, repeated, abs(exercise["level"] - target_level), recent_counts.get(exercise["id"], 0), exercise["id"])
        chosen = sorted(pool, key=rank)
        reasons = []
        for exercise in chosen:
            mastery = skill_mastery.get(exercise["skill"], settings.initial_mastery)
            if mastery < settings.review_threshold:
                reason = "révision ciblée car le signal de progression reste faible"
            elif mastery >= settings.mastery_threshold:
                reason = "révision espacée; cette compétence montre un signal provisoire de maîtrise"
            else:
                reason = "difficulté adaptée à une progression en cours"
            exercise["adaptation_reason_fr"] = reason
            exercise["skill_mastery_estimate"] = round(mastery, 4)
            exercise["recent_attempt_count"] = recent_counts.get(exercise["id"], 0)
            reasons.append(f"{exercise['id']}: {reason}")
        proposal["exercises"] = chosen
        proposal["longitudinal_explanation_fr"] = "; ".join(reasons)

    selected_exercises: list[dict[str, Any]] = []
    selected_ids: set[str] = set()
    for proposal in result["individualized_recommendations"]:
        for exercise in proposal["exercises"]:
            if exercise["id"] not in selected_ids and len(selected_exercises) < 7:
                selected_exercises.append(exercise | {"recommendation_kind": "targeted"})
                selected_ids.add(exercise["id"])
    family_counts: dict[str, int] = defaultdict(int)
    for exercise in selected_exercises:
        family_counts[exercise["activity_family"]] += 1
    remaining = [deepcopy(item) for item in CATALOG if item["id"] not in selected_ids]
    structural_priority = {"inversion": 0, "omission": 1, "insertion": 2, "consonant_substitution": 3,
                           "short_vowel_confusion": 4, "long_vowel_confusion": 5}
    while len(selected_exercises) < 7 and remaining:
        exercise = min(remaining, key=lambda item: (
            recent_counts.get(item["id"], 0) >= settings.max_recent_repetitions,
            structural_priority.get(item["error_type"], 9),
            skill_mastery.get(item["skill"], settings.initial_mastery) >= settings.mastery_threshold,
            family_counts[item["activity_family"]],
            recent_counts.get(item["id"], 0), item["level"], item["id"],
        ))
        remaining.remove(exercise)
        if exercise["id"] not in selected_ids:
            exercise["adaptation_reason_fr"] = "consolidation variée en l'absence de signal vérifié suffisant"
            exercise["skill_mastery_estimate"] = round(
                skill_mastery.get(exercise["skill"], settings.initial_mastery), 4,
            )
            exercise["recent_attempt_count"] = recent_counts.get(exercise["id"], 0)
            exercise["recommendation_kind"] = "consolidation"
            selected_exercises.append(exercise)
            selected_ids.add(exercise["id"])
            family_counts[exercise["activity_family"]] += 1

    return {
        "child_id": child_id, "engine_version": ENGINE_VERSION,
        "status": result["status"], "is_medical_diagnosis": False,
        "individualized_recommendations": result["individualized_recommendations"],
        "recommended_exercises": selected_exercises,
        "needs_verification": result["needs_verification"],
        "skill_profile": profile["skills"],
        "important_note_fr": (
            "Adaptation V0.2 explicable fondée sur des observations vérifiées et des résultats d'exercices. "
            "Les estimations et seuils sont provisoires, configurables et non cliniques."
        ),
    }

