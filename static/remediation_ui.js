/* AcoDyslex V0.3.3: accessible, single-activity remediation renderer. */
(() => {
  const t = (key, fallback = key) => { const value = window.acodyslexI18n?.t(key); return value && value !== key ? value : fallback; };
  const FAMILY_META = {
    auditory_discrimination: {icon: '🔊'},
    phoneme_grapheme_matching: {icon: 'أ'},
    syllable_ordering: {icon: '123'},
    missing_letter: {icon: '…'},
    letter_ordering: {icon: 'أب'},
    extra_phoneme_detection: {icon: '+'},
    guided_reading: {icon: '●'},
  };
  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const arabic = (tag, text, className) => {
    const node = make(tag, text, className);
    node.dir = 'rtl'; node.lang = 'ar';
    return node;
  };
  const actionButton = (text, className = 'secondary') => {
    const button = make('button', text, className);
    button.type = 'button';
    return button;
  };

  function render({container, exercise, position, total, draft = {}, onDraft, onComplete}) {
    container.replaceChildren();
    const interaction = exercise.interaction || {};
    const meta = FAMILY_META[exercise.activity_family] || {icon: '○'};
    const familyKey = `remediation.families.${exercise.activity_family}`;
    const local = {
      tries: Number.isInteger(draft.tries) ? draft.tries : 0,
      helpUsed: !!draft.helpUsed,
      selected: draft.selected ?? null,
      ordered: Array.isArray(draft.ordered) ? [...draft.ordered] : [],
      observation: typeof draft.observation === 'string' ? draft.observation : '',
      rating: draft.rating || null,
    };

    const card = make('article', null, `exercise-focus family-${exercise.activity_family}`);
    const activityHead = make('header', null, 'activity-card-head');
    const icon = make('span', meta.icon, 'activity-icon'); icon.setAttribute('aria-hidden', 'true');
    const identity = make('div', null, 'activity-identity');
    identity.append(make('p', t(`${familyKey}.label`, exercise.activity_family_label_fr), 'family-kicker'), make('h3', t(`${familyKey}.title`, exercise.title_fr)), make('p', t(`${familyKey}.objective`, exercise.objective_fr), 'exercise-objective'));
    activityHead.append(icon, identity);

    const instructionBlock = make('section', null, 'instruction-block');
    instructionBlock.append(make('span', 'Consigne', 'section-label'));
    const instruction = make('p', t(`${familyKey}.instruction`, exercise.instruction_ar), 'exercise-instruction');
    instruction.lang = window.acodyslexI18n?.getLanguage?.() || 'ar'; instruction.dir = instruction.lang === 'ar' ? 'rtl' : 'ltr';
    instructionBlock.append(instruction, make('p', t(`${familyKey}.action`, ''), 'action-cue'));

    const example = make('details', null, 'exercise-example');
    example.append(make('summary', 'Voir un exemple'));
    example.append(arabic('p', exercise.example_ar, 'example-arabic'));

    const childZone = make('section', null, 'exercise-interaction child-zone');
    childZone.setAttribute('aria-label', 'Activité de l’enfant');
    childZone.append(make('span', 'Je joue', 'zone-badge child-badge'));
    const feedback = make('p', 'Prends ton temps, puis vérifie ta réponse.', 'exercise-feedback');
    feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite'); feedback.tabIndex = -1;
    const controls = make('div', null, 'exercise-controls');

    const saveDraft = () => onDraft?.({
      tries: local.tries, helpUsed: local.helpUsed, selected: local.selected,
      ordered: [...local.ordered], observation: local.observation, rating: local.rating,
    });
    const hint = make('p', t(`${familyKey}.hint`, interaction.hint || ''), 'exercise-hint');
    hint.lang = instruction.lang; hint.dir = instruction.dir;
    hint.hidden = !local.helpUsed;
    const help = actionButton('❓ Aide', 'help-button');
    help.hidden = local.helpUsed;
    help.onclick = () => {
      local.helpUsed = true; help.hidden = true; hint.hidden = false;
      feedback.textContent = 'Une aide est affichée. Tu peux essayer encore une fois.';
      feedback.className = 'exercise-feedback help'; saveDraft();
    };

    const companion = make('section', null, 'companion-evaluation'); companion.hidden = true;
    const companionHead = make('div', null, 'companion-head');
    companionHead.append(make('span', '✓', 'companion-icon'), make('div', null));
    companionHead.lastChild.append(make('span', 'Espace accompagnateur', 'zone-badge adult-badge'), make('h4', 'Évaluation de l’activité'));
    const objectiveResult = make('p', '', 'objective-result');
    const scoreActions = make('div', null, 'companion-score-actions');
    const independent = actionButton('Réussi seul', 'score-button score-good');
    const assisted = actionButton('Réussi avec aide', 'score-button score-help');
    const retryLater = actionButton('À reprendre', 'score-button score-retry');
    const noteLabel = make('label', null, 'observation-field');
    noteLabel.append(make('span', 'Observation éventuelle'));
    const note = document.createElement('textarea'); note.rows = 2; note.maxLength = 300; note.value = local.observation; note.placeholder = 'Ex. hésitation, besoin de répéter la consigne…';
    note.oninput = () => { local.observation = note.value; saveDraft(); }; noteLabel.append(note);
    const continueButton = actionButton(position === total ? 'Valider la 7e activité' : 'Continuer', 'primary exercise-continue'); continueButton.disabled = true;
    const chooseRating = rating => {
      local.rating = rating;
      scoreActions.querySelectorAll('button').forEach(button => { const selected = button.dataset.rating === rating; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); });
      continueButton.disabled = false; saveDraft();
    };
    [[independent, 'independent'], [assisted, 'assisted'], [retryLater, 'retry']].forEach(([button, rating]) => {
      button.dataset.rating = rating; button.setAttribute('aria-pressed', 'false');
      button.onclick = () => chooseRating(rating);
      scoreActions.append(button);
    });
    companion.append(companionHead, objectiveResult, scoreActions, noteLabel, continueButton);

    const finish = () => {
      continueButton.disabled = true;
      const rating = local.rating || (local.helpUsed || local.tries > 1 ? 'assisted' : 'independent');
      const correct = rating === 'retry' ? 0 : 1;
      const assistance = rating === 'independent' ? 'independent' : rating === 'assisted' ? 'moderate' : 'full';
      const outcome = rating === 'independent' ? 'independent_success' : rating === 'assisted' ? 'assisted_success' : 'not_yet_success';
      onComplete({correct, assistance, outcome, interactionAttempts: Math.max(1, local.tries), helpUsed: local.helpUsed || rating === 'assisted', observation: local.observation});
    };
    continueButton.onclick = finish;

    const showCompanion = (closedAnswer, suggestedRating) => {
      companion.hidden = false;
      objectiveResult.textContent = closedAnswer ? 'Correction automatique : réponse correcte.' : 'La lecture est prête à être appréciée.';
      if (closedAnswer) { retryLater.disabled = true; retryLater.title = 'La correction objective a déjà validé la réponse.'; }
      if (suggestedRating) chooseRating(suggestedRating);
      companion.scrollIntoView({block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
    };
    const revealSuccess = () => {
      feedback.textContent = local.helpUsed || local.tries > 1 ? 'Bravo, tu as trouvé en persévérant !' : 'Bravo, ta réponse est correcte !';
      feedback.className = 'exercise-feedback success';
      childZone.querySelectorAll('button').forEach(button => { button.disabled = true; });
      feedback.focus();
      showCompanion(true, local.helpUsed || local.tries > 1 ? 'assisted' : 'independent');
    };

    if (interaction.kind === 'choice') {
      if (interaction.prompt) childZone.append(arabic('div', interaction.prompt, 'exercise-prompt'));
      const choices = make('div', null, 'exercise-choices'); choices.setAttribute('role', 'group'); choices.setAttribute('aria-label', 'Choix de réponse');
      const check = actionButton('Vérifier', 'primary check-button'); check.disabled = true;
      const reset = actionButton('↻ Recommencer', 'secondary reset-button'); reset.disabled = local.selected == null;
      const select = (option, button) => {
        choices.querySelectorAll('button').forEach(item => { item.classList.toggle('selected', item === button); item.setAttribute('aria-pressed', String(item === button)); });
        local.selected = option; check.disabled = false; reset.disabled = false; saveDraft();
      };
      for (const option of interaction.options || []) {
        const button = arabic('button', option, 'choice-button'); button.type = 'button'; button.setAttribute('aria-pressed', 'false');
        button.onclick = () => select(option, button); choices.append(button);
        if (local.selected === option) select(option, button);
      }
      reset.onclick = () => { local.selected = null; choices.querySelectorAll('button').forEach(item => { item.classList.remove('selected'); item.setAttribute('aria-pressed', 'false'); }); check.disabled = true; reset.disabled = true; feedback.textContent = 'Choisis une nouvelle réponse.'; saveDraft(); };
      check.onclick = () => {
        local.tries++; saveDraft();
        if (local.selected === interaction.answer) revealSuccess();
        else {
          feedback.textContent = 'Pas encore. Observe bien et essaie une autre réponse.'; feedback.className = 'exercise-feedback retry'; feedback.focus();
          local.selected = null; choices.querySelectorAll('button').forEach(item => { item.classList.remove('selected'); item.setAttribute('aria-pressed', 'false'); }); check.disabled = true; reset.disabled = true; saveDraft();
        }
      };
      childZone.append(choices, hint); controls.append(reset, help, check);
    } else if (interaction.kind === 'ordering') {
      const ordering = make('div', null, 'ordering-workspace');
      const bankGroup = make('div', null, 'ordering-group'); bankGroup.append(make('span', 'Éléments disponibles', 'ordering-label'));
      const available = make('div', null, 'ordering-bank'); available.setAttribute('aria-label', 'Éléments disponibles'); bankGroup.append(available);
      const answerGroup = make('div', null, 'ordering-group answer-group'); answerGroup.append(make('span', 'Ma réponse', 'ordering-label'));
      const answer = make('div', null, 'ordering-answer'); answer.setAttribute('aria-label', 'Réponse construite'); answerGroup.append(answer); ordering.append(bankGroup, answerGroup);
      const check = actionButton('Vérifier l’ordre', 'primary check-button'); check.disabled = true;
      const reset = actionButton('↻ Recommencer', 'secondary reset-button'); reset.disabled = !local.ordered.length;
      const redraw = () => {
        available.replaceChildren(); answer.replaceChildren();
        (interaction.tokens || []).forEach((token, index) => {
          if (!local.ordered.includes(index)) { const button = arabic('button', token, 'order-token'); button.type = 'button'; button.setAttribute('aria-label', `Ajouter ${token}`); button.onclick = () => { local.ordered.push(index); redraw(); saveDraft(); }; available.append(button); }
        });
        local.ordered.forEach(index => { const button = arabic('button', interaction.tokens[index], 'order-token selected'); button.type = 'button'; button.setAttribute('aria-label', `Retirer ${interaction.tokens[index]}`); button.onclick = () => { local.ordered = local.ordered.filter(item => item !== index); redraw(); saveDraft(); }; answer.append(button); });
        check.disabled = local.ordered.length !== interaction.tokens.length; reset.disabled = !local.ordered.length;
        if (!answer.childElementCount) answer.append(make('span', 'Touche les éléments pour construire ta réponse.', 'ordering-placeholder'));
      };
      reset.onclick = () => { local.ordered = []; redraw(); feedback.textContent = 'Tu peux reconstruire ta réponse.'; saveDraft(); };
      check.onclick = () => {
        local.tries++; saveDraft(); const value = local.ordered.map(index => interaction.tokens[index]);
        if (JSON.stringify(value) === JSON.stringify(interaction.answer)) revealSuccess();
        else { feedback.textContent = 'L’ordre est à revoir. Replace les éléments calmement.'; feedback.className = 'exercise-feedback retry'; feedback.focus(); local.ordered = []; redraw(); saveDraft(); }
      };
      redraw(); childZone.append(ordering, hint); controls.append(reset, help, check);
    } else {
      const items = make('div', null, 'guided-items');
      for (const item of interaction.items || []) items.append(arabic('span', item, 'guided-word'));
      const doneLabel = document.documentElement.lang === 'ar' ? 'استمع المرافق إلى القراءة' : document.documentElement.lang === 'en' ? 'The companion has listened to the reading' : 'L’accompagnateur a écouté la lecture';
      const done = actionButton(doneLabel, 'primary reading-done');
      const reset = actionButton('↻ Recommencer', 'secondary reset-button');
      reset.onclick = () => { companion.hidden = true; local.rating = null; continueButton.disabled = true; feedback.textContent = 'Tu peux recommencer ta lecture.'; saveDraft(); };
      done.onclick = () => { local.tries++; saveDraft(); feedback.textContent = 'La lecture a été écoutée directement par l’accompagnateur. Il peut maintenant l’évaluer.'; feedback.className = 'exercise-feedback success'; showCompanion(false, local.helpUsed ? 'assisted' : null); if (!local.rating) continueButton.disabled = true; };
      childZone.append(items, hint); controls.append(reset, help, done);
    }

    childZone.append(feedback, controls);
    card.append(activityHead, instructionBlock, example, childZone, companion);
    container.append(card);
  }

  window.acodyslexRemediation = {render};
})();
