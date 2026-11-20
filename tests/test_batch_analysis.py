import io
import json
import math
import os
import struct
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

import app as localapp
from recommendation import api as recommendation_api


def wav_bytes(seconds=0.25):
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(16000)
        audio.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / 16000))) for i in range(int(16000 * seconds))))
    return output.getvalue()


class BatchAnalysisTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.old_db, self.old_key = recommendation_api.REVIEW_DB_PATH, recommendation_api.REVIEW_KEY_PATH
        recommendation_api.REVIEW_DB_PATH = root / "progress.sqlite3"
        recommendation_api.REVIEW_KEY_PATH = root / "review.key"
        self.addCleanup(setattr, recommendation_api, "REVIEW_DB_PATH", self.old_db)
        self.addCleanup(setattr, recommendation_api, "REVIEW_KEY_PATH", self.old_key)
        self.environment = patch.dict(os.environ, {"ACODYSLEX_API_KEY": "batch-test", "ACODYSLEX_MODAL_BASE_URL": "https://modal.invalid"})
        self.environment.start(); self.addCleanup(self.environment.stop)
        self.client = TestClient(localapp.app); self.addCleanup(self.client.close)
        self.words = [{"word_id": f"word_{i:02d}", "text": f"كِتَاب{i}", "order": i,
                       "role": "revision" if i <= 6 else "consolidation" if i <= 12 else "transfer",
                       "category": "decoding", "expected_phonemes": ["k", "a"],
                       "expected_phonemes_ar": [
                           {"symbol": "k", "arabic": "ك", "name_ar": "الكاف", "category": "consonne", "mapping_status": "documente_dans_recapitulatif"},
                           {"symbol": "a", "arabic": "َ", "name_ar": "الفتحة", "category": "voyelle_courte", "mapping_status": "documente_dans_recapitulatif"},
                       ]} for i in range(1, 16)]
        self.client.post("/v1/progress/children", json={"child_id": "child_batch", "display_name": "Test", "age": 8})
        created = self.client.post("/v1/progress/sessions", json={"session_id": "session_batch", "child_id": "child_batch", "reading_words": self.words})
        self.assertEqual(created.status_code, 201, created.text)
        self.assertEqual(created.json()["reading_words"][0]["expected_phonemes_ar"], self.words[0]["expected_phonemes_ar"])
        ready = self.client.patch("/v1/progress/sessions/session_batch/state", json={"child_id": "child_batch", "state": "recording"})
        self.assertEqual(ready.status_code, 200, ready.text)
        self.assertEqual(self.client.patch("/v1/progress/sessions/session_batch/state", json={"child_id": "child_batch", "state": "ready_to_analyze"}).status_code, 200)
        self.calls = []

    def manifest(self, analysis_id="batch_one"):
        return {"analysis_id": analysis_id, "child_id": "child_batch", "session_id": "session_batch",
                "words": [{"word_id": word["word_id"], "word_order": word["order"],
                           "reference_text": word["text"], "expected_phonemes": word["expected_phonemes"]}
                          for word in self.words]}

    def modal_payload(self, failed_order=None):
        return {"word_results": [{"word_id": word["word_id"], "word_order": word["order"],
                "reference_text": word["text"], "analysis_status": "failed" if word["order"] == failed_order else "ok",
                "expected_phonemes": ["k", "a"], "predicted_phonemes": ["k"],
                "candidate_errors": [{"type": "omission", "count": 2}] if word["order"] in {1, 2} else [],
                "uncertainty": "audio faible" if word["order"] == failed_order else None}
                for word in self.words], "model_versions": {"acoustic": "mock-1"},
                "processing_metadata": {"inference_mode": "single_invocation_sequential_inference"}}

    def post(self, payload=None, manifest=None):
        def handler(request):
            self.calls.append(request)
            self.assertEqual(str(request.url), "https://modal.invalid/v1/reading/analyze-batch")
            self.assertEqual(request.headers["Idempotency-Key"], (manifest or self.manifest())["analysis_id"])
            self.assertEqual(request.content.count(b"RIFF"), 15)
            return httpx.Response(200, json=payload or self.modal_payload())
        original = httpx.AsyncClient
        def client(**kwargs): return original(transport=httpx.MockTransport(handler), **kwargs)
        files = [("files", (f"word_{i:02d}.wav", wav_bytes(), "audio/wav")) for i in range(1, 16)]
        with patch.object(localapp.httpx, "AsyncClient", side_effect=client):
            return self.client.post("/v1/reading/analyze-batch", data={"manifest_json": json.dumps(manifest or self.manifest(), ensure_ascii=False), "transfer_consent": "true"}, files=files)

    def test_one_modal_invocation_associations_summary_and_idempotency(self):
        first = self.post()
        self.assertEqual(first.status_code, 200, first.text)
        result = first.json()
        self.assertEqual(result["batch_status"], "completed")
        self.assertEqual(len(result["word_results"]), 15)
        self.assertEqual([item["word_id"] for item in result["word_results"]], [word["word_id"] for word in self.words])
        self.assertEqual(result["global_summary"]["candidate_error_count"], 4)
        self.assertEqual(result["global_summary"]["words_with_candidates"], 2)
        self.assertEqual(result["global_summary"]["error_type_word_frequencies"]["omission"], 2)
        second = self.post()
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(second.json(), result)
        self.assertEqual(len(self.calls), 1)
        stored = self.client.get("/v1/reading/analyze-batch/batch_one")
        self.assertEqual(stored.status_code, 200)
        self.assertEqual(stored.json(), result)
        history = self.client.get("/v1/progress/children/child_batch/history")
        self.assertEqual(history.status_code, 200, history.text)
        self.assertEqual(history.json()["sessions"][0]["reading_words"][0]["predicted_phonemes"], ["k"])

    def test_partial_results_are_preserved(self):
        response = self.post(self.modal_payload(failed_order=7))
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual(result["batch_status"], "partial_results")
        self.assertEqual(result["global_summary"]["analyzed_words"], 14)
        self.assertEqual(result["global_summary"]["unusable_words"], 1)
        self.assertEqual(result["word_results"][6]["analysis_status"], "failed")
        review = self.client.patch("/v1/progress/sessions/session_batch/state", json={"child_id": "child_batch", "state": "review"})
        self.assertEqual(review.status_code, 200, review.text)

    def test_rejects_incomplete_tampered_or_misassociated_batches(self):
        files = [("files", (f"word_{i}.wav", wav_bytes(), "audio/wav")) for i in range(14)]
        incomplete = self.client.post("/v1/reading/analyze-batch", data={"manifest_json": json.dumps(self.manifest()), "transfer_consent": "true"}, files=files)
        self.assertEqual(incomplete.status_code, 422)
        tampered = self.manifest(); tampered["words"][0]["reference_text"] = "مختلف"
        rejected = self.post(manifest=tampered)
        self.assertEqual(rejected.status_code, 409)
        self.assertEqual(len(self.calls), 0)

    def test_consent_and_duration_limits_are_enforced(self):
        files = [("files", (f"word_{i}.wav", wav_bytes(), "audio/wav")) for i in range(15)]
        denied = self.client.post("/v1/reading/analyze-batch", data={"manifest_json": json.dumps(self.manifest()), "transfer_consent": "false"}, files=files)
        self.assertEqual(denied.status_code, 403)
        files[0] = ("files", ("too_long.wav", wav_bytes(10.3), "audio/wav"))
        too_long = self.client.post("/v1/reading/analyze-batch", data={"manifest_json": json.dumps(self.manifest()), "transfer_consent": "true"}, files=files)
        self.assertEqual(too_long.status_code, 400)
        self.assertIn("Mot 1", too_long.json()["detail"])
        self.assertIn("10.3 s", too_long.json()["detail"])

    def test_browser_finalization_tolerance_is_accepted(self):
        """A timer tick may append one final PCM block just after the 10 s limit."""
        files = [("files", (f"word_{i}.wav", wav_bytes(10.1), "audio/wav")) for i in range(15)]

        def handler(request):
            self.calls.append(request)
            return httpx.Response(200, json=self.modal_payload())

        original = httpx.AsyncClient
        def client(**kwargs): return original(transport=httpx.MockTransport(handler), **kwargs)
        with patch.object(localapp.httpx, "AsyncClient", side_effect=client):
            response = self.client.post(
                "/v1/reading/analyze-batch",
                data={"manifest_json": json.dumps(self.manifest("batch_browser_tolerance")), "transfer_consent": "true"},
                files=files,
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(self.calls), 1)

    def test_v04_mixed_units_preserve_type_and_sentence_evidence(self):
        mixed = []
        for index in range(1, 16):
            sentence = index > 10
            mixed.append({
                "word_id": f"unit_{index:02d}", "unit_id": f"unit_{index:02d}",
                "unit_type": "short_sentence" if sentence else "word",
                "text": "alpha beta" if sentence else f"word{index}", "order": index,
                "role": "revision" if index <= 6 else "consolidation" if index <= 12 else "transfer",
                "category": "sentence_reading" if sentence else "decoding",
                "expected_phonemes": ["a"], "word_count": 2 if sentence else 1,
                "difficulty_level": 2 if sentence else 1,
                "target_skills": ["controlled_decoding"], "language_variety": "ar-MSA",
                "max_recording_seconds": 15 if sentence else 10,
            })
        created = self.client.post("/v1/progress/sessions", json={
            "session_id": "session_mixed", "child_id": "child_batch", "reading_words": mixed,
        })
        self.assertEqual(created.status_code, 201, created.text)
        for state in ("recording", "ready_to_analyze"):
            response = self.client.patch("/v1/progress/sessions/session_mixed/state", json={"child_id": "child_batch", "state": state})
            self.assertEqual(response.status_code, 200, response.text)
        manifest = {"analysis_id": "batch_mixed", "child_id": "child_batch", "session_id": "session_mixed", "words": [
            {"word_id": unit["word_id"], "unit_id": unit["unit_id"], "unit_type": unit["unit_type"],
             "word_order": unit["order"], "reference_text": unit["text"],
             "expected_phonemes": unit["expected_phonemes"], "word_count": unit["word_count"],
             "max_recording_seconds": unit["max_recording_seconds"]} for unit in mixed
        ]}
        modal = {"word_results": [{
            "word_id": unit["word_id"], "word_order": unit["order"], "reference_text": unit["text"],
            "analysis_status": "ok", "expected_phonemes": ["a"], "predicted_phonemes": ["a"],
            "lexical_candidates": [{"text": "alpha beta", "confidence": .8}] if unit["unit_type"] == "short_sentence" else [],
            "word_alignment": [{"reference": "alpha", "observed": "alpha"}] if unit["unit_type"] == "short_sentence" else [],
            "acoustic_indicators": {"speech_rate": 1.0},
        } for unit in mixed]}
        def handler(request):
            self.calls.append(request)
            return httpx.Response(200, json=modal)
        original = httpx.AsyncClient
        def client(**kwargs): return original(transport=httpx.MockTransport(handler), **kwargs)
        files = [("files", (f"unit_{index:02d}.wav", wav_bytes(), "audio/wav")) for index in range(1, 16)]
        with patch.object(localapp.httpx, "AsyncClient", side_effect=client):
            response = self.client.post("/v1/reading/analyze-batch", data={"manifest_json": json.dumps(manifest), "transfer_consent": "true"}, files=files)
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual(result["global_summary"]["analyzed_word_units"], 10)
        self.assertEqual(result["global_summary"]["analyzed_sentence_units"], 5)
        self.assertEqual(result["word_results"][10]["unit_type"], "short_sentence")
        self.assertEqual(result["word_results"][10]["lexical_candidates"][0]["text"], "alpha beta")


if __name__ == "__main__":
    unittest.main()
