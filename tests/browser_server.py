"""Isolated server for browser tests. Never contacts Modal or uses real recordings."""
import os
import json
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx
import uvicorn
import app as localapp
from recommendation import api as recommendation_api


def simulated_modal(request):
    if request.method == 'GET' and str(request.url) == 'https://modal.invalid/health':
        return httpx.Response(200, json={
            'status': 'ok', 'deployment': 'modal-single-provider',
            'model': 'MostafaMaroof/wav2vec2-arabic-phoneme-asr',
        })
    if request.method == 'GET' and str(request.url) == 'https://modal.invalid/openapi.json':
        return httpx.Response(200, json={
            'info': {'title': 'AcoDyslex acoustic phoneme prototype', 'version': '0.3.0'},
        })
    assert request.headers['X-AcoDyslex-Key'] == 'synthetic-browser-test-key'
    assert b'RIFF' in request.content
    if str(request.url) == 'https://modal.invalid/v1/reading/analyze-batch':
        assert request.content.count(b'RIFF') == 15
        marker = b'name="manifest_json"\r\n\r\n'
        manifest = json.loads(request.content.split(marker, 1)[1].split(b'\r\n--', 1)[0].decode('utf-8'))
        return httpx.Response(200, json={
            'word_results': [{
                'word_id': word['word_id'], 'word_order': word['word_order'],
                'reference_text': word['reference_text'], 'analysis_status': 'ok',
                'expected_phonemes': word.get('expected_phonemes', []),
                'predicted_phonemes': word.get('expected_phonemes', []),
                'candidate_errors': [],
            } for word in manifest['words']],
            'model_versions': {'acoustic': 'SIMULATION'},
            'processing_metadata': {'inference_mode': 'single_invocation_sequential_inference'},
        })
    assert str(request.url) == 'https://modal.invalid/v1/reading/analyze'
    assert b'k a t a b a' in request.content
    return httpx.Response(200, json={
        'status': 'ok', 'model': 'SIMULATION — no GPU inference',
        'target_text': 'كَتَبَ',
        'expected_phonemes': ['k', 'a', 't', 'a', 'b', 'a'],
        'predicted_phonemes': ['k', 'a', 'd', 'a', 'b', 'a'],
        'candidate_errors': [{'type': 'substitution', 'reference_tokens': ['t'], 'observed_tokens': ['d']}],
        'acoustics': {'duration_seconds': 1},
        'phoneme_classification': {
            'status': 'candidate_only', 'reference_status': 'provided_unverified',
            'confirmed_child_error': False,
            'analysis': {
                'error_counts': {'omission': 0, 'inversion': 0, 'insertion': 0, 'substitution': 1},
                'errors': [{'type': 'substitution', 'reference_position': 2, 'observed_position': 2,
                            'reference_tokens': ['t'], 'observed_tokens': ['d']}],
                'type_ambiguous': False,
            },
        },
    })


if __name__ == '__main__':
    os.environ['ACODYSLEX_API_KEY'] = 'synthetic-browser-test-key'
    os.environ['ACODYSLEX_MODAL_BASE_URL'] = 'https://modal.invalid'
    os.environ['ACODYSLEX_ENABLE_WHISPER'] = '0'
    original_client = httpx.AsyncClient

    def mock_client(**kwargs):
        return original_client(transport=httpx.MockTransport(simulated_modal), **kwargs)

    localapp.httpx.AsyncClient = mock_client
    with tempfile.TemporaryDirectory(prefix='acodyslex-browser-') as storage:
        localapp.STORAGE = Path(storage)
        recommendation_api.REVIEW_DB_PATH = Path(storage) / 'reviews.sqlite3'
        recommendation_api.REVIEW_KEY_PATH = Path(storage) / 'review.key'
        uvicorn.run(localapp.app, host='127.0.0.1', port=8765, log_level='warning')
