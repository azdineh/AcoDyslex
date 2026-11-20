import io
import math
import struct
import os
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch
from fastapi.testclient import TestClient
import app as localapp
from recommendation import api as recommendation_api


def sample_wav(seconds=1, rate=16000, channels=1, width=2, amplitude=7500):
    output=io.BytesIO()
    with wave.open(output,'wb') as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(rate)
        n=int(seconds*rate)
        if width==2:
            pcm=b''.join(struct.pack('<h',int(amplitude*math.sin(2*math.pi*440*i/rate))) for i in range(n))
            w.writeframes(pcm*channels)
        else:
            w.writeframes(b'\x00' * int(seconds*rate*channels*width))
    return output.getvalue()

class PrototypeTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.patch=patch.object(localapp,'STORAGE',Path(self.temp.name))
        self.patch.start()
        self.client=TestClient(localapp.app)
    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def save(self, wav=None, consent=True, learner='eleve_01'):
        return self.client.post('/api/recordings',data={'learner_code':learner,'target_text':'سمكة','local_consent':str(consent).lower()}, files={'file':('reading.wav',wav or sample_wav(),'audio/wav')})
    def test_home(self):
        self.assertEqual(self.client.get('/').status_code,200)
    def test_no_consent(self):
        self.assertEqual(self.save(consent=False).status_code,403)
    def test_invalid_code(self):
        self.assertEqual(self.save(learner='../x').status_code,400)
    def test_invalid_audio_rate(self):
        self.assertEqual(self.save(wav=sample_wav(rate=44100)).status_code,400)
    def test_truncated_audio(self):
        self.assertEqual(self.save(wav=sample_wav()[:-1000]).status_code,400)
    def test_silence_rejected_and_not_archived(self):
        data=bytearray(sample_wav())
        data[44:]=b'\x00'*(len(data)-44)
        response=self.save(wav=bytes(data))
        self.assertEqual(response.status_code,422,response.text)
        self.assertIn('silencieux',response.json()['detail'])
        self.assertEqual(self.client.get('/api/recordings').json(),[])

    def test_dc_offset_rejected(self):
        data=bytearray(sample_wav())
        data[44:]=struct.pack('<h',5000)*((len(data)-44)//2)
        self.assertEqual(self.save(wav=bytes(data)).status_code,422)

    def test_quasi_silence_rejected(self):
        response=self.save(wav=sample_wav(amplitude=10))
        self.assertEqual(response.status_code,422,response.text)
        self.assertFalse(list(Path(self.temp.name).glob('*.wav')))

    def test_soft_reading_is_accepted(self):
        response=self.save(wav=sample_wav(amplitude=500))
        self.assertEqual(response.status_code,201,response.text)
        self.assertTrue(list(Path(self.temp.name).glob('*.wav')))

    def test_save_list_and_delete(self):
        response=self.save()
        self.assertEqual(response.status_code,201,response.text)
        rid=response.json()['id']
        self.assertEqual(self.client.get('/api/recordings').json()[0]['id'],rid)
        stored=self.client.get(f'/api/recordings/{rid}/audio')
        self.assertEqual(stored.status_code,200)
        self.assertEqual(stored.content,sample_wav())
        self.assertEqual(self.client.delete(f'/api/recordings/{rid}').status_code,200)
        self.assertEqual(self.client.get(f'/api/recordings/{rid}/audio').status_code,404)

    def test_reset_erases_local_recordings_and_progress_profiles(self):
        review_db = Path(self.temp.name) / "progress.sqlite3"
        with patch.object(recommendation_api, "REVIEW_DB_PATH", review_db):
            self.assertEqual(self.save().status_code, 201)
            created = self.client.post('/v1/progress/children', json={"child_id": "reset_child", "display_name": "Reset", "age": 8})
            self.assertEqual(created.status_code, 201, created.text)
            reset = self.client.delete('/api/reset')
            self.assertEqual(reset.status_code, 200, reset.text)
            self.assertEqual(reset.json()["status"], "reset")
            self.assertEqual(self.client.get('/api/recordings').json(), [])
            self.assertEqual(self.client.get('/v1/progress/children').json()["children"], [])
    def test_analysis_requires_permission(self):
        rid=self.save().json()['id']
        self.assertEqual(self.client.post(f'/api/recordings/{rid}/analyze').status_code,403)
    def test_analysis_requires_server_key(self):
        rid=self.save().json()['id']
        with patch.dict(os.environ,{'ACODYSLEX_API_KEY':''}):
            res=self.client.post(f'/api/recordings/{rid}/analyze', data={'transfer_consent':'true'})
        self.assertEqual(res.status_code,503)

if __name__ == '__main__': unittest.main()
