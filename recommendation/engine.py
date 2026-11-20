"""AcoDyslex v0.1: prototype explicable, non diagnostique, 100% standard library.

Usage: python recommendation_engine.py sample_session.json
Observations ASR seules: aucune recommandation individualisee automatique.
Les seuils de repetition, les poids de score et les criteres de maitrise
sont des choix d'ingenierie PROVISOIRES, pas des seuils cliniques valides.
"""
from __future__ import annotations
import json
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
TIERS = {
    "inversion": 1.0,
    "omission": 0.90,
    "insertion": 0.80,
    "consonant_substitution": 0.70,
    "short_vowel_confusion": 0.25,
    "long_vowel_confusion": 0.15,
}


def _limit01(v: Any, default: float) -> float:
    try:
        return min(1.0, max(0.0, float(v)))
    except (ValueError, TypeError):
        return default


def _nonnegative_int(value: Any) -> int | None:
    """Parse counters defensively; malformed counters require review."""
    if isinstance(value, bool):
        return None
    try:
        parsed = int(value)
    except (ValueError, TypeError, OverflowError):
        return None
    if parsed < 0 or str(parsed) != str(value).strip():
        return None
    return parsed


def recommend(session: dict[str, Any], tax: dict | None = None,
              exercises: dict | None = None, max_domains: int = 2,
              per_domain: int = 2) -> dict[str, Any]:
    """Retourne un plan pedagogique et les besoins de verification.

    contract:
      - verification_status: human_verified | automated_unverified
      - count: nb d'erreurs confirmees, opportunities: essais valides
      - distinct_items: nb de cibles/mots differents confirmes
      - mastery[error_type]: proportion [0..1], valeurs estimees ou absentes
    """
    tax = tax or json.loads((HERE / 'taxonomy.json').read_text(encoding='utf-8'))
    exercises = exercises or json.loads((HERE / 'exercises.json').read_text(encoding='utf-8'))
    type_map = {e['type']: e for e in tax['error_types']}
    catalog = {}
    for item in exercises['exercises']:
        catalog.setdefault(item['error_type'], []).append(item)
    mastery = session.get('mastery') or {}
    candidates = []
    needs_review = []
    for obs in session.get('observations') or []:
        typ = obs.get('error_type')
        if typ not in type_map:
            needs_review.append({'error_type': typ, 'reason': 'Type inconnu ou non encore cartographie'})
            continue
        status = obs.get('verification_status', 'automated_unverified')
        count = _nonnegative_int(obs.get('count'))
        opportunities = _nonnegative_int(obs.get('opportunities'))
        distinct_items = _nonnegative_int(obs.get('distinct_items'))
        if count is None or opportunities is None or distinct_items is None:
            needs_review.append({'error_type': typ, 'target': obs.get('target'),
                                 'reason': 'Compteurs invalides : vérification humaine requise'})
            continue
        if status != 'human_verified':
            needs_review.append({'error_type': typ, 'target': obs.get('target'),
                                 'reason': 'Validation audio/humaine requise : ASR seul non probant'})
            continue
        if opportunities < count or opportunities < 2:
            needs_review.append({'error_type': typ, 'target': obs.get('target'),
                                 'reason': 'Denominateur invalide ou nombre d’essais insuffisant'})
            continue
        if count < 2 or distinct_items < 2:
            needs_review.append({'error_type': typ, 'target': obs.get('target'),
                                 'reason': 'Confirmer sur au moins 2 occurrences et 2 items distincts'})
            continue
        if (typ == 'long_vowel_confusion' and not obs.get('meaning_changed', False)
                and count < 3):
            needs_review.append({'error_type': typ, 'target': obs.get('target'),
                                 'reason': 'Ecart de duree isole/peu repete sans impact lexical : faible priorite'})
            continue
        # Hypothese de classement, PAS un niveau de gravite clinique.
        freq = count / opportunities
        current_mastery = _limit01(mastery.get(typ), 0.50)
        priority_score = 0.50 * freq + 0.35 * (1-current_mastery) + 0.15*TIERS[typ]
        candidates.append({'type': typ, 'obs': obs, 'score': priority_score,
                           'freq': freq, 'mastery': current_mastery})

    # Agreger plusieurs observations du meme type : choisir la plus probante,
    # pour eviter deux interventions dupliquees pour le meme domaine.
    per_type = {}
    for item in candidates:
        typ = item['type']
        if typ not in per_type or item['score'] > per_type[typ]['score']:
            per_type[typ] = item
    ordered = sorted(per_type.values(), key=lambda c: (-c['score'], -TIERS[c['type']]))[:max_domains]
    proposals = []
    for item in ordered:
        typ = item['type']
        # Regle d'echelle provisoire; niveau cible suivant maitrise observee.
        level = 1 if item['mastery'] < 0.60 else 2
        pool = catalog.get(typ, [])
        chosen = sorted(pool, key=lambda e: (abs(e['level']-level), e['id']))[:per_domain]
        proposals.append({
            'error_type': typ,
            'taxonomy_code': type_map[typ]['code'],
            'priority_score_provisional': round(item['score'], 4),
            'error_frequency': f"{item['obs']['count']}/{item['obs']['opportunities']}",
            'observation_provenance': item['obs'].get('provenance', 'unspecified'),
            'observation_verification_status': item['obs'].get('verification_status'),
            'explanation_fr': (
                f"Erreur {type_map[typ]['label_fr'].lower()} confirmee sur "
                f"{item['obs']['count']} essais parmi {item['obs']['opportunities']}, "
                f"et au moins {item['obs']['distinct_items']} items distincts. "
                'Les exercices ciblent la competence associee ; leur efficacite doit etre suivie.'
            ),
            'exercises': [{k:e[k] for k in ('id','title_fr','instruction_ar','level',
                                            'skill','material','feedback_fr','estimated_minutes')}
                          for e in chosen]
        })
    return {
        'engine_version': '0.1.0', 'rule_version': '0.1.0', 'child_id': session.get('child_id'),
        'session_id': session.get('session_id'),
        'status': 'recommendations_proposed' if proposals else 'verification_required',
        'is_medical_diagnosis': False,
        'individualized_recommendations': proposals,
        'needs_verification': needs_review,
        'important_note_fr': (
            'Prototype: la recommandation pedagogique repose ici sur une verification humaine; '
            'les poids de priorisation et criteres de repetition sont a evaluer avec des specialistes.'
        )
    }

if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python recommendation_engine.py <session.json>')
    session = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    print(json.dumps(recommend(session), ensure_ascii=False, indent=2))
