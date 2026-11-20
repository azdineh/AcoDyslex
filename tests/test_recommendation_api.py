"""Recommendation API tests use the local app and never access Modal or audio."""
import unittest
import json
import os
import tempfile
from pathlib import Path
from unittest.mock import patch
from fastapi.testclient import TestClient

import app as localapp
from recommendation import api as recommendation_api


class RecommendationApiTests(unittest.TestCase):
    def setUp(self):
        self.review_temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.review_temp.cleanup)
        self.review_db_patch = patch.object(
            recommendation_api, "REVIEW_DB_PATH", Path(self.review_temp.name) / "reviews.sqlite3",
        )
        self.review_db_patch.start()
        self.addCleanup(self.review_db_patch.stop)
        self.review_key_patch = patch.object(
            recommendation_api, "REVIEW_KEY_PATH", Path(self.review_temp.name) / "review.key",
        )
        self.review_key_patch.start()
        self.addCleanup(self.review_key_patch.stop)
        self.env_patch = patch.dict(os.environ, {"ACODYSLEX_REVIEW_SIGNING_KEY": ""})
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)
        self.client = TestClient(localapp.app)
        self.addCleanup(self.client.close)

    def observation(self, **changes):
        value = {
            "error_type": "omission", "target": "item-a/item-b", "observed": "",
            "count": 2, "opportunities": 3, "distinct_items": 2,
            "meaning_changed": False, "provenance": "reviewed_reading_session",
            "language_variety": "ar-MA", "dialect_context": "Moroccan Arabic context",
        }
        value.update(changes)
        return value

    def test_preview_defaults_to_unverified_and_proposes_nothing(self):
        response = self.client.post("/v1/recommendations/preview", json={
            "child_id": "reader_01", "session_id": "session_01",
            "observations": [self.observation()],
        })
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertFalse(result["is_medical_diagnosis"])
        self.assertEqual(result["individualized_recommendations"], [])
        self.assertTrue(result["needs_verification"])

    def test_human_review_route_signs_observation_and_preview_recommends(self):
        review = self.client.post("/v1/recommendations/observations/verify", json={
            **self.observation(), "reviewer_id": "teacher_01", "human_confirmed": True,
        })
        self.assertEqual(review.status_code, 200, review.text)
        verified = review.json()
        self.assertEqual(verified["verification_status"], "human_verified")
        result = self.client.post("/v1/recommendations/preview", json={
            "child_id": "reader_01", "session_id": "session_01", "observations": [verified],
        })
        self.assertEqual(result.status_code, 200, result.text)
        proposal = result.json()["individualized_recommendations"][0]
        self.assertEqual(proposal["taxonomy_code"], "E02")
        self.assertEqual([item["id"] for item in proposal["exercises"]], ["OMI01", "OMI02"])
        self.assertEqual(proposal["observation_provenance"], "reviewed_reading_session")

    def issue_verified_observation(self):
        response = self.client.post("/v1/recommendations/observations/verify", json={
            **self.observation(), "reviewer_id": "teacher_01", "human_confirmed": True,
        })
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def preview(self, observation):
        return self.client.post("/v1/recommendations/preview", json={
            "child_id": "reader_01", "session_id": "session_01", "observations": [observation],
        })

    def test_receipt_is_single_use(self):
        verified = self.issue_verified_observation()
        first = self.preview(verified)
        self.assertEqual(first.status_code, 200, first.text)
        second = self.preview(verified)
        self.assertEqual(second.status_code, 422, second.text)
        self.assertIn("déjà utilisé", second.json()["detail"])

    def test_tampered_receipt_and_changed_observation_are_refused(self):
        verified = self.issue_verified_observation()
        tampered = dict(verified)
        last = tampered["verification_receipt"][-1]
        tampered["verification_receipt"] = tampered["verification_receipt"][:-1] + ("a" if last != "a" else "b")
        self.assertEqual(self.preview(tampered).status_code, 422)

        changed = dict(verified)
        changed["target"] = "different-target"
        self.assertEqual(self.preview(changed).status_code, 422)
        # Rejected attempts do not consume the authentic receipt.
        self.assertEqual(self.preview(verified).status_code, 200)

    def test_expired_receipt_is_refused(self):
        verified = self.issue_verified_observation()
        expired_now = recommendation_api._now() + recommendation_api.RECEIPT_TTL_SECONDS + 1
        with patch.object(recommendation_api, "_now", return_value=expired_now):
            response = self.preview(verified)
        self.assertEqual(response.status_code, 422)
        self.assertIn("expiré", response.json()["detail"])

    def test_fallback_signing_key_is_stable_when_loaded_again(self):
        first = recommendation_api._load_signing_key()
        second = recommendation_api._load_signing_key()
        self.assertEqual(len(first), 32)
        self.assertEqual(second, first)

    def test_cannot_mark_human_verified_without_separate_review_receipt(self):
        response = self.client.post("/v1/recommendations/preview", json={
            "observations": [{**self.observation(), "verification_status": "human_verified"}],
        })
        self.assertEqual(response.status_code, 422)

    def test_invalid_denominator_rejected_by_schema(self):
        response = self.client.post("/v1/recommendations/preview", json={
            "observations": [self.observation(count=4, opportunities=3)],
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["individualized_recommendations"], [])
        self.assertTrue(response.json()["needs_verification"])

    def test_unknown_or_malformed_values_rejected(self):
        response = self.client.post("/v1/recommendations/preview", json={
            "child_id": "child@example.com", "observations": [self.observation(error_type="substitution")],
        })
        self.assertEqual(response.status_code, 422)

    def test_unverified_dialect_observation_is_not_inferred_as_error(self):
        response = self.client.post("/v1/recommendations/preview", json={
            "observations": [self.observation(
                error_type="short_vowel_confusion", count=5, opportunities=5,
                distinct_items=3, provenance="asr_candidate", language_variety="ar-MA",
                dialect_context="spoken form differs from MSA",
            )],
        })
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertFalse(result["individualized_recommendations"])
        self.assertTrue(result["needs_verification"])

    def test_empty_observations_are_valid_and_safe(self):
        response = self.client.post("/v1/recommendations/preview", json={"observations": []})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "verification_required")

    def test_source_taxonomy_and_all_sixteen_exercise_ids_are_preserved(self):
        root = Path(localapp.__file__).resolve().parent / "recommendation"
        taxonomy = json.loads((root / "taxonomy.json").read_text(encoding="utf-8"))
        exercises = json.loads((root / "exercises.json").read_text(encoding="utf-8"))
        self.assertEqual([item["code"] for item in taxonomy["error_types"]],
                         ["E01", "E02", "E03", "E04", "E05", "E06"])
        self.assertEqual(len(exercises["exercises"]), 16)
        self.assertEqual(len({item["id"] for item in exercises["exercises"]}), 16)


if __name__ == "__main__":
    unittest.main()
