"""Interactive remediation metadata layered on the validated V0.1 catalogue."""
from __future__ import annotations

from copy import deepcopy
from typing import Any


FAMILY_LABELS = {
    "auditory_discrimination": "Discrimination auditive",
    "phoneme_grapheme_matching": "Son et lettre",
    "syllable_ordering": "Ordre des syllabes",
    "missing_letter": "Lettre manquante",
    "letter_ordering": "Ordre des lettres",
    "extra_phoneme_detection": "Son ajouté",
    "guided_reading": "Lecture guidée",
}

# Kept separate from word-level remediation: these are controlled, short MSA
# reading prompts and require an accompanying adult's judgement.
SENTENCE_REMEDIATION_VARIANTS = [
    "\u0647\u064e\u0630\u064e\u0627 \u0643\u0650\u062a\u064e\u0627\u0628\u064c",
    "\u0642\u064e\u0631\u064e\u0623\u064e \u0627\u0644\u0648\u064e\u0644\u064e\u062f\u064f",
    "\u0630\u064e\u0647\u064e\u0628\u064e \u0627\u0644\u0648\u064e\u0644\u064e\u062f\u064f \u0644\u0650\u0644\u0633\u0651\u064f\u0648\u0642\u0650",
]


SPECS: dict[str, dict[str, Any]] = {
    "INV01": {"family": "syllable_ordering", "objective": "Construire un mot en respectant l’ordre de ses syllabes.", "instruction": "رَتِّبِ الْمَقَاطِعَ لِتَبْنِيَ الْكَلِمَةَ.", "example": "مَ + دْ + رَ = مَدْرَ", "kind": "ordering", "tokens": ["سَ", "مَ", "كْ"], "answer": ["سَ", "مَ", "كْ"], "hint": "اِبْدَأْ بِالصَّوْتِ سَ."},
    "INV02": {"family": "auditory_discrimination", "objective": "Distinguer l’ordre de deux séquences proches.", "instruction": "اِطْلُبْ مِنَ الْمُرَافِقِ نُطْقَ الْكَلِمَةِ، ثُمَّ اخْتَرْهَا.", "example": "سَ ثُمَّ مَ يَخْتَلِفُ عَنْ مَ ثُمَّ سَ.", "kind": "choice", "options": ["سَمَك", "مَسَك"], "answer": "سَمَك", "model": "سَمَك", "hint": "رَكِّزْ عَلَى الصَّوْتِ الْأَوَّلِ.", "audio_required": True},
    "INV03": {"family": "guided_reading", "objective": "Lire deux mots en conservant l’ordre des sons.", "instruction": "اِقْرَأِ الْكَلِمَتَيْنِ بِبُطْءٍ، وَحَافِظْ عَلَى تَرْتِيبِ الْأَصْوَاتِ.", "example": "سَمَك — مَسَك", "kind": "human", "items": ["سَمَك", "مَسَك"], "hint": "اِقْرَأْ كُلَّ مَقْطَعٍ وَحْدَهُ أَوَّلًا."},
    "OMI01": {"family": "missing_letter", "objective": "Retrouver le graphème absent dans un mot.", "instruction": "اِخْتَرِ الْحَرْفَ النَّاقِصَ فِي الْكَلِمَةِ.", "example": "كِتَا_ٌ ← ب", "prompt": "مَدْ_َسَة", "kind": "choice", "options": ["ر", "د", "س"], "answer": "ر", "hint": "الْكَلِمَةُ هِيَ مَدْرَسَةٌ."},
    "OMI02": {"family": "missing_letter", "objective": "Compléter un mot vocalisé sans omettre de graphème.", "instruction": "أَكْمِلِ الْكَلِمَةَ بِالْحَرْفِ الْمُنَاسِبِ.", "example": "بَا_ٌ ← ب", "prompt": "مِ_ْ", "kind": "choice", "options": ["ن", "م", "ب"], "answer": "ن", "hint": "اُنْطُقْ: مِـنْ."},
    "OMI03": {"family": "guided_reading", "objective": "Lire des mots contenant le graphème ر.", "instruction": "اِقْرَأِ الْكَلِمَاتِ، وَانْتَبِهْ إِلَى صَوْتِ الرَّاءِ.", "example": "رَأَى", "kind": "human", "items": ["دَرَسَ", "دَرْس", "مَدْرَسَة"], "hint": "أَشِرْ إِلَى حَرْفِ ر قَبْلَ الْقِرَاءَةِ."},
    "INS01": {"family": "extra_phoneme_detection", "objective": "Repérer une séquence qui contient un son ajouté.", "instruction": "قَارِنِ السِّلْسِلَتَيْنِ، ثُمَّ اخْتَرِ السِّلْسِلَةَ الَّتِي فِيهَا صَوْتٌ زَائِدٌ.", "example": "مَ نْ ≠ مَ نَ نْ", "kind": "choice", "options": ["مَ نْ", "مَ نَ نْ"], "answer": "مَ نَ نْ", "hint": "عُدَّ الْأَجْزَاءَ فِي كُلِّ سِلْسِلَةٍ."},
    "INS02": {"family": "letter_ordering", "objective": "Assembler les graphèmes sans répétition.", "instruction": "رَتِّبِ الْحُرُوفَ لِتَكْتُبَ الْكَلِمَةَ دُونَ تَكْرَارٍ.", "example": "بَ + ا + بٌ = بَابٌ", "kind": "ordering", "tokens": ["نْ", "مَ"], "answer": ["مَ", "نْ"], "hint": "اِبْدَأْ بِحَرْفِ م."},
    "INS03": {"family": "extra_phoneme_detection", "objective": "Identifier le segment ajouté à une séquence.", "instruction": "اِخْتَرِ الْمَقْطَعَ الزَّائِدَ فِي السِّلْسِلَةِ الثَّانِيَةِ.", "example": "سَ مَ كْ / سَ مَ كَ كْ", "kind": "choice", "options": ["سَ", "مَ", "كَ"], "answer": "كَ", "hint": "قَارِنْ آخِرَ السِّلْسِلَتَيْنِ."},
    "SUB01": {"family": "auditory_discrimination", "objective": "Distinguer سَ de صَ avec un modèle humain réel.", "instruction": "اِطْلُبْ مِنَ الْمُرَافِقِ نُطْقَ الْمَقْطَعِ، ثُمَّ اخْتَرْهُ.", "example": "سَ وَصَ صَوْتَانِ مُخْتَلِفَانِ.", "kind": "choice", "options": ["سَ", "صَ"], "answer": "سَ", "model": "سَ", "hint": "رَاقِبْ شَكْلَ الْفَمِ مَعَ الْمُرَافِقِ.", "audio_required": True},
    "SUB02": {"family": "phoneme_grapheme_matching", "objective": "Associer un phonème prononcé à son graphème.", "instruction": "اِطْلُبْ مِنَ الْمُرَافِقِ نُطْقَ الصَّوْتِ، ثُمَّ اخْتَرِ الْحَرْفَ.", "example": "/م/ ← م", "kind": "choice", "options": ["س", "ص"], "answer": "س", "model": "/s/", "hint": "اِسْمُ الْحَرْفِ هُوَ سِينٌ.", "audio_required": True},
    "SUB03": {"family": "guided_reading", "objective": "Lire une paire en marquant le contraste س / ص.", "instruction": "اِقْرَأِ الْكَلِمَتَيْنِ، وَمَيِّزْ بَيْنَ س وَص.", "example": "سَ — صَ", "kind": "human", "items": ["سَارَ", "صَارَ"], "hint": "تَدَرَّبْ عَلَى سَ وَصَ قَبْلَ الْكَلِمَتَيْنِ."},
    "SV01": {"family": "auditory_discrimination", "objective": "Distinguer les trois voyelles brèves avec un modèle humain.", "instruction": "اِطْلُبْ مِنَ الْمُرَافِقِ نُطْقَ الْمَقْطَعِ، ثُمَّ اخْتَرْهُ.", "example": "بَ — بِ — بُ", "kind": "choice", "options": ["بَ", "بِ", "بُ"], "answer": "بِ", "model": "بِ", "hint": "اِنْتَبِهْ إِلَى الْكَسْرَةِ تَحْتَ الْبَاءِ.", "audio_required": True},
    "SV02": {"family": "phoneme_grapheme_matching", "objective": "Associer une syllabe vocalisée à son signe.", "instruction": "اِخْتَرِ الْحَرَكَةَ الَّتِي تُنَاسِبُ الْمَقْطَعَ بِ.", "example": "بَ ← فَتْحَةٌ", "prompt": "بِ", "kind": "choice", "options": ["فَتْحَةٌ", "كَسْرَةٌ", "ضَمَّةٌ"], "answer": "كَسْرَةٌ", "hint": "الْعَلَامَةُ تَحْتَ الْحَرْفِ."},
    "LV01": {"family": "auditory_discrimination", "objective": "Distinguer une voyelle brève d’une voyelle longue.", "instruction": "اِطْلُبْ مِنَ الْمُرَافِقِ نُطْقَ الْمَقْطَعِ الطَّوِيلِ، ثُمَّ اخْتَرْهُ.", "example": "بَ قَصِيرٌ، وَبَا طَوِيلٌ.", "kind": "choice", "options": ["بَ", "بَا"], "answer": "بَا", "model": "بَا", "hint": "الْمَقْطَعُ الطَّوِيلُ فِيهِ أَلِفٌ.", "audio_required": True},
    "LV02": {"family": "guided_reading", "objective": "Lire deux formes dont la longueur vocalique change.", "instruction": "اِقْرَأِ الْكَلِمَتَيْنِ بِبُطْءٍ، وَلَاحِظِ الْأَلِفَ.", "example": "بَ — بَا", "kind": "human", "items": ["كَتَبَ", "كَاتَبَ"], "hint": "مُدَّ الصَّوْتَ عِنْدَ وُجُودِ الْأَلِفِ."},
}


