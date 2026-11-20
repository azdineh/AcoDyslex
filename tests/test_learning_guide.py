from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from pypdf import PdfReader

import app as localapp
import learning_guide
from recommendation import api as recommendation_api


class LearningGuideTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.db_patch = patch.object(recommendation_api, "REVIEW_DB_PATH", root / "guide.sqlite3")
        self.key_patch = patch.object(recommendation_api, "REVIEW_KEY_PATH", root / "guide.key")
        self.db_patch.start(); self.key_patch.start(); self.addCleanup(self.db_patch.stop); self.addCleanup(self.key_patch.stop)
        self.client = TestClient(localapp.app); self.addCleanup(self.client.close)
        created = self.client.post("/v1/progress/sessions", json={
            "session_id": "guide_demo", "child_id": "guide_child", "started_at": "2026-11-01T09:00:00Z",
            "recommendation_engine_version": "0.6.0", "recommended_exercise_ids": ["OMI01", "INV01"], "observations": [],
        })
        self.assertEqual(created.status_code, 201, created.text)

    def test_generates_an_a4_arabic_guide_from_persisted_session_data(self):
        response = self.client.get("/v1/reports/sessions/guide_demo/pdf?lang=ar")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers["content-type"], "application/pdf")
        self.assertIn("inline", response.headers["content-disposition"])
        self.assertTrue(response.content.startswith(b"%PDF"))
        path = Path(self.temp.name) / "guide.pdf"; path.write_bytes(response.content)
        reader = PdfReader(path)
        # Cover + six AI-report sections (including the individual-analysis
        # fallback) + guide divider + retained printable guide content.
        self.assertEqual(len(reader.pages), 18)
        box = reader.pages[0].mediabox
        self.assertAlmostEqual(float(box.width), 595.2756, places=1)
        self.assertAlmostEqual(float(box.height), 841.8898, places=1)

    def test_unknown_session_is_not_exported(self):
        response = self.client.get("/v1/reports/sessions/not_found/pdf?lang=en")
        self.assertEqual(response.status_code, 404)

    def test_report_metrics_keep_human_verification_separate_from_asr_suggestions(self):
        context = {
            "session": {
                "observations": [
                    {"error_type": "omission", "verification_status": "human_verified", "count": 1},
                    {"error_type": "insertion", "verification_status": "automated_unverified", "count": 1},
                ],
                "reading_words": [{
                    "word_id": "word_1", "text": "كتاب", "analysis_status": "ok",
                    "candidate_errors": [{"type": "omission", "count": 2}],
                }],
            },
            "analysis": {"word_results": [{
                "word_id": "word_1", "reference_text": "كتاب", "recognized_text": "كتا",
                "analysis_status": "ok", "expected_phonemes": ["k", "a", "t", "a", "b"],
                "predicted_phonemes": ["k", "a", "t", "a"],
                "candidate_errors": [{"type": "omission", "count": 2}],
                "confidence": 0.81, "acoustic_indicators": {"speech_rate": 2.1},
            }]},
        }

        metrics = learning_guide._report_metrics(context)

        self.assertEqual(len(metrics["analyzed"]), 1)
        self.assertEqual(len(metrics["candidates"]), 1)
        self.assertEqual(len(metrics["confirmed"]), 1)
        self.assertEqual(metrics["confirmed"][0]["error_type"], "omission")

    def test_duplicate_asr_suggestions_are_collapsed(self):
        duplicate = {"type": "omission", "count": 2, "reference_position": 3}
        context = {
            "session": {"observations": [], "reading_words": [{
                "word_id": "word_1", "text": "كتاب", "analysis_status": "ok",
            }]},
            "analysis": {"word_results": [{
                "word_id": "word_1", "analysis_status": "ok",
                "candidate_errors": [duplicate, duplicate.copy()],
            }]},
        }
        self.assertEqual(len(learning_guide._report_metrics(context)["candidates"]), 1)

    def test_candidate_remarks_have_one_label_per_type(self):
        self.assertEqual(
            learning_guide._candidate_remark_types([
                {"type": "omission"}, {"type": "omission"},
                {"type": "substitution"},
            ]),
            ["omission", "substitution"],
        )

    def test_report_names_the_deployed_meta_acoustic_model_when_recorded(self):
        self.assertEqual(
            learning_guide._acoustic_model_label("MostafaMaroof/wav2vec2-arabic-phoneme-asr", "ar"),
            "Meta AI - wav2vec2-arabic-phoneme-asr",
        )
        self.assertEqual(learning_guide._acoustic_model_label(None, "en"), "Not recorded")

