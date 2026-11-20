"""Validated contracts and deterministic aggregation for grouped reading analysis."""
from __future__ import annotations

from collections import Counter, defaultdict
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


SAFE_ID = r"^[A-Za-z0-9_-]+$"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class BatchManifestWord(StrictModel):
    word_id: str = Field(min_length=1, max_length=64, pattern=SAFE_ID)
    unit_id: str | None = Field(default=None, min_length=1, max_length=64, pattern=SAFE_ID)
    unit_type: Literal["word", "short_sentence"] = "word"
    word_order: int = Field(ge=1, le=15, strict=True)
    reference_text: str = Field(min_length=1, max_length=40)
    expected_phonemes: list[str] = Field(default_factory=list, max_length=32)
    phonemes_by_word: list[dict[str, Any]] = Field(default_factory=list, max_length=3)
    word_count: int = Field(default=1, ge=1, le=3, strict=True)
    max_recording_seconds: float = Field(default=10, ge=1, le=20)

    @model_validator(mode="after")
    def unit_matches_legacy_identifier(self):
        self.unit_id = self.unit_id or self.word_id
        if self.unit_id != self.word_id:
            raise ValueError("unit_id doit correspondre à word_id")
        if self.unit_type == "word" and self.word_count != 1:
            raise ValueError("word requiert word_count=1")
        if self.unit_type == "short_sentence" and self.word_count not in {2, 3}:
            raise ValueError("short_sentence requiert 2 ou 3 mots")
        if self.unit_type == "short_sentence" and len(self.reference_text.split()) != self.word_count:
            raise ValueError("word_count doit correspondre au texte de short_sentence")
        if self.phonemes_by_word:
            words = self.reference_text.split()
            if len(self.phonemes_by_word) != self.word_count or [item.get("word") for item in self.phonemes_by_word] != words:
                raise ValueError("phonemes_by_word doit correspondre aux mots de la phrase")
            if any(not isinstance(item.get("phonemes"), list) or not item["phonemes"] for item in self.phonemes_by_word):
                raise ValueError("Chaque mot doit avoir des phonèmes de référence")
        return self


class BatchManifest(StrictModel):
    analysis_id: str = Field(min_length=1, max_length=64, pattern=SAFE_ID)
    child_id: str = Field(min_length=1, max_length=64, pattern=SAFE_ID)
    session_id: str = Field(min_length=1, max_length=64, pattern=SAFE_ID)
    words: list[BatchManifestWord] = Field(min_length=15, max_length=15)

    @field_validator("words")
    @classmethod
    def complete_ordered_plan(cls, words: list[BatchManifestWord]) -> list[BatchManifestWord]:
        if len({word.word_id for word in words}) != 15:
            raise ValueError("Les 15 word_id doivent être uniques")
        if [word.word_order for word in words] != list(range(1, 16)):
            raise ValueError("Les mots doivent être ordonnés de 1 à 15")
        return words


class BatchWordResult(StrictModel):
    word_id: str = Field(min_length=1, max_length=64, pattern=SAFE_ID)
    unit_id: str | None = Field(default=None, min_length=1, max_length=64, pattern=SAFE_ID)
    unit_type: Literal["word", "short_sentence"] = "word"
    word_order: int = Field(ge=1, le=15, strict=True)
    reference_text: str = Field(min_length=1, max_length=40)
    recognized_text: str | None = Field(default=None, max_length=300)
    analysis_status: Literal["ok", "failed", "insufficient_audio"]
    candidate_errors: list[dict[str, Any]] = Field(default_factory=list, max_length=64)
    expected_phonemes: list[str] = Field(default_factory=list, max_length=64)
    phonemes_by_word: list[dict[str, Any]] = Field(default_factory=list, max_length=3)
    predicted_phonemes: list[str] = Field(default_factory=list, max_length=64)
    phoneme_classification: dict[str, Any] | None = None
    lexical_candidates: list[dict[str, Any]] = Field(default_factory=list, max_length=64)
    word_alignment: list[dict[str, Any]] = Field(default_factory=list, max_length=32)
    acoustic_indicators: dict[str, Any] = Field(default_factory=dict)
    confidence: float | None = Field(default=None, ge=0, le=1)
    uncertainty: str | None = Field(default=None, max_length=300)
    duration_seconds: float | None = Field(default=None, ge=0, le=20.25)
    audio_id: str = Field(min_length=1, max_length=160)
    provenance: str = "modal_batch_candidate"


