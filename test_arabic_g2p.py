"""Run: python -m unittest -v test_arabic_g2p.py"""
import unittest

from arabic_g2p import (
    G2PError, G2P_VERSION, MODEL_PHONEMES, WORD_BOUNDARY,
    arabic_sentence_to_model_reference, arabic_to_model_phonemes, validate_manual_phonemes,
)


class ArabicG2PTests(unittest.TestCase):
    def test_reference_samaka(self):
        self.assertEqual(arabic_to_model_phonemes("سَمَكَة"), ["s", "a", "m", "a", "k", "a"])

    def test_plain_word(self):
        self.assertEqual(arabic_to_model_phonemes("كَتَبَ"), ["k", "a", "t", "a", "b", "a"])

    def test_sukun(self):
        self.assertEqual(arabic_to_model_phonemes("كَتَبْ"), ["k", "a", "t", "a", "b"])

    def test_long_aa(self):
        self.assertEqual(arabic_to_model_phonemes("سَامَ"), ["s", "aa", "m", "a"])

    def test_long_ii(self):
        self.assertEqual(arabic_to_model_phonemes("فِي"), ["f", "ii"])

    def test_long_uu(self):
        self.assertEqual(arabic_to_model_phonemes("نُورْ"), ["n", "uu", "r"])

    def test_shadda(self):
        self.assertEqual(arabic_to_model_phonemes("مَدَّ"), ["m", "a", "dd", "a"])

    def test_shadda_reverse_mark_order(self):
        self.assertEqual(arabic_to_model_phonemes("مَدَّ"), ["m", "a", "dd", "a"])

    def test_hamza(self):
        self.assertEqual(arabic_to_model_phonemes("أَكَلَ"), ["<", "a", "k", "a", "l", "a"])

    def test_no_diacritics_fails_closed(self):
        with self.assertRaises(G2PError):
            arabic_to_model_phonemes("سمكة")

    def test_incomplete_diacritics_fails_closed(self):
        with self.assertRaises(G2PError):
            arabic_to_model_phonemes("سَمَك")

    def test_emphatic_vowels_use_checkpoint_case(self):
        self.assertEqual(arabic_to_model_phonemes("صَامَ"), ["S", "AA", "m", "a"])

    def test_definite_article_and_hamzat_al_wasl(self):
        self.assertEqual(arabic_to_model_phonemes("الْقَلَمُ"), ["a", "l", "q", "A", "l", "a", "m", "u"])

    def test_tanween_is_supported_for_connected_word_form(self):
        self.assertEqual(arabic_to_model_phonemes("كَتَبٌ"), ["k", "a", "t", "a", "b", "u", "n"])

    def test_multiword_fails_closed(self):
        with self.assertRaises(G2PError):
            arabic_to_model_phonemes("سَمَكَة كَبِيرَة")

    def test_sentence_keeps_boundary_and_pauses_final_tanween(self):
        reference = arabic_sentence_to_model_reference("هَذَا كِتَابٌ")
        self.assertEqual(reference.phonemes_by_word, [["h", "a", "*", "aa"], ["k", "i", "t", "aa", "b"]])
        self.assertEqual(reference.phonemes, ["h", "a", "*", "aa", WORD_BOUNDARY, "k", "i", "t", "aa", "b"])
        self.assertIn("pausal_tanwin_review", reference.review_flags)

    def test_sentence_handles_solar_article_and_contractual_wasl(self):
        reference = arabic_sentence_to_model_reference("ذَهَبَ الْوَلَدُ لِلسُّوقِ")
        self.assertEqual(reference.phonemes_by_word[-1], ["l", "i", "ss", "uu", "q"])
        self.assertEqual(reference.phonemes.count(WORD_BOUNDARY), 2)

    def test_all_generated_symbols_are_checkpoint_symbols(self):
        reference = arabic_sentence_to_model_reference("الشَّمْسُ مُشْرِقَةٌ")
        self.assertTrue(set(reference.phonemes).issubset(MODEL_PHONEMES | {WORD_BOUNDARY}))

    def test_manual_phoneme_validation(self):
        self.assertEqual(validate_manual_phonemes("s a m a k a"), ["s", "a", "m", "a", "k", "a"])
        self.assertEqual(validate_manual_phonemes("< a k"), ["<", "a", "k"])
        with self.assertRaises(G2PError):
            validate_manual_phonemes("s nonsense k")


if __name__ == "__main__":
    unittest.main()
