"""Pydantic contracts exposed by the V0.2 progress API."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from recommendation.api import PreviewObservation

Identifier = str
SessionStatus = Literal["open", "completed"]
SessionState = Literal[
    "created", "reading", "analyzing",  # compatibility with V0.2/V0.3
    "recording", "paused", "ready_to_analyze", "analyzing_batch",
    "batch_failed", "partial_results", "interrupted",
    "review", "remediation", "abandoned", "completed",
]
AssistanceLevel = Literal["independent", "light", "moderate", "full"]
AvatarId = Literal["neutral", "sky", "mint", "coral", "violet"]


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PedagogicalSettings(StrictModel):
    """Provisional engineering parameters; none are clinical thresholds."""

    initial_mastery: float = Field(default=0.5, ge=0, le=1)
    learning_rate: float = Field(default=0.25, gt=0, le=0.5)
    mastery_threshold: float = Field(default=0.8, gt=0, le=1)
    review_threshold: float = Field(default=0.55, ge=0, lt=1)
    max_recent_repetitions: int = Field(default=2, ge=1, le=10)
    retention_days: int = Field(default=365, ge=1, le=3650)

    @model_validator(mode="after")
    def thresholds_are_ordered(self):
        if self.review_threshold >= self.mastery_threshold:
            raise ValueError("review_threshold doit être inférieur à mastery_threshold")
        return self


class ChildProfileCreate(StrictModel):
    child_id: Identifier = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    display_name: str = Field(min_length=1, max_length=40)
    age: int = Field(ge=5, le=18, strict=True)
    sex: Literal["female", "male", "unspecified"] = "unspecified"
    avatar_id: AvatarId = "neutral"

    @field_validator("display_name")
    @classmethod
    def clean_display_name(cls, value: str) -> str:
        cleaned = " ".join(value.split())
        if not cleaned:
            raise ValueError("display_name ne peut pas être vide")
        return cleaned


class ChildProfileUpdate(StrictModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=40)
    age: int | None = Field(default=None, ge=5, le=18, strict=True)
    sex: Literal["female", "male", "unspecified"] | None = None
    avatar_id: AvatarId | None = None

    @field_validator("display_name")
    @classmethod
    def clean_display_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = " ".join(value.split())
        if not cleaned:
            raise ValueError("display_name ne peut pas être vide")
        return cleaned


class PhonemesByWord(StrictModel):
    """A reference segment kept separate for word-level Modal alignment."""
    word: str = Field(min_length=1, max_length=40)
    phonemes: list[str] = Field(min_length=1, max_length=32)


class ArabicPhonemePresentation(StrictModel):
    """Display metadata only; `symbol` remains the analytical token."""
    symbol: str = Field(min_length=1, max_length=16)
    arabic: str | None = Field(default=None, max_length=32)
    name_ar: str | None = Field(default=None, max_length=120)
    category: str | None = Field(default=None, max_length=64)
    mapping_status: str = Field(default="non_documente", max_length=80)


class ReadingWordSelection(StrictModel):
    word_id: Identifier = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    # V0.4 keeps word_id/reading_words for V0.1-V0.3 clients while treating
    # every entry as a reading unit. unit_id defaults to the legacy word_id.
    unit_id: Identifier | None = Field(default=None, min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    unit_type: Literal["word", "short_sentence"] = "word"
    text: str = Field(min_length=1, max_length=40)
    order: int = Field(ge=1, le=15, strict=True)
    role: Literal["revision", "consolidation", "transfer"]
    category: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9_]+$")
    expected_phonemes: list[str] = Field(default_factory=list, max_length=32)
    expected_phonemes_ar: list[ArabicPhonemePresentation] = Field(default_factory=list, max_length=32)
    phonemes_by_word: list[PhonemesByWord] = Field(default_factory=list, max_length=3)
    phoneme_reference_status: str = Field(default="missing", min_length=1, max_length=80)
    requires_linguistic_review: bool = False
    reference_warnings: list[str] = Field(default_factory=list, max_length=16)
    word_count: int = Field(default=1, ge=1, le=3, strict=True)
    difficulty_level: int = Field(default=1, ge=1, le=5, strict=True)
    target_skills: list[str] = Field(default_factory=list, max_length=8)
    language_variety: str = Field(default="ar-MSA", min_length=2, max_length=32)
    max_recording_seconds: float = Field(default=10, ge=1, le=20)

    @model_validator(mode="after")
    def validate_unit_shape(self):
        self.unit_id = self.unit_id or self.word_id
        if self.unit_id != self.word_id:
            raise ValueError("unit_id doit correspondre à word_id pour assurer la compatibilité")
        if self.unit_type == "word" and self.word_count != 1:
            raise ValueError("Un mot isolé doit avoir word_count=1")
        if self.unit_type == "short_sentence" and self.word_count not in {2, 3}:
            raise ValueError("Une phrase courte doit contenir 2 ou 3 mots")
        if self.unit_type == "short_sentence" and len(self.text.split()) != self.word_count:
            raise ValueError("word_count doit correspondre aux mots de la phrase courte")
        if self.phonemes_by_word:
            words = self.text.split()
            if len(self.phonemes_by_word) != self.word_count or [item.word for item in self.phonemes_by_word] != words:
                raise ValueError("phonemes_by_word doit conserver les frontières et le texte des mots")
            flattened = [token for index, item in enumerate(self.phonemes_by_word) for token in (item.phonemes + (["|"] if index < len(self.phonemes_by_word) - 1 else []))]
            if self.expected_phonemes and self.expected_phonemes != flattened:
                raise ValueError("expected_phonemes doit correspondre à phonemes_by_word avec les frontières |")
        if self.expected_phonemes_ar and [item.symbol for item in self.expected_phonemes_ar] != self.expected_phonemes:
            raise ValueError("expected_phonemes_ar doit rester aligné avec expected_phonemes")
        if not self.target_skills:
            self.target_skills = [self.category]
        return self


class ReadingWordView(ReadingWordSelection):
    recording_id: str | None = None
    analysis_status: str | None = None
    observed_text: str | None = None
    predicted_phonemes: list[str] = Field(default_factory=list, max_length=64)
    candidate_errors: list[dict[str, Any]] = Field(default_factory=list)
    analyzed_at: str | None = None


class SessionCreate(StrictModel):
    model_config = ConfigDict(extra="forbid", json_schema_extra={"example": {
        "session_id": "session_demo_01", "child_id": "child_demo_01",
        "started_at": "2026-11-08T09:00:00Z", "recommendation_engine_version": "0.2.0",
        "recommended_exercise_ids": ["OMI01", "OMI02"], "observations": [],
    }})

    session_id: Identifier = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    child_id: Identifier = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    started_at: datetime = Field(default_factory=utc_now)
    recommendation_engine_version: str = Field(default="0.2.0", min_length=1, max_length=32)
    pedagogical_settings: PedagogicalSettings | None = None
    observations: list[PreviewObservation] = Field(default_factory=list, max_length=200)
    recommended_exercise_ids: list[str] = Field(default_factory=list, max_length=32)
    reading_words: list[ReadingWordSelection] = Field(default_factory=list, max_length=15)

    @field_validator("started_at")
    @classmethod
    def timezone_required(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("started_at doit inclure un fuseau horaire")
        return value

    @field_validator("recommended_exercise_ids")
    @classmethod
    def recommendations_are_unique(cls, value: list[str]) -> list[str]:
        if len(value) != len(set(value)):
            raise ValueError("recommended_exercise_ids ne doit pas contenir de doublons")
        return value

    @field_validator("reading_words")
    @classmethod
    def reading_plan_is_complete(cls, value: list[ReadingWordSelection]) -> list[ReadingWordSelection]:
        # Empty preserves the V0.2 contract. V0.3 sessions always contain 15 words.
        if value and len(value) != 15:
            raise ValueError("reading_words doit contenir exactement 15 mots")
        if value:
            if len({item.word_id for item in value}) != 15 or {item.order for item in value} != set(range(1, 16)):
                raise ValueError("reading_words exige 15 identifiants uniques et les ordres 1 à 15")
        return value


class SessionStateUpdate(StrictModel):
    child_id: Identifier = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    state: SessionState


class WordAnalysisCreate(StrictModel):
    child_id: Identifier = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    recording_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    analysis_status: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9_]+$")
    observed_text: str | None = Field(default=None, max_length=100)
    candidate_errors: list[dict[str, Any]] = Field(default_factory=list, max_length=32)


class ObservationBatchCreate(StrictModel):
    submission_id: Identifier = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    child_id: Identifier = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    observations: list[PreviewObservation] = Field(min_length=1, max_length=200)


class RecommendationSetCreate(StrictModel):
    child_id: Identifier = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    exercise_ids: list[str] = Field(min_length=7, max_length=7)

    @field_validator("exercise_ids")
    @classmethod
    def exercises_are_unique(cls, value: list[str]) -> list[str]:
        if len(set(value)) != 7:
            raise ValueError("exercise_ids doit contenir exactement sept exercices distincts")
        return value


class ExerciseAttemptCreate(StrictModel):
    model_config = ConfigDict(extra="forbid", json_schema_extra={"example": {
        "attempt_id": "attempt_demo_01", "child_id": "child_demo_01",
        "exercise_id": "OMI01", "skill": "phoneme_detection",
        "correct_count": 4, "total_count": 5, "assistance_level": "light",
        "evaluation_context": "practice", "item_set_id": "set_demo_a",
        "novel_items": False, "completed_at": "2026-11-08T09:20:00Z",
    }})

    attempt_id: Identifier = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    child_id: Identifier = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    activity_id: str | None = Field(default=None, max_length=48, pattern=r"^[a-z_]+$")
    exercise_id: str = Field(min_length=1, max_length=32, pattern=r"^[A-Z0-9_-]+$")
    skill: str = Field(min_length=1, max_length=80, pattern=r"^[a-z0-9_]+$")
    correct_count: int = Field(ge=0, le=10000, strict=True)
    total_count: int = Field(gt=0, le=10000, strict=True)
    assistance_level: AssistanceLevel = "independent"
    evaluation_context: Literal["practice", "pre", "post", "transfer", "retention"] = "practice"
    item_set_id: str | None = Field(default=None, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    novel_items: bool = False
    activity_family: Literal[
        "auditory_discrimination", "phoneme_grapheme_matching", "syllable_ordering",
        "missing_letter", "letter_ordering", "extra_phoneme_detection", "guided_reading",
    ] | None = None
    interaction_attempts: int = Field(default=1, ge=1, le=100, strict=True)
    help_used: bool = False
    outcome: Literal["independent_success", "assisted_success", "not_yet_success"] | None = None
    completed_at: datetime = Field(default_factory=utc_now)

    @model_validator(mode="after")
    def valid_score(self):
        if self.correct_count > self.total_count:
            raise ValueError("correct_count ne peut pas dépasser total_count")
        if self.completed_at.tzinfo is None or self.completed_at.utcoffset() is None:
            raise ValueError("completed_at doit inclure un fuseau horaire")
        return self


class SessionComplete(StrictModel):
    model_config = ConfigDict(extra="forbid", json_schema_extra={"example": {
        "child_id": "child_demo_01", "completed_at": "2026-11-08T09:30:00Z",
    }})

    child_id: Identifier = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    completed_at: datetime = Field(default_factory=utc_now)

    @field_validator("completed_at")
    @classmethod
    def timezone_required(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("completed_at doit inclure un fuseau horaire")
        return value


class ObservationView(StrictModel):
    observation_id: str
    error_type: str | None
    count: int
    opportunities: int
    distinct_items: int
    verification_status: str
    provenance: str


class AttemptView(StrictModel):
    attempt_id: str
    session_id: str
    child_id: str
    activity_id: str | None = None
    exercise_id: str
    skill: str
    correct_count: int
    total_count: int
    assistance_level: str
    evaluation_context: str
    item_set_id: str | None
    novel_items: bool
    activity_family: str | None = None
    interaction_attempts: int = 1
    help_used: bool = False
    outcome: str | None = None
    completed_at: str


class SessionView(StrictModel):
    session_id: str
    child_id: str
    started_at: str
    completed_at: str | None
    status: SessionStatus
    state: SessionState = "created"
    recommendation_engine_version: str
    recommended_exercise_ids: list[str] = Field(default_factory=list)
    observations: list[ObservationView] = Field(default_factory=list)
    attempts: list[AttemptView] = Field(default_factory=list)
    reading_words: list[ReadingWordView] = Field(default_factory=list)


class SkillProgressView(StrictModel):
    skill: str
    mastery_estimate: float
    evidence_count: int
    updated_at: str
    interpretation: str


class ChildProfileView(StrictModel):
    child_id: str
    display_name: str | None = None
    age: int | None = None
    sex: str | None = None
    avatar_id: AvatarId = "neutral"
    created_at: str
    updated_at: str
    retention_until: str
    pedagogical_settings: PedagogicalSettings
    skills: list[SkillProgressView]
    disclaimer: str


class ChildProfileList(StrictModel):
    children: list[ChildProfileView]


class HistoryView(StrictModel):
    child_id: str
    offset: int
    limit: int
    total: int
    next_offset: int | None
    sessions: list[SessionView]


class CompletionView(StrictModel):
    session: SessionView
    profile: ChildProfileView
    already_completed: bool


class LongitudinalRecommendationView(StrictModel):
    child_id: str
    engine_version: str
    status: str
    is_medical_diagnosis: bool
    individualized_recommendations: list[dict[str, Any]]
    recommended_exercises: list[dict[str, Any]] = Field(default_factory=list)
    needs_verification: list[dict[str, Any]]
    skill_profile: list[SkillProgressView]
    important_note_fr: str

