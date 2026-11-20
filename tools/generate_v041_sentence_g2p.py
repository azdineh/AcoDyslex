"""Generate V0.4.1 provisional, word-aligned sentence references.

The command refuses to overwrite any validated/manual annotation. It replaces
only the earlier ``provisional_requires_g2p_model_alignment`` placeholders,
which explicitly state that their non-checkpoint symbols still need alignment.
"""

from __future__ import annotations

import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from arabic_g2p import (
    G2P_VERSION,
    MODEL_ID,
    MODEL_REVISION,
    VOCABULARY_SHA256,
    arabic_sentence_to_model_reference,
)


BANK_PATH = ROOT / "static" / "reading_words.json"


def main() -> None:
    bank = json.loads(BANK_PATH.read_text(encoding="utf-8"))
    sentences = bank.get("short_sentences", [])
    if len(sentences) != 50:
        raise SystemExit("La banque V0.4.1 doit contenir exactement 50 phrases.")
    for entry in sentences:
        previous_status = entry.get("phoneme_reference_status")
        if (entry.get("phonemes") or entry.get("phonemes_by_word")) and previous_status not in {None, "provisional_requires_g2p_model_alignment", "g2p_provisional_checkpoint_vocab"}:
            raise SystemExit(f"{entry.get('id')}: annotation existante non provisoire ; génération annulée.")
        words = entry["text"].split()
        if len(words) != entry.get("word_count") or len(words) not in {2, 3}:
            raise SystemExit(f"{entry.get('id')}: nombre de mots invalide.")
        reference = arabic_sentence_to_model_reference(entry["text"], pause_final=True)
        entry["phonemes"] = reference.phonemes
        entry["phonemes_by_word"] = [
            {"word": word, "phonemes": phonemes}
            for word, phonemes in zip(words, reference.phonemes_by_word, strict=True)
        ]
        entry["phoneme_reference_metadata"] = {
            "model_id": MODEL_ID,
            "revision": MODEL_REVISION,
            "vocabulary_sha256": VOCABULARY_SHA256,
            "g2p_version": G2P_VERSION,
            "word_boundary_token": "|",
            "final_word_pronunciation": "pause_form",
        }
        entry["phoneme_reference_status"] = "g2p_provisional_checkpoint_vocab"
        entry["phoneme_review_flags"] = reference.review_flags
        entry["requires_linguistic_review"] = True
        entry["reference_warnings"] = reference.review_flags
    bank["version"] = "0.4.1"
    bank["source_note"] = (
        "Banque V0.4.1 : références G2P contextuelles compatibles avec le vocabulaire du checkpoint Modal. "
        "Chaque séquence est provisoire et doit être validée linguistiquement ; un écart ASR ne prouve jamais une erreur de l'enfant."
    )
    BANK_PATH.write_text(json.dumps(bank, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
