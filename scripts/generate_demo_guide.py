"""Create the V0.6 Arabic guide with synthetic data only."""
from __future__ import annotations

import tempfile
from pathlib import Path
import sys
from unittest.mock import patch

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import app
from recommendation import api as recommendation_api


def unit(index: int) -> dict:
    words = [("كتاب", ["k", "a", "t", "a", "b"]), ("قلم", ["q", "a", "l", "a", "m"]), ("باب", ["b", "a", "b"])]
    word, phonemes = words[(index - 1) % len(words)]
    return {"word_id": f"demo_{index}", "unit_id": f"demo_{index}", "unit_type": "word", "text": word,
            "order": index, "role": "revision" if index < 6 else "consolidation" if index < 12 else "transfer",
            "category": "decoding", "expected_phonemes": phonemes, "word_count": 1,
            "difficulty_level": 1, "target_skills": ["controlled_decoding"], "language_variety": "ar-MSA", "max_recording_seconds": 10}


def main() -> None:
    output = Path("output/pdf/acodyslex-learning-guide-demo-ar.pdf"); output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as temp:
        root = Path(temp)
        with patch.object(recommendation_api, "REVIEW_DB_PATH", root / "demo.sqlite3"), patch.object(recommendation_api, "REVIEW_KEY_PATH", root / "demo.key"):
            with TestClient(app.app) as client:
                client.post("/v1/progress/children", json={"child_id": "demo_child", "display_name": "متعلم تجريبي", "age": 8, "sex": "unspecified", "avatar_id": "neutral"}).raise_for_status()
                client.post("/v1/progress/sessions", json={"session_id": "demo_session", "child_id": "demo_child", "started_at": "2026-11-01T09:00:00Z", "recommendation_engine_version": "0.6.0", "recommended_exercise_ids": ["OMI01", "OMI02", "INV01", "INV02", "INV03", "SUB01", "INS02"], "observations": [], "reading_words": [unit(index) for index in range(1, 16)]}).raise_for_status()
                for index in range(1, 6):
                    client.post(f"/v1/progress/sessions/demo_session/words/demo_{index}/analysis", json={"child_id": "demo_child", "recording_id": f"demo_recording_{index}", "analysis_status": "ok", "observed_text": "k a t a b", "candidate_errors": [{"error_type": "omission", "count": 1}] if index == 1 else []}).raise_for_status()
                response = client.get("/v1/reports/sessions/demo_session/pdf?lang=ar"); response.raise_for_status(); output.write_bytes(response.content)
    print(output.resolve())


if __name__ == "__main__":
    main()
