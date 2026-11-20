'use strict';

// Use textContent exclusively: tokens and explanations come from a remote service.
function displayPhonemeClassification(result) {
  const box = document.getElementById('phonemeResult');
  if (!box) return;
  box.replaceChildren();
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const add = (tag, text, className) => {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    box.appendChild(element);
    return element;
  };
  const labels = {omission: 'Omissions', inversion: 'Inversions', insertion: 'Insertions', substitution: 'Substitutions'};
  const classification = isObject(result?.phoneme_classification) ? result.phoneme_classification : null;
  const source = result?.reference_source;
  const referenceStatus = result?.reference_validation_status || classification?.reference_status;
  let reference = 'Provenance de la référence non précisée ; validation humaine à vérifier.';
  if (referenceStatus === 'missing' || source === 'missing') {
    reference = 'Référence phonémique absente : comparaison indisponible.';
  } else if (referenceStatus === 'g2p_provisional' || (typeof source === 'string' && source.startsWith('g2p_'))) {
    reference = 'Référence G2P provisoire : conversion automatique, non validée humainement.';
  } else if (referenceStatus === 'provided_unverified' || source === 'manual') {
    reference = 'Référence fournie manuellement, non validée humainement.';
  } else if (referenceStatus === 'human_verified') {
    reference = 'Référence déclarée vérifiée humainement par le service. Les écarts ASR restent des hypothèses.';
  }
  add('p', reference, 'classification-reference');
  if (typeof result?.reference_warning === 'string' && result.reference_warning) add('p', result.reference_warning);
  add('p', 'Hypothèse ASR — confirmation humaine nécessaire. Un écart entre la référence et la reconnaissance ne prouve pas une erreur de l’enfant.', 'notice');

  if (!classification || result?.classification_available === false) {
    add('p', 'Classification indisponible. Aucun compte d’erreurs ne peut être déduit.');
    if (typeof result?.classification_note === 'string') add('p', result.classification_note);
    return;
  }
  if (classification.status !== 'candidate_only') {
    const reasons = {
      skipped_missing_reference: 'référence phonémique absente',
      skipped_missing_observation: 'phonèmes reconnus absents',
      skipped_unsupported_tokens: 'phonèmes non pris en charge'
    };
    add('p', `Classification indisponible : ${reasons[classification.status] || 'statut non pris en charge'}.`);
    if (typeof classification.reason === 'string') add('p', classification.reason);
    return;
  }
  const analysis = classification.analysis;
  const counts = analysis?.error_counts;
  if (!isObject(analysis) || !isObject(counts) ||
      !Object.keys(labels).every(type => Number.isSafeInteger(counts[type]) && counts[type] >= 0) ||
      (analysis.type_ambiguous != null && typeof analysis.type_ambiguous !== 'boolean') ||
      (analysis.errors != null && (!Array.isArray(analysis.errors) || !analysis.errors.every(isObject))) ||
      referenceStatus === 'missing' || source === 'missing' || classification.confirmed_child_error === true) {
    add('p', 'Classification indisponible : résultat incomplet ou incohérent. Les comptes doivent être vérifiés.');
    return;
  }
  if (analysis.type_ambiguous === true) {
    add('p', 'Classification ambiguë / à réviser : les types et comptes ci-dessous sont provisoires.', 'notice');
  }
  const summary = add('dl', '', 'classification-counts');
  for (const [type, label] of Object.entries(labels)) {
    const item = document.createElement('div');
    const term = document.createElement('dt');
    const count = document.createElement('dd');
    term.textContent = label;
    count.textContent = String(counts[type]);
    item.append(term, count);
    summary.appendChild(item);
  }
  add('p', 'Comptes d’écarts candidats, sans mesure de gravité pédagogique. Les voyelles finales et les écarts de longueur vocalique demandent une interprétation contextuelle.');
  if (Array.isArray(analysis.errors) && analysis.errors.length) {
    const details = add('details', '');
    const title = document.createElement('summary');
    title.textContent = 'Détail des écarts candidats (positions et phonèmes fournis par le service)';
    const content = document.createElement('pre');
    // Preserve the actual operation schema instead of guessing position field names.
    content.textContent = JSON.stringify(analysis.errors, null, 2);
    details.append(title, content);
  } else if (Object.values(counts).some(count => count > 0)) {
    add('p', 'Détail des opérations non fourni par le service.');
  }
  if (typeof analysis.standard_per === 'number' && Number.isFinite(analysis.standard_per) && analysis.standard_per >= 0) {
    add('p', `PER référence–ASR : ${analysis.standard_per}. Écart entre séquences, non validé sur un audio annoté humainement.`);
  }


  // Extension AcoDyslex : second niveau de classification fourni par Modal.
  // Ne remplace pas `phoneme_classification` (phase 3 : provenance + alignement).
  // Les éléments restent des hypothèses ASR, jamais des erreurs confirmées.
  const pedagogicalItems = result?.phoneme_classification_items;
  if (pedagogicalItems === undefined) {
    add('p', 'Classification pédagogique détaillée non transmise par Modal (phoneme_classification_items absent).', 'notice');
  } else if (!Array.isArray(pedagogicalItems) || !pedagogicalItems.every(isObject)) {
    add('p', 'Classification pédagogique détaillée : format inattendu, résultats à vérifier.', 'notice');
  } else {
    add('h3', 'Catégories pédagogiques candidates');
    add('p', 'Priorités de traitement pédagogiques proposées, et non niveaux de gravité clinique. Toute intervention nécessite une vérification humaine.', 'notice');

    if (pedagogicalItems.length === 0) {
      add('p', 'Aucune catégorie pédagogique candidate détectée.');
    } else {
      const formatTokens = value => {
        if (!Array.isArray(value)) return 'non précisé';
        return value.length ? value.map(String).join(' · ') : '∅';
      };
      for (const item of pedagogicalItems) {
        const card = add('div', '', 'phoneme-classification-item');
        const heading = document.createElement('strong');
        heading.textContent = typeof item.label === 'string' && item.label
          ? item.label : 'Catégorie à vérifier';
        const detail = document.createElement('p');
        const position = Number.isInteger(item.position_expected)
          ? item.position_expected : 'non précisée';
        detail.textContent = `${formatTokens(item.expected)} → ${formatTokens(item.predicted)} | Position : ${position}`;
        const priority = document.createElement('p');
        priority.textContent = Number.isInteger(item.pedagogical_priority)
          ? `Priorité pédagogique proposée : P${item.pedagogical_priority}`
          : 'Priorité pédagogique : à déterminer';
        const activity = document.createElement('p');
        activity.textContent = `Famille d’activité envisageable : ${typeof item.activity_family === 'string' ? item.activity_family : 'à définir'}`;
        card.append(heading, detail, priority, activity);
        if (item.review_required === true) {
          const warning = document.createElement('p');
          warning.textContent = 'Cas demandant une vérification contextuelle spécifique.';
          warning.className = 'phoneme-classification-review';
          card.appendChild(warning);
        }
      }
    }
  }
}
