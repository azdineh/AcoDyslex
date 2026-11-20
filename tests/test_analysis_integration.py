"""Local HTTP integration tests: synthetic WAVs, isolated storage, mocked Modal."""
import copy
import io
import math
import struct
import os
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient
import app as localapp


def synthetic_wav():
    output = io.BytesIO()
    with wave.open(output, 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b''.join(struct.pack('<h', int(7500 * math.sin(2 * math.pi * 440 * i / 16000))) for i in range(16000)))
    return output.getvalue()


def candidate_response():
    return {
        'status': 'ok', 'model': 'simulated-model',
        'expected_phonemes': ['k', 'a', 't', 'a', 'b', 'a'],
        'predicted_phonemes': ['k', 'a', 't', 'a', 'b'],
        'candidate_errors': [{'type': 'omission'}],
        'acoustics': {'duration_seconds': 1},
        'exercise_after_human_confirmation': {'description': 'Historical field preserved'},
        'phoneme_classification': {
            'status': 'candidate_only', 'reference_status': 'provided_unverified',
            'confirmed_child_error': False,
            'analysis': {
                'error_counts': {'omission': 1, 'inversion': 0, 'insertion': 0, 'substitution': 0},
                'errors': [{'type': 'omission', 'reference_tokens': ['a'], 'observed_tokens': []}],
                'type_ambiguous': False,
            },
        },
    }


