"""Add checkpoint-specific Arabic phoneme presentation data to the reading bank.

The raw `phonemes` lists remain the sole analytical representation.  This
script mirrors their symbols into `phonemes_ar` using the reviewed entries in
`acodyslex_phonemes_ar.json`; entries marked non-documented or variant stay
explicitly marked and are not auto-rendered by the client.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BANK_PATH = ROOT / "static" / "reading_words.json"
PRESENTATION_PATH = ROOT / "acodyslex_phonemes_ar.json"
DOCUMENTED = "documente_dans_recapitulatif"


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def presentation_index(document: dict) -> dict[str, dict]:
    return {
        item["symbol"]: item
        for item in document.get("phonemes", [])
        if isinstance(item, dict) and isinstance(item.get("symbol"), str)
    }


def token_presentation(token: object, source: dict[str, dict]) -> dict:
    symbol = str(token)
    entry = source.get(symbol)
    if entry is None:
        return {
            "symbol": symbol,
            "arabic": None,
            "name_ar": None,
            "category": "non_documente",
            "mapping_status": "non_documente",
        }
    return {
        "symbol": symbol,
        "arabic": entry.get("arabic"),
        "name_ar": entry.get("name_ar"),
        "category": entry.get("category"),
        "mapping_status": entry.get("mapping_status", "non_documente"),
    }


def enrich(bank: dict, source: dict[str, dict]) -> bool:
    changed = False
    for collection_name in ("words", "short_sentences"):
        for item in bank.get(collection_name, []):
            presentation = [token_presentation(token, source) for token in item.get("phonemes", [])]
            if item.get("phonemes_ar") != presentation:
                item["phonemes_ar"] = presentation
                changed = True
    metadata = {
        "source": "acodyslex_phonemes_ar.json",
        "model": load_json(PRESENTATION_PATH).get("model"),
        "rendering_policy": "documented_only",
        "description_fr": "Présentation arabe des phonèmes de référence ; les symboles bruts restent utilisés par l'analyse.",
    }
    if bank.get("phoneme_presentation") != metadata:
        bank["phoneme_presentation"] = metadata
        changed = True
    if bank.get("version") == "0.4.1":
        bank["version"] = "0.4.2"
        changed = True
    return changed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="Fail when the bank is not synchronized.")
    args = parser.parse_args()
    bank = load_json(BANK_PATH)
    source = presentation_index(load_json(PRESENTATION_PATH))
    changed = enrich(bank, source)
    if args.check:
        if changed:
            print("reading_words.json needs Arabic phoneme presentation synchronization")
            return 1
        print("reading_words.json Arabic phoneme presentation is synchronized")
        return 0
    if changed:
        BANK_PATH.write_text(json.dumps(bank, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print("Updated static/reading_words.json")
    else:
        print("static/reading_words.json is already up to date")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