class BatchGlobalSummary(StrictModel):
    total_words: int = 15
    analyzed_words: int
    unusable_words: int
    words_with_candidates: int
    candidate_error_count: int
    error_type_frequencies: dict[str, int]
    error_type_word_frequencies: dict[str, int]
    recurrent_error_types: list[str]
    potential_skills: list[str]
    uncertain_word_ids: list[str]
    analyzed_word_units: int = 0
    analyzed_sentence_units: int = 0
    provenance: str = "aggregated_from_word_results"


class BatchAnalysisResponse(StrictModel):
    analysis_id: str = Field(min_length=1, max_length=64, pattern=SAFE_ID)
    session_id: str = Field(min_length=1, max_length=64, pattern=SAFE_ID)
    batch_status: Literal["completed", "partial_results", "batch_failed"]
    word_results: list[BatchWordResult] = Field(min_length=15, max_length=15)
    global_summary: BatchGlobalSummary
    model_versions: dict[str, str] = Field(default_factory=dict)
    processing_metadata: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def associations_are_complete(self):
        if len({item.word_id for item in self.word_results}) != 15:
            raise ValueError("word_results contient des word_id dupliqués")
        if {item.word_order for item in self.word_results} != set(range(1, 16)):
            raise ValueError("word_results doit couvrir les ordres 1 à 15")
        return self


ERROR_SKILLS = {
    "omission": "phoneme_detection",
    "insertion": "phoneme_discrimination",
    "inversion": "auditory_sequencing",
    "substitution": "phoneme_discrimination",
    "consonant_substitution": "phoneme_discrimination",
    "short_vowel_confusion": "short_vowel_reading",
    "long_vowel_confusion": "long_vowel_reading",
}


def candidate_type(candidate: dict[str, Any]) -> str | None:
    value = candidate.get("error_type") or candidate.get("type")
    return value if isinstance(value, str) and value else None


def build_global_summary(results: list[BatchWordResult]) -> BatchGlobalSummary:
    """Aggregate counts while keeping error occurrences distinct from affected words."""
    occurrences: Counter[str] = Counter()
    affected_words: defaultdict[str, set[str]] = defaultdict(set)
    uncertain: list[str] = []
    analyzed = 0
    words_with_candidates = 0
    word_units = 0
    sentence_units = 0
    for result in results:
        if result.analysis_status == "ok":
            analyzed += 1
            if result.unit_type == "short_sentence":
                sentence_units += 1
            else:
                word_units += 1
        if result.analysis_status != "ok" or result.uncertainty:
            uncertain.append(result.word_id)
        if result.candidate_errors:
            words_with_candidates += 1
        for candidate in result.candidate_errors:
            error_type = candidate_type(candidate)
            if not error_type:
                continue
            raw_count = candidate.get("count", 1)
            count = raw_count if isinstance(raw_count, int) and raw_count > 0 else 1
            occurrences[error_type] += count
            affected_words[error_type].add(result.word_id)
    word_frequencies = {key: len(value) for key, value in sorted(affected_words.items())}
    recurrent = [key for key, count in word_frequencies.items() if count >= 2]
    skills = sorted({ERROR_SKILLS[key] for key in occurrences if key in ERROR_SKILLS})
    return BatchGlobalSummary(
        analyzed_words=analyzed,
        unusable_words=len(results) - analyzed,
        words_with_candidates=words_with_candidates,
        candidate_error_count=sum(occurrences.values()),
        error_type_frequencies=dict(sorted(occurrences.items())),
        error_type_word_frequencies=word_frequencies,
        recurrent_error_types=recurrent,
        potential_skills=skills,
        uncertain_word_ids=uncertain,
        analyzed_word_units=word_units,
        analyzed_sentence_units=sentence_units,
    )
