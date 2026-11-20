'use strict';

/** Accessible, reusable modal for indeterminate AI processing tasks. */
class AIProcessingModal {
  constructor() {
    this.trigger = null;
    this.steps = [];
    this.currentStage = null;
    this.previousOverflow = '';
    this.inertState = new Map();
    this.root = document.createElement('div');
    this.root.className = 'ai-processing-modal';
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="ai-processing-backdrop" aria-hidden="true"></div>
      <section class="ai-processing-card" role="dialog" aria-modal="true" aria-labelledby="ai-processing-title" aria-describedby="ai-processing-message" tabindex="-1">
        <p class="ai-processing-eyebrow"></p>
        <div class="ai-processing-visual" aria-hidden="true">
          <span class="ai-processing-wave"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></span>
          <b>AI</b>
        </div>
        <div class="ai-processing-technologies" aria-label="Technologies used for this analysis"></div>
        <h2 id="ai-processing-title"></h2>
        <p id="ai-processing-stage" class="ai-processing-stage"></p>
        <p id="ai-processing-message" class="ai-processing-message" role="status" aria-live="polite" aria-atomic="true"></p>
        <div class="ai-processing-indeterminate" role="progressbar"><i></i></div>
        <ol class="ai-processing-steps"></ol>
        <p class="ai-processing-visual-note"></p>
        <div class="ai-processing-actions" hidden>
          <button class="primary ai-processing-retry" type="button"></button>
          <button class="secondary ai-processing-close" type="button"></button>
        </div>
      </section>`;
    document.body.append(this.root);
    this.card = this.root.querySelector('.ai-processing-card');
    this.title = this.root.querySelector('#ai-processing-title');
    this.eyebrow = this.root.querySelector('.ai-processing-eyebrow');
    this.stage = this.root.querySelector('#ai-processing-stage');
    this.message = this.root.querySelector('#ai-processing-message');
    this.progress = this.root.querySelector('.ai-processing-indeterminate');
    this.stepList = this.root.querySelector('.ai-processing-steps');
    this.note = this.root.querySelector('.ai-processing-visual-note');
    this.technologies = this.root.querySelector('.ai-processing-technologies');
    this.actions = this.root.querySelector('.ai-processing-actions');
    this.retryButton = this.root.querySelector('.ai-processing-retry');
    this.closeButton = this.root.querySelector('.ai-processing-close');
    this.onKeyDown = event => this.handleKeyDown(event);
  }

  get isOpen() { return !this.root.hidden; }

  configure({title, eyebrow, steps, visualNote, technologies = []}) {
    this.title.textContent = title;
    this.eyebrow.textContent = eyebrow;
    this.note.textContent = visualNote;
    this.steps = steps;
    this.technologies.replaceChildren(...technologies.map(technology => {
      const item = document.createElement('span'); item.className = `ai-processing-technology ${technology.id}`;
      const logo = document.createElement('img'); logo.src = technology.logo; logo.alt = technology.name;
      const copy = document.createElement('span');
      const name = document.createElement('strong'); name.textContent = technology.name;
      const role = document.createElement('small'); role.textContent = technology.role;
      copy.append(name, role); item.append(logo, copy); return item;
    }));
    this.technologies.hidden = technologies.length === 0;
    this.stepList.replaceChildren(...steps.map(step => {
      const item = document.createElement('li');
      item.dataset.stage = step.id;
      const marker = document.createElement('span'); marker.setAttribute('aria-hidden', 'true');
      const label = document.createElement('strong'); label.textContent = step.label;
      item.append(marker, label); return item;
    }));
    if (this.currentStage) this.setStage(this.currentStage);
  }

  open({title, eyebrow, steps, visualNote, technologies, stage, trigger}) {
    if (!this.isOpen) {
      this.trigger = trigger || document.activeElement;
      this.root.hidden = false;
      document.body.classList.add('ai-processing-open');
      this.previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      for (const child of [...document.body.children]) {
        if (child === this.root) continue;
        this.inertState.set(child, child.inert);
        child.inert = true;
      }
      document.addEventListener('keydown', this.onKeyDown, true);
    }
    this.root.dataset.state = 'processing';
    this.actions.hidden = true;
    this.progress.hidden = false;
    this.configure({title, eyebrow, steps, visualNote, technologies});
    this.setStage(stage);
    requestAnimationFrame(() => this.card.focus({preventScroll:true}));
  }

  setStage(stageId, message) {
    this.currentStage = stageId;
    const index = Math.max(0, this.steps.findIndex(step => step.id === stageId));
    const current = this.steps[index];
    if (!current) return;
    this.stage.textContent = current.label;
    this.message.textContent = message || current.message;
    [...this.stepList.children].forEach((item, itemIndex) => {
      item.classList.toggle('done', itemIndex < index);
      item.classList.toggle('current', itemIndex === index);
      item.setAttribute('aria-current', itemIndex === index ? 'step' : 'false');
    });
  }

  showSuccess({title, message}) {
    this.root.dataset.state = 'success';
    this.stage.textContent = title;
    this.message.textContent = message;
    this.progress.hidden = true;
    [...this.stepList.children].forEach(item => { item.classList.add('done'); item.classList.remove('current'); item.removeAttribute('aria-current'); });
  }

  showError({title, message, retryLabel, closeLabel, onRetry, onClose, kind = 'error'}) {
    this.root.dataset.state = kind;
    this.stage.textContent = title;
    this.message.textContent = message;
    this.progress.hidden = true;
    this.actions.hidden = false;
    this.retryButton.textContent = retryLabel;
    this.closeButton.textContent = closeLabel;
    this.retryButton.onclick = () => onRetry?.();
    this.closeButton.onclick = () => onClose ? onClose() : this.close();
    this.retryButton.focus({preventScroll:true});
  }

  handleKeyDown(event) {
    if (!this.isOpen) return;
    if (event.key === 'Escape') { event.preventDefault(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...this.card.querySelectorAll('button:not([hidden]):not([disabled]),[href],select,input,[tabindex]:not([tabindex="-1"])')].filter(node => !node.closest('[hidden]'));
    if (!focusable.length) { event.preventDefault(); this.card.focus(); return; }
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  close({restoreFocus = true} = {}) {
    if (!this.isOpen) return;
    this.root.hidden = true;
    document.body.classList.remove('ai-processing-open');
    document.body.style.overflow = this.previousOverflow;
    for (const [child, wasInert] of this.inertState) child.inert = wasInert;
    this.inertState.clear();
    document.removeEventListener('keydown', this.onKeyDown, true);
    if (restoreFocus && this.trigger?.isConnected) this.trigger.focus({preventScroll:true});
  }
}

window.AIProcessingModal = AIProcessingModal;
