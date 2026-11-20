import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

import app as localapp


class AcousticModelInfoTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(localapp.app)
        self.addCleanup(self.client.close)
        self.original_async_client = httpx.AsyncClient
        self.cache_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.cache_directory.cleanup)
        self.cache_path = Path(self.cache_directory.name) / "model-info.json"

    def request_with_modal(self, health, api_version="0.3.0", requests=None):
        def handler(request):
            if requests is not None:
                requests.append(request.url.path)
            if request.url.path == "/health":
                return httpx.Response(200, json=health)
            if request.url.path == "/openapi.json":
                return httpx.Response(200, json={
                    "info": {"title": "AcoDyslex acoustic phoneme prototype", "version": api_version}
                })
            return httpx.Response(404)

        def make_client(**kwargs):
            return self.original_async_client(transport=httpx.MockTransport(handler), **kwargs)

        with patch.dict(localapp.os.environ, {
            "ACODYSLEX_MODAL_BASE_URL": "https://modal.test",
            "ACODYSLEX_MODEL_INFO_CACHE_PATH": str(self.cache_path),
        }), \
                patch.object(localapp.httpx, "AsyncClient", side_effect=make_client):
            return self.client.get("/api/acoustic-model")

    def test_model_metadata_is_saved_and_reused_without_a_second_modal_request(self):
        requests = []
        health = {
            "status": "ok",
            "deployment": "modal-single-provider",
            "model": "MostafaMaroof/wav2vec2-arabic-phoneme-asr",
        }

        first = self.request_with_modal(health, requests=requests)
        second = self.request_with_modal(health, requests=requests)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json()["cache_status"], "remote")
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json()["cache_status"], "cached")
        self.assertEqual(requests, ["/health", "/openapi.json"])

    def test_exact_runtime_model_gets_reviewed_arabic_and_meta_metadata(self):
        response = self.request_with_modal({
            "status": "ok",
            "deployment": "modal-single-provider",
            "model": "MostafaMaroof/wav2vec2-arabic-phoneme-asr",
        })

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["metadata_verified"])
        self.assertEqual(body["model_id"], "MostafaMaroof/wav2vec2-arabic-phoneme-asr")
        self.assertEqual(body["model"]["release"], "v2")
        self.assertEqual(body["model"]["publisher"], "MostafaMaroof")
        self.assertEqual(body["model"]["base_model"], "facebook/wav2vec2-large-xlsr-53")
        self.assertEqual(body["model"]["base_developer"], "Meta (Facebook AI)")
        self.assertTrue(body["model"]["base_developer_confirmed"])
        self.assertEqual(body["phoneme_presentation"]["$"], {
            "arabic": "ش", "name_ar": "الشين", "category": "consonne",
        })
        self.assertNotIn("AH", body["phoneme_presentation"])
        self.assertEqual(body["phoneme_presentation"]["sh"], {
            "arabic": "ش", "name_ar": "الشين", "category": "consonne",
        })
        self.assertIsNone(body["runtime_revision"])
        self.assertEqual(body["infrastructure"]["provider"], "Modal")
        self.assertEqual(body["infrastructure"]["api_version"], "0.3.0")

    def test_unknown_runtime_model_does_not_get_meta_or_arabic_claims(self):
        response = self.request_with_modal({
            "status": "ok", "deployment": "changed", "model": "vendor/new-model",
            "model_revision": "revision-42",
        }, api_version="1.0.0")

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertFalse(body["metadata_verified"])
        self.assertEqual(body["runtime_revision"], "revision-42")
        self.assertIsNone(body["model"]["base_developer"])
        self.assertFalse(body["model"]["base_developer_confirmed"])
        self.assertEqual(body["model"]["arabic_capability"], "Non confirmée")

    def test_missing_runtime_model_is_rejected(self):
        response = self.request_with_modal({"status": "ok", "deployment": "broken"})
        self.assertEqual(response.status_code, 502)
        self.assertIn("n’expose pas son modèle", response.json()["detail"])


if __name__ == "__main__":
    unittest.main()