def enrich_exercise(exercise: dict[str, Any]) -> dict[str, Any]:
    """Return UI-safe metadata without claiming a non-existent audio asset."""
    result = deepcopy(exercise)
    spec = SPECS[result["id"]]
    result.update({
        "activity_family": spec["family"],
        "activity_family_label_fr": FAMILY_LABELS[spec["family"]],
        "objective_fr": spec["objective"],
        "instruction_ar": spec["instruction"],
        "example_ar": spec["example"],
        "interaction": {key: deepcopy(value) for key, value in spec.items()
                        if key in {"kind", "tokens", "options", "answer", "prompt", "items", "hint", "model"}},
        "audio": {
            "status": "unavailable" if spec.get("audio_required") else "not_required",
            "url": None,
            "message_fr": (
                "Aucun fichier audio pédagogique validé n'est disponible. Le modèle doit être prononcé en direct par l'accompagnateur."
                if spec.get("audio_required") else "Cette activité ne nécessite pas de fichier audio."
            ),
        },
    })
    if result["id"] == "INV03":
        result["unit_type"] = "short_sentence"
        result["sentence_variants"] = deepcopy(SENTENCE_REMEDIATION_VARIANTS)
        result["interaction"]["items"] = deepcopy(SENTENCE_REMEDIATION_VARIANTS)
    return result


def enrich_catalog(catalog: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [enrich_exercise(item) for item in catalog]
