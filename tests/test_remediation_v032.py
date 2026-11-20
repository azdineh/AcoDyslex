import unicodedata
import unittest

from progress.remediation import FAMILY_LABELS, SPECS, enrich_catalog
from progress.service import CATALOG


class RemediationV032Tests(unittest.TestCase):
    def test_all_seven_interactive_families_are_implemented(self):
        self.assertEqual({item["activity_family"] for item in CATALOG}, set(FAMILY_LABELS))
        self.assertEqual(len(CATALOG), 16)
        for exercise in CATALOG:
            with self.subTest(exercise=exercise["id"]):
                self.assertIn(exercise["interaction"]["kind"], {"choice", "ordering", "human"})
                self.assertTrue(exercise["objective_fr"])
                self.assertTrue(exercise["example_ar"])

    def test_arabic_instructions_are_vocalized_and_answers_are_explicit(self):
        for exercise_id, spec in SPECS.items():
            with self.subTest(exercise=exercise_id):
                self.assertTrue(any(unicodedata.combining(character) for character in spec["instruction"]))
                if spec["kind"] in {"choice", "ordering"}:
                    self.assertIn("answer", spec)

    def test_missing_audio_is_never_presented_as_a_real_asset(self):
        auditory = [item for item in CATALOG if item["audio"]["status"] == "unavailable"]
        self.assertTrue(auditory)
        for exercise in auditory:
            self.assertIsNone(exercise["audio"]["url"])
            self.assertIn("Aucun fichier audio", exercise["audio"]["message_fr"])
            self.assertNotIn("اسمع", exercise["instruction_ar"])

    def test_enrichment_does_not_mutate_source_catalog(self):
        source = [{"id": "INV01", "instruction_ar": "source"}]
        enriched = enrich_catalog(source)
        self.assertEqual(source[0]["instruction_ar"], "source")
        self.assertNotEqual(enriched[0]["instruction_ar"], "source")


if __name__ == "__main__":
    unittest.main()
