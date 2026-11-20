import json
import unittest
from pathlib import Path

from batch_analysis import BatchManifest
from arabic_g2p import (
    G2P_VERSION, MODEL_ID, MODEL_PHONEMES, MODEL_REVISION, VOCABULARY_SHA256,
    WORD_BOUNDARY, arabic_sentence_to_model_reference,
)
from progress.models import ReadingWordSelection
from progress.remediation import enrich_catalog


ROOT = Path(__file__).resolve().parents[1]


class MixedReadingBankTests(unittest.TestCase):
    def test_initial_arabic_sentence_bank_has_valid_short_units(self):
        bank = json.loads((ROOT / "static" / "reading_words.json").read_text(encoding="utf-8"))
        sentences = bank["short_sentences"]
        self.assertGreaterEqual(len(sentences), 5)
        for raw in sentences:
            self.assertEqual(raw["type"], "short_sentence")
            self.assertIn(raw["word_count"], {2, 3})
            self.assertEqual(len(raw["text"].split()), raw["word_count"])
            self.assertEqual(raw["language_variety"], "ar-MSA")
            self.assertEqual(raw["max_recording_seconds"], 15)
            ReadingWordSelection.model_validate({
                "word_id": raw["id"], "unit_id": raw["id"], "unit_type": raw["type"],
                "text": raw["text"], "order": 1, "role": "revision", "category": raw["category"],
                "expected_phonemes": raw["phonemes"], "expected_phonemes_ar": raw["phonemes_ar"], "word_count": raw["word_count"],
                "difficulty_level": raw["difficulty_level"], "target_skills": raw["target_skills"],
                "language_variety": raw["language_variety"], "max_recording_seconds": raw["max_recording_seconds"],
                "phonemes_by_word": raw.get("phonemes_by_word", []),
                "phoneme_reference_status": raw.get("phoneme_reference_status", "missing"),
                "requires_linguistic_review": raw.get("requires_linguistic_review", False),
                "reference_warnings": raw.get("reference_warnings", []),
            })

    def test_v041_all_fifty_phrases_have_checkpoint_compatible_word_aligned_references(self):
        bank = json.loads((ROOT / "static" / "reading_words.json").read_text(encoding="utf-8"))
        self.assertEqual(bank["version"], "0.4.2")
        self.assertEqual(len(bank["short_sentences"]), 50)
        for entry in bank["short_sentences"]:
            with self.subTest(sentence=entry["id"]):
                expected = arabic_sentence_to_model_reference(entry["text"])
                self.assertEqual(entry["phonemes"], expected.phonemes)
                self.assertEqual(entry["phonemes"].count(WORD_BOUNDARY), entry["word_count"] - 1)
                self.assertTrue(set(entry["phonemes"]).issubset(MODEL_PHONEMES | {WORD_BOUNDARY}))
                self.assertEqual(
                    entry["phonemes_by_word"],
                    [{"word": word, "phonemes": phonemes} for word, phonemes in zip(entry["text"].split(), expected.phonemes_by_word, strict=True)],
                )
                self.assertEqual(entry["phoneme_reference_status"], "g2p_provisional_checkpoint_vocab")
                self.assertTrue(entry["requires_linguistic_review"])
                self.assertEqual(entry["reference_warnings"], expected.review_flags)
                metadata = entry["phoneme_reference_metadata"]
                self.assertEqual(metadata["model_id"], MODEL_ID)
                self.assertEqual(metadata["revision"], MODEL_REVISION)
                self.assertEqual(metadata["vocabulary_sha256"], VOCABULARY_SHA256)
                self.assertEqual(metadata["g2p_version"], G2P_VERSION)

    def test_every_reference_has_checkpoint_specific_arabic_presentation(self):
        bank = json.loads((ROOT / "static" / "reading_words.json").read_text(encoding="utf-8"))
        presentation_document = json.loads((ROOT / "acodyslex_phonemes_ar.json").read_text(encoding="utf-8"))
        source = {item["symbol"]: item for item in presentation_document["phonemes"]}
        self.assertEqual(bank["phoneme_presentation"]["source"], "acodyslex_phonemes_ar.json")
        self.assertEqual(bank["phoneme_presentation"]["model"], MODEL_ID)
        self.assertEqual(bank["phoneme_presentation"]["rendering_policy"], "documented_only")
        for collection_name in ("words", "short_sentences"):
            for entry in bank[collection_name]:
                with self.subTest(unit=entry["id"]):
                    self.assertEqual(len(entry["phonemes_ar"]), len(entry["phonemes"]))
                    self.assertEqual([item["symbol"] for item in entry["phonemes_ar"]], entry["phonemes"])
                    for item in entry["phonemes_ar"]:
                        if item["symbol"] == "|":
                            self.assertEqual(item["mapping_status"], "non_documente")
                            continue
                        expected = source[item["symbol"]]
                        self.assertEqual(item["arabic"], expected["arabic"])
                        self.assertEqual(item["name_ar"], expected["name_ar"])
                        self.assertEqual(item["mapping_status"], expected["mapping_status"])

    def test_v041_examples_document_contextual_pronunciation(self):
        bank = json.loads((ROOT / "static" / "reading_words.json").read_text(encoding="utf-8"))
        examples = {item["id"]: item for item in bank["short_sentences"]}
        self.assertEqual(examples["s01"]["phonemes_by_word"][1]["phonemes"], ["k", "i", "t", "aa", "b"])
        self.assertEqual(examples["s05"]["phonemes_by_word"][2]["phonemes"], ["l", "i", "ss", "uu", "q"])
        self.assertEqual(examples["s24"]["phonemes_by_word"][1]["phonemes"], ["j", "a", "m", "ii", "l", "a"])

    def test_sentence_word_count_must_match_text(self):
        with self.assertRaises(ValueError):
            ReadingWordSelection.model_validate({
                "word_id": "s_bad", "unit_type": "short_sentence", "text": "one two three",
                "order": 1, "role": "revision", "category": "sentence_reading", "word_count": 2,
            })

    def test_guided_remediation_has_separate_sentence_variants(self):
        catalog = enrich_catalog([{"id": "INV03", "error_type": "inversion", "level": 2, "skill": "controlled_decoding"}])
        exercise = catalog[0]
        self.assertEqual(exercise["unit_type"], "short_sentence")
        self.assertEqual(exercise["interaction"]["items"], exercise["sentence_variants"])
        self.assertTrue(all(2 <= len(sentence.split()) <= 3 for sentence in exercise["sentence_variants"]))
        with self.assertRaises(ValueError):
            BatchManifest.model_validate({
                "analysis_id": "batch_bad", "child_id": "child_bad", "session_id": "session_bad",
                "words": [{
                    "word_id": f"w{index}", "word_order": index, "reference_text": "one" if index != 1 else "one two three",
                    "unit_type": "word" if index != 1 else "short_sentence", "word_count": 1 if index != 1 else 2,
                } for index in range(1, 16)],
            })


if __name__ == "__main__":
    unittest.main()
