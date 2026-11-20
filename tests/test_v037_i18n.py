"""Static contract checks for the V0.3.7 bilingual interface."""
from __future__ import annotations

import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EASTERN_DIGITS = re.compile(r"[٠-٩۰-۹]")


class V037InterfaceContractTests(unittest.TestCase):
    def test_frontend_sources_do_not_contain_eastern_digits(self):
        checked = []
        for path in (ROOT / "static").rglob("*"):
            if path.suffix.lower() not in {".html", ".js", ".css", ".json", ".svg"}:
                continue
            text = path.read_text(encoding="utf-8")
            self.assertIsNone(EASTERN_DIGITS.search(text), path)
            checked.append(path)
        self.assertGreater(len(checked), 10)

    def test_locales_define_explanations_and_provenance(self):
        for language in ("ar", "en"):
            locale = json.loads((ROOT / "static" / "locales" / f"{language}.json").read_text(encoding="utf-8"))
            self.assertIn("avatarAlt", locale["profile"])
            for key in ("analyzed", "candidates", "affected", "uncertain"):
                summary = locale["results"]["summary"][key]
                self.assertTrue(summary["title"])
                self.assertTrue(summary["description"])
                self.assertTrue(summary["context"])
            self.assertEqual(set(locale["results"]["provenance"]), {"ai", "human", "rejected"})
            self.assertIn("reviewExplanation", locale["results"])
            self.assertEqual(set(locale["aiModal"]["steps"]), {"checking", "sending", "analyzing", "receiving", "preparing"})
            for step in locale["aiModal"]["steps"].values():
                self.assertTrue(step["label"])
                self.assertTrue(step["message"])
            self.assertTrue(locale["aiModal"]["timeout"]["message"])

    def test_avatar_assets_are_local_inert_svg_files(self):
        expected = {"neutral.svg", "sky.svg", "mint.svg", "coral.svg", "violet.svg"}
        avatar_dir = ROOT / "static" / "avatars"
        self.assertEqual({path.name for path in avatar_dir.glob("*.svg")}, expected)
        for path in avatar_dir.glob("*.svg"):
            source = path.read_text(encoding="utf-8").lower()
            self.assertIn("<svg", source)
            self.assertNotIn("<script", source)
            self.assertNotIn("<image", source)
            self.assertNotIn(" href=", source)
            self.assertNotIn(" xlink:href=", source)

    def test_number_formatter_forces_latin_digits_in_both_languages(self):
        source = (ROOT / "static" / "i18n.js").read_text(encoding="utf-8")
        self.assertIn("ar-MA-u-nu-latn", source)
        self.assertIn("en-US", source)
        self.assertIn("formatNumber", source)


if __name__ == "__main__":
    unittest.main()
