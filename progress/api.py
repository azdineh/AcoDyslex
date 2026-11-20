"""FastAPI routes for longitudinal pedagogical progress V0.2."""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Path, Query, Response, status

from . import service
from .models import (
    AttemptView,
    ChildProfileCreate,
    ChildProfileList,
    ChildProfileUpdate,
    ChildProfileView,
    CompletionView,
    ExerciseAttemptCreate,
    HistoryView,
    LongitudinalRecommendationView,
    ObservationBatchCreate,
    RecommendationSetCreate,
    SessionComplete,
    SessionCreate,
    SessionStateUpdate,
    SessionView,
    WordAnalysisCreate,
)

router = APIRouter(prefix="/v1/progress", tags=["progress-v0.2"])
SafeId = Annotated[str, Path(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")]


@router.post(
    "/sessions", response_model=SessionView, status_code=status.HTTP_201_CREATED,
    summary="Créer une session pédagogique idempotente",
)
def create_session(payload: SessionCreate):
    """Crée aussi le profil pseudonymisé s'il n'existe pas encore."""
    return service.create_session(payload)


@router.post("/children", response_model=ChildProfileView, status_code=status.HTTP_201_CREATED)
def create_child_profile(payload: ChildProfileCreate):
    return service.create_profile(payload)


@router.get("/children", response_model=ChildProfileList)
def list_child_profiles():
    return service.list_profiles()


@router.patch("/children/{child_id}", response_model=ChildProfileView)
def update_child_profile(child_id: SafeId, payload: ChildProfileUpdate):
    return service.update_profile(child_id, payload)


@router.delete("/children/{child_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_child_profile(child_id: SafeId):
    service.delete_profile(child_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.patch("/sessions/{session_id}/state", response_model=SessionView)
def update_session_state(session_id: SafeId, payload: SessionStateUpdate):
    return service.update_session_state(session_id, payload)


@router.post("/sessions/{session_id}/words/{word_id}/analysis", response_model=SessionView)
def add_word_analysis(session_id: SafeId, word_id: SafeId, payload: WordAnalysisCreate):
    return service.add_word_analysis(session_id, word_id, payload)


@router.post("/sessions/{session_id}/observations", response_model=SessionView)
def add_session_observations(session_id: SafeId, payload: ObservationBatchCreate):
    return service.add_observations(session_id, payload)


@router.post("/sessions/{session_id}/recommendations", response_model=SessionView)
def set_session_recommendations(session_id: SafeId, payload: RecommendationSetCreate):
    return service.set_recommendations(session_id, payload)


@router.post(
    "/sessions/{session_id}/attempts", response_model=AttemptView,
    status_code=status.HTTP_201_CREATED, summary="Enregistrer une tentative idempotente",
)
def add_attempt(session_id: SafeId, payload: ExerciseAttemptCreate):
    return service.add_attempt(session_id, payload)


@router.post(
    "/sessions/{session_id}/complete", response_model=CompletionView,
    summary="Clôturer une session et actualiser les estimations pédagogiques",
)
def complete_session(session_id: SafeId, payload: SessionComplete):
    return service.complete_session(session_id, payload)


@router.get(
    "/children/{child_id}", response_model=ChildProfileView,
    summary="Lire le profil pédagogique actuel",
)
def child_profile(child_id: SafeId):
    return service.get_profile(child_id)


@router.get(
    "/children/{child_id}/history", response_model=HistoryView,
    summary="Lire l'historique chronologique paginé",
)
def child_history(
    child_id: SafeId,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=20, ge=1, le=100),
):
    return service.get_history(child_id, offset, limit)


@router.get(
    "/children/{child_id}/recommendations", response_model=LongitudinalRecommendationView,
    summary="Obtenir les recommandations longitudinales explicables",
)
def child_recommendations(
    child_id: SafeId,
    session_id: str | None = Query(default=None, min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$"),
):
    return service.get_recommendations(child_id, session_id)

