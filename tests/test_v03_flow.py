import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

import app as localapp
from recommendation import api as recommendation_api


class V03FlowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.old_db = recommendation_api.REVIEW_DB_PATH
        self.old_key = recommendation_api.REVIEW_KEY_PATH
        recommendation_api.REVIEW_DB_PATH = root / "reviews.sqlite3"
        recommendation_api.REVIEW_KEY_PATH = root / "review.key"
        self.client = TestClient(localapp.app)

    def tearDown(self):
        self.client.close()
        recommendation_api.REVIEW_DB_PATH = self.old_db
        recommendation_api.REVIEW_KEY_PATH = self.old_key
        self.temp.cleanup()

    @staticmethod
    def words(offset=0):
        return [
            {
                "word_id": f"word_{offset + index:02d}",
                "text": f"مَدْرَسَة{index}",
                "order": index,
                "role": "revision" if index <= 6 else "consolidation" if index <= 12 else "transfer",
                "category": "decoding",
                "expected_phonemes": ["m", "a"],
            }
            for index in range(1, 16)
        ]

    def create_profile(self, child_id="child_sun"):
        response = self.client.post("/v1/progress/children", json={
            "child_id": child_id, "display_name": "Lecteur Soleil", "age": 8, "sex": "unspecified",
        })
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def create_session(self, session_id="session_one", child_id="child_sun", offset=0):
        response = self.client.post("/v1/progress/sessions", json={
            "session_id": session_id, "child_id": child_id,
            "started_at": "2026-11-08T09:00:00Z", "recommendation_engine_version": "0.3.0",
            "observations": [], "recommended_exercise_ids": [], "reading_words": self.words(offset),
        })
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def verified_observation(self):
        base = {
            "error_type": "omission", "target": None, "observed": None,
            "count": 3, "opportunities": 15, "distinct_items": 3,
            "meaning_changed": False, "provenance": "v03_accompanist_review",
            "language_variety": "ar", "dialect_context": None,
        }
        issued = self.client.post("/v1/recommendations/observations/verify", json={
            **base, "reviewer_id": "adult_child_sun", "human_confirmed": True,
        })
        self.assertEqual(issued.status_code, 200, issued.text)
        receipt = issued.json()
        return {
            **base, "verification_status": "human_verified",
            "verification_provenance": "human_review", "verified_by": receipt["verified_by"],
            "verification_receipt": receipt["verification_receipt"],
        }

    def test_full_profile_reading_review_seven_exercises_and_completion(self):
        profile = self.create_profile()
        self.assertEqual(profile["display_name"], "Lecteur Soleil")
        self.assertEqual(len(self.client.get("/v1/progress/children").json()["children"]), 1)

        session = self.create_session()
        self.assertEqual(session["state"], "created")
        self.assertEqual(len(session["reading_words"]), 15)
        self.assertEqual([item["order"] for item in session["reading_words"]], list(range(1, 16)))

        for phase in ("reading", "analyzing", "review"):
            response = self.client.patch(f"/v1/progress/sessions/{session['session_id']}/state", json={
                "child_id": "child_sun", "state": phase,
            })
            self.assertEqual(response.status_code, 200, response.text)

        analysis = self.client.post("/v1/progress/sessions/session_one/words/word_01/analysis", json={
            "child_id": "child_sun", "recording_id": "recording_01", "analysis_status": "ok",
            "observed_text": None, "candidate_errors": [{"error_type": "omission"}],
        })
        self.assertEqual(analysis.status_code, 200, analysis.text)
        self.assertEqual(analysis.json()["reading_words"][0]["recording_id"], "recording_01")

        observation = self.verified_observation()
        attached = self.client.post("/v1/progress/sessions/session_one/observations", json={
            "submission_id": "review_one", "child_id": "child_sun", "observations": [observation],
        })
        self.assertEqual(attached.status_code, 200, attached.text)
        self.assertEqual(attached.json()["observations"][0]["verification_status"], "human_verified")
        # Exact retry is idempotent although the receipt has already been consumed.
        self.assertEqual(self.client.post("/v1/progress/sessions/session_one/observations", json={
            "submission_id": "review_one", "child_id": "child_sun", "observations": [observation],
        }).status_code, 200)

        recommendations = self.client.get(
            "/v1/progress/children/child_sun/recommendations?session_id=session_one"
        )
        self.assertEqual(recommendations.status_code, 200, recommendations.text)
        exercises = recommendations.json()["recommended_exercises"]
        self.assertEqual(len(exercises), 7)
        self.assertEqual(len({item["id"] for item in exercises}), 7)
        self.assertTrue(all(item["activity_family"] and item["objective_fr"] for item in exercises))
        self.assertTrue(all(item["instruction_ar"] and item["example_ar"] for item in exercises))

        fixed = self.client.post("/v1/progress/sessions/session_one/recommendations", json={
            "child_id": "child_sun", "exercise_ids": [item["id"] for item in exercises],
        })
        self.assertEqual(fixed.status_code, 200, fixed.text)
        self.assertEqual(len(fixed.json()["recommended_exercise_ids"]), 7)
        self.assertEqual(self.client.patch("/v1/progress/sessions/session_one/state", json={
            "child_id": "child_sun", "state": "remediation",
        }).status_code, 200)
        self.assertEqual(self.client.post("/v1/progress/sessions/session_one/complete", json={
            "child_id": "child_sun", "completed_at": "2026-11-08T09:25:00Z",
        }).status_code, 409)

        for index, exercise in enumerate(exercises, 1):
            attempt = self.client.post("/v1/progress/sessions/session_one/attempts", json={
                "attempt_id": f"attempt_{index}", "child_id": "child_sun",
                "exercise_id": exercise["id"], "skill": exercise["skill"],
                "correct_count": 1, "total_count": 1, "assistance_level": "light" if index == 2 else "independent",
                "evaluation_context": "practice", "item_set_id": f"set_{index}",
                "novel_items": False, "activity_family": exercise["activity_family"],
                "interaction_attempts": index, "help_used": index == 2,
                "outcome": "assisted_success" if index == 2 else "independent_success",
                "completed_at": "2026-11-08T09:20:00Z",
            })
            self.assertEqual(attempt.status_code, 201, attempt.text)
            self.assertEqual(attempt.json()["activity_family"], exercise["activity_family"])

        duplicate = self.client.post("/v1/progress/sessions/session_one/attempts", json={
            "attempt_id": "duplicate_final", "child_id": "child_sun",
            "exercise_id": exercises[0]["id"], "skill": exercises[0]["skill"],
            "correct_count": 1, "total_count": 1, "assistance_level": "independent",
            "activity_family": exercises[0]["activity_family"], "interaction_attempts": 1,
            "outcome": "independent_success", "completed_at": "2026-11-08T09:25:00Z",
        })
        self.assertEqual(duplicate.status_code, 409)

        completed = self.client.post("/v1/progress/sessions/session_one/complete", json={
            "child_id": "child_sun", "completed_at": "2026-11-08T09:30:00Z",
        })
        self.assertEqual(completed.status_code, 200, completed.text)
        self.assertEqual(completed.json()["session"]["state"], "completed")
        self.assertEqual(len(completed.json()["session"]["attempts"]), 7)

    def test_explicit_abandonment_keeps_completed_attempts_only(self):
        self.create_profile()
        self.create_session()
        for phase in ("reading", "analyzing", "review"):
            self.assertEqual(self.client.patch("/v1/progress/sessions/session_one/state", json={
                "child_id": "child_sun", "state": phase,
            }).status_code, 200)
        abandoned = self.client.patch("/v1/progress/sessions/session_one/state", json={
            "child_id": "child_sun", "state": "abandoned",
        })
        self.assertEqual(abandoned.status_code, 200, abandoned.text)
        self.assertEqual(abandoned.json()["state"], "abandoned")
        self.assertEqual(abandoned.json()["attempts"], [])

    def test_security_isolation_and_second_adapted_session(self):
        self.create_profile("child_sun")
        self.create_profile("child_moon")
        self.create_session("session_one", "child_sun")
        self.assertEqual(self.client.get("/v1/progress/children/child_moon/history").json()["total"], 0)
        self.assertEqual(self.client.patch("/v1/progress/sessions/session_one/state", json={
            "child_id": "child_moon", "state": "reading",
        }).status_code, 409)

        observation = self.verified_observation()
        tampered = {**observation, "count": 4}
        rejected = self.client.post("/v1/progress/sessions/session_one/observations", json={
            "submission_id": "tampered_review", "child_id": "child_sun", "observations": [tampered],
        })
        self.assertEqual(rejected.status_code, 422)
        attached = self.client.post("/v1/progress/sessions/session_one/observations", json={
            "submission_id": "valid_review", "child_id": "child_sun", "observations": [observation],
        })
        self.assertEqual(attached.status_code, 200, attached.text)
        reused = self.client.post("/v1/progress/sessions/session_one/observations", json={
            "submission_id": "another_review", "child_id": "child_sun", "observations": [observation],
        })
        self.assertEqual(reused.status_code, 422)

        second = self.create_session("session_two", "child_sun", offset=15)
        self.assertEqual(len(second["reading_words"]), 15)
        self.assertTrue(set(item["word_id"] for item in second["reading_words"]).isdisjoint(
            item["word_id"] for item in self.words(0)
        ))

    def test_profile_update_delete_and_invalid_reading_plan(self):
        self.create_profile()
        updated = self.client.patch("/v1/progress/children/child_sun", json={"display_name": "Lecteur Lune", "age": 9})
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["display_name"], "Lecteur Lune")
        invalid = self.client.post("/v1/progress/sessions", json={
            "session_id": "bad_words", "child_id": "child_sun", "reading_words": self.words()[:14],
        })
        self.assertEqual(invalid.status_code, 422)
        self.assertEqual(self.client.delete("/v1/progress/children/child_sun").status_code, 204)
        self.assertEqual(self.client.get("/v1/progress/children/child_sun").status_code, 404)


if __name__ == "__main__":
    unittest.main()
