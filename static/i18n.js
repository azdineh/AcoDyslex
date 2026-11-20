/* AcoDyslex V0.3.7: centralized Arabic/English localization and Latin-digit formatting. */
(() => {
  const STORAGE_KEY = 'acodyslex-ui-language';
  const SUPPORTED = new Set(['ar', 'en']);
  const cache = new Map();
  const originalText = new WeakMap();
  const renderedText = new WeakMap();
  const originalAttributes = new WeakMap();
  const renderedAttributes = new WeakMap();
  let language = SUPPORTED.has(localStorage.getItem(STORAGE_KEY)) ? localStorage.getItem(STORAGE_KEY) : 'ar';
  let messages = {};
  let observer = null;

  const interpolate = (value, params = {}) => String(value).replace(/\{(\w+)\}/g, (_, key) => params[key] ?? `{${key}}`);
  const lookup = (root, path) => path.split('.').reduce((value, part) => value?.[part], root);
  const numberLocale = () => language === 'ar' ? 'ar-MA-u-nu-latn' : 'en-US';
  function formatNumber(value, options = {}) {
    const number = Number(value);
    return Number.isFinite(number) ? new Intl.NumberFormat(numberLocale(), options).format(number) : String(value);
  }
  function formatPercent(value, options = {}) {
    const number = Number(value);
    return Number.isFinite(number) ? new Intl.NumberFormat(numberLocale(), {style: 'percent', maximumFractionDigits: 0, ...options}).format(number) : String(value);
  }
  function formatDate(value, options = {}) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat(numberLocale(), {dateStyle: 'medium', timeStyle: 'short', ...options}).format(date);
  }
  function t(key, params = {}) {
    const value = lookup(messages, key);
    return interpolate(typeof value === 'string' ? value : key, params);
  }

  function patternTranslation(source) {
    let match;
    if ((match = source.match(/^Mot (\d+) sur (\d+)$/))) return t('patterns.wordProgress', {current: match[1], total: match[2]});
    if ((match = source.match(/^Activité (\d+) sur (\d+)$/))) return t('patterns.activityProgress', {current: match[1], total: match[2]});
    if ((match = source.match(/^(\d+) activités terminées$/))) return t('patterns.activitiesCompleted', {count: match[1]});
    if ((match = source.match(/^La lecture de (.+)$/))) return t('patterns.readingOf', {name: match[1]});
    if ((match = source.match(/^(\d+) ans · (\d+) séance\(s\)$/))) return t('patterns.profileMeta', {age: match[1], count: match[2]});
    if ((match = source.match(/^(\d+) compétence\(s\) suivie\(s\)$/))) return t('patterns.skillsTracked', {count: match[1]});
    if ((match = source.match(/^(\d+) séance\(s\) enregistrée\(s\)\.$/))) return t('patterns.sessionsRecorded', {count: match[1]});
    if ((match = source.match(/^(\d+(?:\.\d+)?) s · prêt$/))) return t('patterns.audioReady', {duration: match[1]});
    if ((match = source.match(/^(\d+) occurrence\(s\) sur (\d+) mot\(s\)$/))) return t('patterns.occurrences', {count: match[1], words: match[2]});
    if ((match = source.match(/^Ajouter (.+)$/))) return t('patterns.addToken', {token: match[1]});
    if ((match = source.match(/^Retirer (.+)$/))) return t('patterns.removeToken', {token: match[1]});
    if ((match = source.match(/^Backend indisponible : (.+)$/))) return t('patterns.backendUnavailable', {error: match[1]});
    if ((match = source.match(/^Validation impossible : (.+)$/))) return t('patterns.validationFailed', {error: match[1]});
    if ((match = source.match(/^Analyse impossible : (.+)$/))) return t('patterns.analysisFailed', {error: match[1]});
    if ((match = source.match(/^Impossible de démarrer la séance : (.+)$/))) return t('patterns.sessionStartFailed', {error: match[1]});
    if ((match = source.match(/^Tentative non enregistrée : (.+)$/))) return t('patterns.attemptSaveFailed', {error: match[1]});
    if ((match = source.match(/^Abandon impossible : (.+)$/))) return t('patterns.abandonFailed', {error: match[1]});
    if ((match = source.match(/^Clôture impossible : (.+)$/))) return t('patterns.completionFailed', {error: match[1]});
    if ((match = source.match(/^Profil non enregistré : (.+)$/))) return t('patterns.profileSaveFailed', {error: match[1]});
    if ((match = source.match(/^Enregistrement impossible : (.+)$/))) return t('patterns.recordingFailed', {error: match[1]});
    if ((match = source.match(/^Impossible de démarrer le micro : (.+)$/))) return t('patterns.microphoneStartFailed', {error: match[1]});
    if ((match = source.match(/^Échec de sauvegarde : (.+)$/))) return t('patterns.saveFailed', {error: match[1]});
    if ((match = source.match(/^Impossible de lire le WAV importé : (.+)$/))) return t('patterns.wavReadFailed', {error: match[1]});
    if ((match = source.match(/^Impossible de communiquer avec le serveur local : (.+)$/))) return t('patterns.serverUnavailable', {error: match[1]});
    if ((match = source.match(/^Classification indisponible : (.+)\.$/))) return t('patterns.classificationUnavailable', {reason: translateLiteral(match[1]).trim()});
    if ((match = source.match(/^PER référence–ASR : ([^.]*)\. (.+)$/))) return t('patterns.referencePer', {value: match[1], note: translateLiteral(match[2]).trim()});
    if ((match = source.match(/^(.+) → (.+) \| Position : (.+)$/))) return t('patterns.phonemePosition', {expected: match[1], predicted: match[2], position: match[3]});
    if ((match = source.match(/^Priorité pédagogique proposée : P(.+)$/))) return t('patterns.proposedPriority', {priority: match[1]});
    if ((match = source.match(/^Famille d’activité envisageable : (.+)$/))) return t('patterns.suggestedFamily', {family: match[1]});
    return null;
  }

  function translateLiteral(source) {
    if (!source || !source.trim()) return source;
    const leading = source.match(/^\s*/)?.[0] || '', trailing = source.match(/\s*$/)?.[0] || '';
    const clean = source.trim().replace(/\s+/g, ' ');
    const translated = messages.literals?.[clean] ?? patternTranslation(clean);
    if (translated != null) return `${leading}${translated}${trailing}`;
    const decorated = clean.match(/^([^\p{L}\p{N}]+)\s+(.+)$/u);
    const decoratedValue = decorated ? messages.literals?.[decorated[2]] : null;
    return decoratedValue == null ? source : `${leading}${decorated[1]} ${decoratedValue}${trailing}`;
  }

  function translateTextNode(node, newSource = false) {
    if (!node?.parentElement || ['SCRIPT', 'STYLE'].includes(node.parentElement.tagName)) return;
    const current = node.nodeValue || '';
    if (newSource || !originalText.has(node)) originalText.set(node, current);
    const source = originalText.get(node);
    const value = translateLiteral(source);
    renderedText.set(node, value);
    if (current !== value) node.nodeValue = value;
  }

  function translateAttributes(element) {
    if (!(element instanceof Element)) return;
    const attributes = ['placeholder', 'title', 'aria-label'];
    let sources = originalAttributes.get(element);
    if (!sources) { sources = {}; originalAttributes.set(element, sources); }
    let rendered = renderedAttributes.get(element);
    if (!rendered) { rendered = {}; renderedAttributes.set(element, rendered); }
    for (const name of attributes) {
      if (!element.hasAttribute(name)) continue;
      if (!(name in sources)) sources[name] = element.getAttribute(name);
      const value = translateLiteral(sources[name]);
      rendered[name] = value;
      if (element.getAttribute(name) !== value) element.setAttribute(name, value);
    }
  }

  function applyNode(root) {
    if (root.nodeType === Node.TEXT_NODE) return translateTextNode(root);
    if (!(root instanceof Element || root instanceof Document)) return;
    if (root instanceof Element) translateAttributes(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) node.nodeType === Node.TEXT_NODE ? translateTextNode(node) : translateAttributes(node);
  }

  function applyDocument() {
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    document.body?.classList.toggle('ui-arabic', language === 'ar');
    applyNode(document.body);
    const select = document.getElementById('language-select');
    if (select) { select.value = language; select.setAttribute('aria-label', t('language.label')); }
    document.title = t('app.title');
  }

  async function loadLocale(nextLanguage) {
    if (cache.has(nextLanguage)) return cache.get(nextLanguage);
    const response = await fetch(`/static/locales/${nextLanguage}.json`, {cache: 'no-cache'});
    if (!response.ok) throw new Error(`Locale ${nextLanguage}: HTTP ${response.status}`);
    const locale = await response.json(); cache.set(nextLanguage, locale); return locale;
  }

  async function setLanguage(nextLanguage, {initial = false} = {}) {
    if (!SUPPORTED.has(nextLanguage)) return;
    messages = await loadLocale(nextLanguage); language = nextLanguage;
    localStorage.setItem(STORAGE_KEY, language);
    applyDocument();
    document.documentElement.classList.remove('i18n-loading');
    if (!initial) window.dispatchEvent(new CustomEvent('acodyslex:languagechange', {detail: {language}}));
  }

  function watchDynamicContent() {
    observer?.disconnect();
    observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') {
          const current = mutation.target.nodeValue || '';
          if (current === renderedText.get(mutation.target)) continue;
          translateTextNode(mutation.target, true);
        } else if (mutation.type === 'childList') {
          mutation.addedNodes.forEach(node => applyNode(node));
        } else if (mutation.type === 'attributes') {
          const rendered = renderedAttributes.get(mutation.target);
          if (mutation.target.getAttribute(mutation.attributeName) === rendered?.[mutation.attributeName]) continue;
          const sources = originalAttributes.get(mutation.target);
          if (sources) delete sources[mutation.attributeName];
          translateAttributes(mutation.target);
        }
      }
    });
    observer.observe(document.body, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'title', 'aria-label']});
  }

  function bindSelector() {
    const select = document.getElementById('language-select');
    select?.addEventListener('change', event => setLanguage(event.target.value));
  }

  function localizeDialogs() {
    const nativeAlert = window.alert.bind(window), nativeConfirm = window.confirm.bind(window);
    window.alert = value => nativeAlert(translateLiteral(String(value)));
    window.confirm = value => nativeConfirm(translateLiteral(String(value)));
  }

  const ready = window.__ACODYSLEX_TEST_SOURCE_UI__ ? Promise.resolve().then(() => {
    document.documentElement.lang = 'fr'; document.documentElement.dir = 'ltr'; document.documentElement.classList.remove('i18n-loading');
  }) : (async () => {
    if (document.readyState === 'loading') await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, {once: true}));
    bindSelector();
    localizeDialogs();
    try { await setLanguage(language, {initial: true}); }
    catch (error) { console.error(error); document.documentElement.classList.remove('i18n-loading'); }
    watchDynamicContent();
  })();

  window.acodyslexI18n = {t, translate: translateLiteral, formatNumber, formatPercent, formatDate, setLanguage, getLanguage: () => language, ready, apply: applyDocument};
})();