class AnalysisIntegrationTests(unittest.TestCase):
    def setUp(self):
        storage = tempfile.TemporaryDirectory()
        self.addCleanup(storage.cleanup)
        storage_patch = patch.object(localapp, 'STORAGE', Path(storage.name))
        storage_patch.start()
        self.addCleanup(storage_patch.stop)
        environment = patch.dict(os.environ, {
            'ACODYSLEX_API_KEY': 'synthetic-test-key',
            'ACODYSLEX_MODAL_BASE_URL': 'https://modal.invalid',
            'ACODYSLEX_ENABLE_WHISPER': '0',
        })
        environment.start()
        self.addCleanup(environment.stop)
        self.client = TestClient(localapp.app)
        self.addCleanup(self.client.close)
        self.requests = []

    def save(self, target='كَتَبَ', expected='', verified=''):
        response = self.client.post('/api/recordings', data={
            'learner_code': 'synthetic-reader', 'target_text': target,
            'expected_phonemes': expected, 'verified_error_type': verified,
            'local_consent': 'true',
        }, files={'file': ('synthetic.wav', synthetic_wav(), 'audio/wav')})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def analyze(self, record, payload=None, *, response=None, whisper=False):
        def handler(request):
            self.requests.append(request)
            return response if response is not None else httpx.Response(200, json=payload)

        original_client = httpx.AsyncClient
        def make_client(**kwargs):
            return original_client(transport=httpx.MockTransport(handler), **kwargs)

        with patch.object(localapp.httpx, 'AsyncClient', side_effect=make_client):
            return self.client.post(f"/api/recordings/{record['id']}/analyze", data={
                'transfer_consent': 'true', 'use_whisper': str(whisper).lower(),
            })

    def test_classification_and_historical_fields_pass_through(self):
        record = self.save()
        payload = candidate_response()
        response = self.analyze(record, payload)
        self.assertEqual(response.status_code, 200)
        result = response.json()
        for key, value in payload.items():
            self.assertEqual(result[key], value)
        self.assertTrue(result['classification_available'])
        self.assertEqual(result['reference_source'], 'g2p_v0.4.1_sentence_context')
        self.assertEqual(result['reference_validation_status'], 'g2p_provisional')
        self.assertEqual(record['reference_validation_status'], 'g2p_provisional')
        self.assertTrue(result['recommendation_observations'])
        self.assertTrue(all(item['verification_status'] == 'automated_unverified'
                            for item in result['recommendation_observations']))
        self.assertTrue(all(item['opportunities'] == 0
                            for item in result['recommendation_observations']))
        self.assertEqual(result['recording_id'], record['id'])
        request = self.requests[0]
        self.assertEqual(str(request.url), 'https://modal.invalid/v1/reading/analyze')
        self.assertEqual(request.headers['X-AcoDyslex-Key'], 'synthetic-test-key')
        self.assertIn(b'k a t a b a', request.content)
        self.assertIn(b'RIFF', request.content)
        self.assertNotIn('synthetic-test-key', response.text)
        self.assertNotIn('synthetic-test-key', self.client.get('/api/config').text)

    def test_manual_reference_is_not_automatically_verified(self):
        record = self.save(expected='k a t a b a', verified='omission')
        result = self.analyze(record, candidate_response()).json()
        self.assertEqual(result['reference_source'], 'manual')
        self.assertEqual(result['reference_validation_status'], 'provided_unverified')
        self.assertFalse(result['phoneme_classification']['confirmed_child_error'])

    def test_missing_reference_remains_missing(self):
        record = self.save(target='سمكة')
        payload = candidate_response()
        payload['phoneme_classification'] = {'status': 'skipped_missing_reference'}
        result = self.analyze(record, payload).json()
        self.assertEqual(result['reference_validation_status'], 'missing')
        self.assertTrue(result['reference_warning'])
        self.assertEqual(result['phoneme_classification'], payload['phoneme_classification'])

    def test_omitted_or_malformed_classification_does_not_become_zero(self):
        record = self.save()
        for classification in [None, [], 'invalid', {}]:
            with self.subTest(classification=classification):
                payload = {'status': 'ok'}
                if classification is not None:
                    payload['phoneme_classification'] = classification
                result = self.analyze(record, payload).json()
                self.assertFalse(result['classification_available'])
                self.assertIn('classification_note', result)
                self.assertNotIn('error_counts', result)
                self.assertEqual(result.get('phoneme_classification'), payload.get('phoneme_classification'))

    def test_skipped_and_ambiguous_responses_are_not_reclassified(self):
        record = self.save()
        for status in ['skipped_missing_reference', 'skipped_missing_observation', 'skipped_unsupported_tokens', 'candidate_only']:
            with self.subTest(status=status):
                payload = candidate_response()
                payload['phoneme_classification']['status'] = status
                payload['phoneme_classification']['analysis']['type_ambiguous'] = True
                expected = copy.deepcopy(payload['phoneme_classification'])
                self.assertEqual(self.analyze(record, payload).json()['phoneme_classification'], expected)

    def test_modal_http_errors_are_reported_without_remote_response_body(self):
        record = self.save()
        for status in [401, 403, 502]:
            with self.subTest(status=status):
                response = self.analyze(record, response=httpx.Response(status, text='private upstream content'))
                self.assertEqual(response.status_code, 502)
                self.assertIn(str(status), response.json()['detail'])
                self.assertNotIn('private upstream content', response.text)

    def test_invalid_json_and_invalid_top_level_are_502(self):
        record = self.save()
        responses = [httpx.Response(200, text='<html>invalid</html>')]
        responses += [httpx.Response(200, json=value) for value in [None, [], 'bad', 42, {}, {'status': 'error'}]]
        for upstream in responses:
            with self.subTest(body=upstream.text):
                self.assertEqual(self.analyze(record, response=upstream).status_code, 502)

    def test_network_failure_is_502(self):
        record = self.save()
        with patch.object(localapp.httpx.AsyncClient, 'post', side_effect=httpx.ConnectError('offline')):
            response = self.client.post(f"/api/recordings/{record['id']}/analyze", data={'transfer_consent': 'true'})
        self.assertEqual(response.status_code, 502)

    def test_legacy_record_without_provenance_remains_unverified(self):
        record = self.save(expected='k a t a b a')
        record.pop('reference_source')
        record.pop('reference_validation_status')
        with patch.object(localapp, 'read_metadata', return_value=record):
            result = self.analyze(record, candidate_response()).json()
        self.assertEqual(result['reference_validation_status'], 'provided_unverified')

    def test_whisper_optional_transcript_preserves_classification(self):
        record = self.save()
        with patch.dict(os.environ, {'ACODYSLEX_ENABLE_WHISPER': '1'}), patch.object(localapp, '_run_whisper', return_value='نص تجريبي') as whisper:
            result = self.analyze(record, candidate_response(), whisper=True).json()
        whisper.assert_called_once()
        self.assertEqual(result['whisper_transcript'], 'نص تجريبي')
        self.assertEqual(result['phoneme_classification'], candidate_response()['phoneme_classification'])

    def test_whisper_failure_keeps_acoustic_analysis(self):
        record = self.save()
        with patch.dict(os.environ, {'ACODYSLEX_ENABLE_WHISPER': '1'}), patch.object(localapp, '_run_whisper', side_effect=RuntimeError('unavailable')):
            result = self.analyze(record, candidate_response(), whisper=True).json()
        self.assertIsNone(result['whisper_transcript'])
        self.assertIn('Whisper indisponible', result['whisper_note'])
        self.assertTrue(result['classification_available'])

    def test_no_whisper_inference_unless_requested(self):
        with patch.object(localapp, '_run_whisper') as whisper:
            self.assertEqual(self.analyze(self.save(), candidate_response()).status_code, 200)
        whisper.assert_not_called()


if __name__ == '__main__':
    unittest.main()
