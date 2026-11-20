"""End-to-end tests for the longitudinal V0.2 API with fictitious data."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import app as localapp
from recommendation import api as recommendation_api
from progress import service as progress_service


class ProgressApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        db_patch = patch.object(recommendation_api, "REVIEW_DB_PATH", root / "acodyslex.sqlite3")
        key_patch = patch.object(recommendation_api, "REVIEW_KEY_PATH", root / "review.key")
        db_patch.start(); key_patch.start()
        self.addCleanup(db_patch.stop); self.addCleanup(key_patch.stop)
        self.client = TestClient(localapp.app)
        self.addCleanup(self.client.close)

    def observation(self, status="automated_unverified", **changes):
        value = {
            "error_type": "omission", "target": "fictitious-item",
            "observed": "fictitious-response", "count": 2, "opportunities": 3,
            "distinct_items": 2, "meaning_changed": False,
            "provenance": "fictitious_session", "verification_status": status,
        }
        value.update(changes)
        return value

    def verified_observation(self, **changes):
        source = self.observation(**changes)
        source.pop("verification_status", None)
        response = self.client.post("/v1/recommendations/observations/verify", json={
            **source, "reviewer_id": "teacher_demo", "human_confirmed": True,
        })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def create_session(self, session_id, child_id="child_demo", observations=None, settings=None,
                       started_at=None, recommended=None):
        payload = {
            "session_id": session_id, "child_id": child_id,
            "started_at": started_at or "2026-11-01T09:00:00Z",
            "recommendation_engine_version": "0.2.0",
            "observations": observations or [],
            "recommended_exercise_ids": recommended or [],
        }
        if settings is not None:
            payload["pedagogical_settings"] = settings
        return self.client.post("/v1/progress/sessions", json=payload)

    def attempt(self, session_id, attempt_id, child_id="child_demo", exercise_id="OMI01",
                skill="phoneme_detection", correct=4, total=5, assistance="independent",
                completed_at="2026-11-01T09:20:00Z"):
        return self.client.post(f"/v1/progress/sessions/{session_id}/attempts", json={
            "attempt_id": attempt_id, "child_id": child_id, "exercise_id": exercise_id,
            "skill": skill, "correct_count": correct, "total_count": total,
            "assistance_level": assistance, "completed_at": completed_at,
        })

    def complete(self, session_id, child_id="child_demo", completed_at="2026-11-01T09:30:00Z"):
        return self.client.post(f"/v1/progress/sessions/{session_id}/complete", json={
            "child_id": child_id, "completed_at": completed_at,
        })

    def test_creates_profile_and_session_with_verified_observation(self):
        verified = self.verified_observation()
        response = self.create_session("session_01", observations=[verified], recommended=["OMI01", "OMI02"])
        self.assertEqual(response.status_code, 201, response.text)
        session = response.json()
        self.assertEqual(session["status"], "open")
        self.assertEqual(session["observations"][0]["verification_status"], "human_verified")
        self.assertEqual(session["recommended_exercise_ids"], ["OMI01", "OMI02"])
        profile = self.client.get("/v1/progress/children/child_demo")
        self.assertEqual(profile.status_code, 200, profile.text)
        self.assertEqual(profile.json()["skills"], [])
        self.assertEqual(profile.json()["pedagogical_settings"]["initial_mastery"], 0.5)

    def test_profile_avatar_is_validated_persisted_and_updated(self):
        created = self.client.post("/v1/progress/children", json={
            "child_id": "child_avatar", "display_name": "Lecteur test",
            "age": 8, "sex": "unspecified", "avatar_id": "mint",
        })
        self.assertEqual(created.status_code, 201, created.text)
        self.assertEqual(created.json()["avatar_id"], "mint")

        persisted = self.client.get("/v1/progress/children/child_avatar")
        self.assertEqual(persisted.status_code, 200, persisted.text)
        self.assertEqual(persisted.json()["avatar_id"], "mint")

        updated = self.client.patch("/v1/progress/children/child_avatar", json={"avatar_id": "violet"})
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["avatar_id"], "violet")

        invalid = self.client.patch("/v1/progress/children/child_avatar", json={"avatar_id": "remote-url"})
        self.assertEqual(invalid.status_code, 422, invalid.text)

    def test_session_creation_is_idempotent_without_reusing_receipt(self):
        verified = self.verified_observation()
        first = self.create_session("session_idempotent", observations=[verified])
        second = self.create_session("session_idempotent", observations=[verified])
        self.assertEqual(first.status_code, 201, first.text)
        self.assertEqual(second.status_code, 201, second.text)
        self.assertEqual(second.json(), first.json())
        changed = dict(verified); changed["count"] = 3
        conflict = self.create_session("session_idempotent", observations=[changed])
        self.assertEqual(conflict.status_code, 409)
        reused_for_new_session = self.create_session("session_other", observations=[verified])
        self.assertEqual(reused_for_new_session.status_code, 422)

    def test_human_verified_observation_requires_authentic_unused_receipt(self):
        unproven = self.observation(status="human_verified")
        response = self.create_session("session_unproven", observations=[unproven])
        self.assertEqual(response.status_code, 422)

        verified = self.verified_observation()
        preview = self.client.post("/v1/recommendations/preview", json={"observations": [verified]})
        self.assertEqual(preview.status_code, 200, preview.text)
        consumed = self.create_session("session_consumed", observations=[verified])
        self.assertEqual(consumed.status_code, 422)

    def test_failed_session_write_rolls_back_receipt_consumption(self):
        # Initialize migrations before injecting a failure inside the creation transaction.
        self.assertEqual(self.create_session("session_bootstrap").status_code, 201)
        verified = self.verified_observation()
        with patch.object(progress_service, "iso_now", side_effect=RuntimeError("synthetic write failure")):
            with self.assertRaises(RuntimeError):
                self.create_session("session_atomic", observations=[verified])
        retry = self.create_session("session_atomic", observations=[verified])
        self.assertEqual(retry.status_code, 201, retry.text)

    def test_attempt_is_idempotent_and_never_double_counted(self):
        self.assertEqual(self.create_session("session_attempt").status_code, 201)
        first = self.attempt("session_attempt", "attempt_01")
        second = self.attempt("session_attempt", "attempt_01")
        self.assertEqual(first.status_code, 201, first.text)
        self.assertEqual(second.status_code, 201, second.text)
        self.assertEqual(first.json(), second.json())
        conflict = self.attempt("session_attempt", "attempt_01", correct=3)
        self.assertEqual(conflict.status_code, 409)
        completed = self.complete("session_attempt")
        self.assertEqual(completed.status_code, 200, completed.text)
        skill = completed.json()["profile"]["skills"][0]
        self.assertEqual(skill["evidence_count"], 5)

    def test_completion_updates_mastery_once_and_preserves_evidence_event(self):
        settings = {
            "initial_mastery": 0.5, "learning_rate": 0.5,
            "mastery_threshold": 0.8, "review_threshold": 0.55,
            "max_recent_repetitions": 1, "retention_days": 365,
        }
        self.create_session("session_complete", settings=settings)
        self.attempt("session_complete", "attempt_complete", correct=5, total=5)
        first = self.complete("session_complete")
        second = self.complete("session_complete")
        self.assertEqual(first.status_code, 200, first.text)
        self.assertFalse(first.json()["already_completed"])
        self.assertTrue(second.json()["already_completed"])
        self.assertEqual(first.json()["profile"]["skills"][0]["mastery_estimate"], 0.75)
        self.assertEqual(second.json()["profile"]["skills"][0]["mastery_estimate"], 0.75)

    def test_two_session_history_is_chronological_and_paginated(self):
        self.create_session("session_a", started_at="2026-11-01T09:00:00Z")
        self.complete("session_a", completed_at="2026-11-01T09:30:00Z")
        self.create_session("session_b", started_at="2026-11-02T09:00:00Z")
        self.complete("session_b", completed_at="2026-11-02T09:30:00Z")
        page1 = self.client.get("/v1/progress/children/child_demo/history?offset=0&limit=1")
        page2 = self.client.get("/v1/progress/children/child_demo/history?offset=1&limit=1")
        self.assertEqual(page1.status_code, 200, page1.text)
        self.assertEqual(page1.json()["total"], 2)
        self.assertEqual(page1.json()["next_offset"], 1)
        self.assertEqual(page1.json()["sessions"][0]["session_id"], "session_a")
        self.assertEqual(page2.json()["sessions"][0]["session_id"], "session_b")

    def test_recommendations_adapt_after_two_successful_sessions(self):
        settings = {
            "initial_mastery": 0.5, "learning_rate": 0.5,
            "mastery_threshold": 0.8, "review_threshold": 0.55,
            "max_recent_repetitions": 1, "retention_days": 365,
        }
        first_obs = self.verified_observation()
        self.create_session("session_adapt_1", observations=[first_obs], settings=settings)
        self.attempt("session_adapt_1", "attempt_adapt_1", correct=5, total=5)
        self.complete("session_adapt_1")

        second_obs = self.verified_observation()
        self.create_session("session_adapt_2", observations=[second_obs], started_at="2026-11-02T09:00:00Z")
        self.attempt("session_adapt_2", "attempt_adapt_2", correct=5, total=5,
                     completed_at="2026-11-02T09:20:00Z")
        self.complete("session_adapt_2", completed_at="2026-11-02T09:30:00Z")

        response = self.client.get("/v1/progress/children/child_demo/recommendations")
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertFalse(result["is_medical_diagnosis"])
        self.assertEqual(result["status"], "recommendations_proposed")
        proposal = result["individualized_recommendations"][0]
        self.assertEqual(proposal["taxonomy_code"], "E02")
        self.assertNotEqual(proposal["exercises"][0]["id"], "OMI01")
        self.assertIn("longitudinal_explanation_fr", proposal)
        skill = next(item for item in result["skill_profile"] if item["skill"] == "phoneme_detection")
        self.assertGreater(skill["mastery_estimate"], 0.8)

    def test_asr_only_observations_never_generate_recommendations(self):
        unverified = self.observation(status="automated_unverified", count=20, opportunities=20, distinct_items=10)
        self.create_session("session_asr", child_id="child_asr", observations=[unverified])
        self.complete("session_asr", child_id="child_asr")
        response = self.client.get("/v1/progress/children/child_asr/recommendations")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["individualized_recommendations"], [])
        self.assertTrue(response.json()["needs_verification"])

    def test_rejects_invalid_ids_wrong_child_unknown_exercise_and_closed_session(self):
        self.assertEqual(self.create_session("bad id").status_code, 422)
        self.assertEqual(self.create_session("bad_recommendation", recommended=["UNKNOWN"]).status_code, 422)
        self.create_session("session_guard")
        self.assertEqual(self.attempt("session_guard", "attempt_wrong", child_id="other_child").status_code, 409)
        self.assertEqual(self.attempt("session_guard", "attempt_unknown", exercise_id="UNKNOWN").status_code, 422)
        self.assertEqual(self.complete("session_guard", child_id="other_child").status_code, 409)
        self.complete("session_guard")
        self.assertEqual(self.attempt("session_guard", "attempt_late").status_code, 409)

    def test_data_persists_across_testclient_restart(self):
        self.create_session("session_persistent")
        self.attempt("session_persistent", "attempt_persistent")
        self.complete("session_persistent")
        self.client.close()
        self.client = TestClient(localapp.app)
        response = self.client.get("/v1/progress/children/child_demo")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["skills"][0]["evidence_count"], 5)

    def test_children_are_isolated(self):
        self.create_session("session_child_a", child_id="child_a")
        self.attempt("session_child_a", "attempt_child_a", child_id="child_a")
        self.complete("session_child_a", child_id="child_a")
        self.create_session("session_child_b", child_id="child_b")
        history_a = self.client.get("/v1/progress/children/child_a/history").json()
        history_b = self.client.get("/v1/progress/children/child_b/history").json()
        self.assertEqual([item["session_id"] for item in history_a["sessions"]], ["session_child_a"])
        self.assertEqual([item["session_id"] for item in history_b["sessions"]], ["session_child_b"])
        self.assertEqual(self.client.post("/v1/progress/sessions/session_child_a/attempts", json={
            "attempt_id": "cross_child", "child_id": "child_b", "exercise_id": "OMI01",
            "skill": "phoneme_detection", "correct_count": 1, "total_count": 1,
            "assistance_level": "independent", "completed_at": "2026-11-01T09:20:00Z",
        }).status_code, 409)

    def test_v01_preview_route_remains_compatible(self):
        verified = self.verified_observation()
        response = self.client.post("/v1/recommendations/preview", json={
            "child_id": "legacy_child", "session_id": "legacy_session", "observations": [verified],
        })
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["engine_version"], "0.1.0")
        self.assertTrue(response.json()["individualized_recommendations"])

    def test_openapi_documents_all_v02_routes(self):
        schema = self.client.get("/openapi.json")
        self.assertEqual(schema.status_code, 200, schema.text)
        paths = schema.json()["paths"]
        expected = {
            "/v1/progress/sessions",
            "/v1/progress/sessions/{session_id}/attempts",
            "/v1/progress/sessions/{session_id}/complete",
            "/v1/progress/children/{child_id}",
            "/v1/progress/children/{child_id}/history",
            "/v1/progress/children/{child_id}/recommendations",
        }
        self.assertTrue(expected.issubset(paths))


if __name__ == "__main__":
    unittest.main()

