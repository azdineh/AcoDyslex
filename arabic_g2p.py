"""Arabic G2P references constrained to the deployed Modal checkpoint vocabulary.

The generator accepts fully vocalized MSA words and short sentences. It makes
provisional references only: a sequence mismatch is never a proven child error.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import unicodedata

MODEL_ID = "MostafaMaroof/wav2vec2-arabic-phoneme-asr"
MODEL_REVISION = "0a32c641aaaeec6957e41a794add52e024e46b50"
G2P_VERSION = "g2p_v0.4.1_sentence_context"
_VOCAB = json.loads(Path(__file__).with_name("acoustic_model_vocab.json").read_text(encoding="utf-8"))
if _VOCAB["model_id"] != MODEL_ID or _VOCAB["revision"] != MODEL_REVISION:
    raise RuntimeError("Le vocabulaire local ne correspond pas au checkpoint Modal déclaré")
MODEL_TOKEN_IDS: dict[str, int] = _VOCAB["tokens"]
MODEL_PHONEMES = frozenset(MODEL_TOKEN_IDS) - {"|", "sil", "[PAD]", "[UNK]"}
WORD_BOUNDARY = "|"
VOCABULARY_SHA256 = _VOCAB["sha256"]


class G2PError(ValueError):
    """The input does not support a responsible automatic reference."""


@dataclass(frozen=True)
class SentencePhonemeReference:
    phonemes: list[str]
    phonemes_by_word: list[list[str]]
    review_flags: list[str]


# Halabi-style labels emitted by the deployed checkpoint. The model card
# documents H/S/T/D/Z, hamza and emphatic vowels. E (ayn), AH (ghayn) and *
# (dhal) are usable tokenizer symbols but are deliberately review-flagged.
CONSONANTS = {
    "ب": "b", "ت": "t", "ث": "th", "ج": "j", "ح": "H", "خ": "x",
    "د": "d", "ذ": "*", "ر": "r", "ز": "z", "س": "s", "ش": "sh",
    "ص": "S", "ض": "D", "ط": "T", "ظ": "Z", "ع": "E", "غ": "AH",
    "ف": "f", "ق": "q", "ك": "k", "ل": "l", "م": "m", "ن": "n",
    "ه": "h", "و": "w", "ي": "y", "ء": "<", "أ": "<", "إ": "<",
    "ؤ": "<", "ئ": "<", "ٱ": "<",
}
FATHA, DAMMA, KASRA, SUKUN, SHADDA = "\u064e", "\u064f", "\u0650", "\u0652", "\u0651"
TANWIN = {"\u064b": FATHA, "\u064c": DAMMA, "\u064d": KASRA}
HARAKA = {FATHA: "a", DAMMA: "u", KASRA: "i"}
VOWEL_MARKS = set(HARAKA) | {SUKUN} | set(TANWIN)
LONG_VOWELS = {FATHA: ({"ا", "ى"}, "aa"), KASRA: ({"ي"}, "ii"), DAMMA: ({"و"}, "uu")}
SUN_LETTERS = {"ت", "ث", "د", "ذ", "ر", "ز", "س", "ش", "ص", "ض", "ط", "ظ", "ل", "ن"}
EMPHATIC_NEIGHBOURS = {"ص", "ض", "ط", "ظ", "ق", "خ", "غ"}
UNCERTAIN_TOKEN_MAP = {"ع", "غ", "ذ"}


def _groups(word: str) -> list[tuple[str, set[str]]]:
    word = unicodedata.normalize("NFC", word.strip())
    if not word:
        raise G2PError("Texte vide")
    groups: list[tuple[str, set[str]]] = []
    for char in word:
        if unicodedata.combining(char):
            if not groups:
                raise G2PError("Diacritique sans lettre")
            if char not in VOWEL_MARKS | {SHADDA}:
                raise G2PError(f"Signe diacritique non pris en charge : {char!r}")
            base, marks = groups[-1]
            if char in marks:
                raise G2PError("Diacritique répété")
            if char in VOWEL_MARKS and marks & VOWEL_MARKS:
                raise G2PError(f"Vocalisation contradictoire sur {base}")
            marks.add(char)
        else:
            if char not in CONSONANTS and char not in {"ا", "ى", "آ", "ة"}:
                raise G2PError(f"Lettre/symbole nécessitant une validation humaine : {char}")
            groups.append((char, set()))
    return groups


def _vowel(mark: str, current: str, following: str | None) -> str:
    token = HARAKA[mark]
    return token.upper() if current in EMPHATIC_NEIGHBOURS or following in EMPHATIC_NEIGHBOURS else token


def _geminate(token: str, flags: set[str]) -> list[str]:
    doubled = token + token
    if doubled in MODEL_PHONEMES:
        return [doubled]
    flags.add("gemination_compound_token_review")
    return [token, token]


def _has_article(groups: list[tuple[str, set[str]]], index: int) -> bool:
    return index + 1 < len(groups) and groups[index][0] == "ا" and not groups[index][1] and groups[index + 1][0] == "ل" and groups[index + 1][1] <= {SUKUN}


def _transcribe_word(word: str, *, word_index: int, words_total: int, pause_final: bool, flags: set[str]) -> list[str]:
    groups = _groups(word)
    tokens: list[str] = []
    i = 0
    final_word = word_index == words_total - 1
    while i < len(groups):
        char, marks = groups[i]
        if _has_article(groups, i):
            if i == 0:
                tokens.append("a")
            following = groups[i + 2][0] if i + 2 < len(groups) else None
            if following is None:
                raise G2PError("Article défini incomplet")
            if following in SUN_LETTERS:
                base, next_marks = groups[i + 2]
                groups[i + 2] = (base, set(next_marks) | {SHADDA})
            else:
                tokens.append("l")
            i += 2
            continue
        # بِالـ / لِلـ: written alif is hamzat al-wasl and is elided in context.
        if char == "ا" and not marks and i + 1 < len(groups) and groups[i + 1][0] == "ل":
            following = groups[i + 2][0] if i + 2 < len(groups) else None
            if following is None:
                raise G2PError("Article contracté incomplet")
            if following in SUN_LETTERS:
                base, next_marks = groups[i + 2]
                groups[i + 2] = (base, set(next_marks) | {SHADDA})
            else:
                tokens.append("l")
            i += 2
            continue
        # The contracted spelling لِلـ contains the preposition لِ plus an
        # article whose alif is not written. Treat the second lam as the
        # assimilated article before the following solar consonant.
        if char == "ل" and marks == {KASRA} and i + 2 < len(groups) and groups[i + 1] == ("ل", set()) and groups[i + 2][0] in SUN_LETTERS:
            base, next_marks = groups[i + 2]
            groups[i + 2] = (base, set(next_marks) | {SHADDA})
            tokens.extend(["l", "i"])
            i += 2
            continue
        if char == "ة":
            if i != len(groups) - 1:
                raise G2PError("Ta marbuta attendue seulement en fin de mot")
            mark = next(iter(marks & VOWEL_MARKS), None)
            if mark is None:
                # Legacy isolated-word entries use pause-form ة without an
                # explicit case mark; no fictitious /t/ is added.
                i += 1
                continue
            if final_word and pause_final:
                flags.add("pausal_tanwin_ta_marbuta_review" if mark in TANWIN else "pausal_ta_marbuta_review")
                i += 1
                continue
            tokens.append("t")
            if mark in TANWIN:
                tokens.extend([_vowel(TANWIN[mark], char, None), "n"])
            elif mark in HARAKA:
                tokens.append(_vowel(mark, char, None))
            elif mark != SUKUN:
                raise G2PError("Ta marbuta sans vocalisation contextuelle")
            i += 1
            continue
        if char == "آ":
            if marks:
                raise G2PError("آ ne doit pas recevoir d'autre diacritique")
            tokens.extend(["<", "aa"])
            i += 1
            continue
        if char in {"ا", "ى"}:
            raise G2PError(f"Alif hors contexte de voyelle longue : {char}")
        base = CONSONANTS[char]
        if char in UNCERTAIN_TOKEN_MAP:
            flags.add("checkpoint_token_mapping_review")
        mark = next(iter(marks & VOWEL_MARKS), None)
        if mark is None:
            raise G2PError(f"Vocalisation absente/ambiguë pour {char}")
        following = groups[i + 1][0] if i + 1 < len(groups) else None
        tokens.extend(_geminate(base, flags) if SHADDA in marks else [base])
        if mark == SUKUN:
            i += 1
            continue
        tanwin = mark in TANWIN
        haraka = TANWIN[mark] if tanwin else mark
        vowel = _vowel(haraka, char, following)
        if vowel.isupper():
            flags.add("emphatic_vowel_context_review")
        long = None
        if i + 1 < len(groups):
            next_char, next_marks = groups[i + 1]
            candidates, long_token = LONG_VOWELS[haraka]
            if next_char in candidates and not next_marks:
                long = long_token.upper() if vowel.isupper() else long_token
        at_word_end = i == len(groups) - 1 or long is not None and i + 1 == len(groups) - 1
        if tanwin:
            if final_word and pause_final and at_word_end:
                flags.add("pausal_tanwin_review")
                if haraka == FATHA and long == "aa":
                    tokens.append("AA" if vowel.isupper() else "aa")
            else:
                tokens.extend([long or vowel, "n"])
        elif final_word and pause_final and at_word_end and long is None:
            flags.add("pausal_case_ending_review")
        else:
            tokens.append(long or vowel)
        i += 2 if long is not None else 1
    return tokens


def arabic_sentence_to_model_reference(text: str, *, pause_final: bool = True) -> SentencePhonemeReference:
    """Generate a word-aligned, tokenizer-compatible proposed reference."""
    words = unicodedata.normalize("NFC", text.strip()).split()
    if not 1 <= len(words) <= 3:
        raise G2PError("La référence doit contenir entre un et trois mots vocalisés")
    flags: set[str] = {"g2p_provisional_requires_linguistic_review"}
    by_word = [_transcribe_word(word, word_index=index, words_total=len(words), pause_final=pause_final, flags=flags) for index, word in enumerate(words)]
    flat = [token for index, tokens in enumerate(by_word) for token in (tokens + ([WORD_BOUNDARY] if index < len(by_word) - 1 else []))]
    unknown = [token for token in flat if token != WORD_BOUNDARY and token not in MODEL_PHONEMES]
    if unknown:
        raise G2PError(f"Token(s) absent(s) du vocabulaire du checkpoint : {unknown}")
    return SentencePhonemeReference(flat, by_word, sorted(flags))


def arabic_sentence_to_model_phonemes(text: str, *, pause_final: bool = True) -> list[str]:
    return arabic_sentence_to_model_reference(text, pause_final=pause_final).phonemes


def arabic_to_model_phonemes(text: str) -> list[str]:
    """Legacy single-word API; it preserves written word-final harakat."""
    normalized = unicodedata.normalize("NFC", text.strip())
    if len(normalized.split()) != 1:
        raise G2PError("Cette API accepte un mot isolé ; utiliser la fonction de phrase")
    return arabic_sentence_to_model_reference(normalized, pause_final=False).phonemes


def validate_manual_phonemes(value: str) -> list[str]:
    tokens = value.strip().split()
    if not tokens:
        raise G2PError("Référence phonémique manuelle vide")
    unknown = [token for token in tokens if token not in MODEL_PHONEMES | {WORD_BOUNDARY}]
    if unknown:
        raise G2PError(f"Token(s) inconnus pour ce modèle : {unknown}")
    return tokens


def vocabulary_fingerprint() -> str:
    payload = json.dumps(MODEL_TOKEN_IDS, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(payload).hexdigest()
