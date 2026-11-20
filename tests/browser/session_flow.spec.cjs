const {test, expect} = require('@playwright/test');
const fs = require('node:fs/promises');
const phonemePresentation = Object.fromEntries(require('../../acodyslex_phonemes_ar.json').phonemes
  .filter(item => item.mapping_status === 'documente_dans_recapitulatif' && item.symbol && item.arabic && item.name_ar)
  .map(item => [item.symbol, {arabic:item.arabic, name_ar:item.name_ar, category:item.category}]));

function wav() {
  const rate = 16000, frames = rate / 4, data = Buffer.alloc(44 + frames * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(9000 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
  return data;
}

function profile() {
  return {child_id: 'child_mock', display_name: 'Lecteur Soleil', age: 8, sex: 'unspecified', avatar_id: 'neutral',
    created_at: '2026-11-08T09:00:00Z', updated_at: '2026-11-08T09:00:00Z', retention_until: '2027-11-08T09:00:00Z',
    pedagogical_settings: {initial_mastery: .5, learning_rate: .25, mastery_threshold: .8, review_threshold: .55, max_recent_repetitions: 2, retention_days: 365},
    skills: [], disclaimer: 'Prototype pédagogique'};
}

const confirmedAcousticModel = {
  runtime_source: 'Modal /health', checked_at: '2026-11-10T10:00:00Z',
  model_id: 'MostafaMaroof/wav2vec2-arabic-phoneme-asr', runtime_revision: null,
  metadata_verified: true,
  model: {
    display_name: 'Arabic Phoneme ASR v2', release: 'v2', publisher: 'MostafaMaroof',
    task: 'Reconnaissance phonémique de la parole arabe',
    arabic_capability: 'Arabe standard moderne et récitation coranique ; parole dialectale hors domaine validé.',
    base_model: 'facebook/wav2vec2-large-xlsr-53', base_developer: 'Meta (Facebook AI)',
    base_developer_confirmed: true,
    metadata_url: 'https://huggingface.co/MostafaMaroof/wav2vec2-arabic-phoneme-asr',
    base_model_url: 'https://huggingface.co/facebook/wav2vec2-large-xlsr-53',
  },
  infrastructure: {provider: 'Modal', deployment: 'modal-single-provider', api_title: 'AcoDyslex acoustic phoneme prototype', api_version: '0.3.0'},
  phoneme_presentation: phonemePresentation,
};

const remediationExercises = [
  {id:'OMI01',skill:'phoneme_detection',title_fr:'La lettre manquante',activity_family:'missing_letter',activity_family_label_fr:'Lettre manquante',objective_fr:'Compléter le mot.',instruction_ar:'اِخْتَرِ الْحَرْفَ النَّاقِصَ.',example_ar:'كِتَا_ٌ ← ب',interaction:{kind:'choice',prompt:'مَدْ_َسَة',options:['ر','د','س'],answer:'ر',hint:'الْكَلِمَةُ هِيَ مَدْرَسَةٌ.'},audio:{status:'not_required',url:null,message_fr:'Sans audio.'}},
  {id:'SUB02',skill:'phoneme_grapheme_mapping',title_fr:'Le son et la lettre',activity_family:'phoneme_grapheme_matching',activity_family_label_fr:'Son et lettre',objective_fr:'Associer le son à sa lettre.',instruction_ar:'اِخْتَرِ الْحَرْفَ الْمُنَاسِبَ.',example_ar:'/م/ ← م',interaction:{kind:'choice',options:['س','ص'],answer:'س',model:'/s/',hint:'اِسْمُ الْحَرْفِ سِينٌ.'},audio:{status:'unavailable',url:null,message_fr:'Aucun fichier audio validé.'}},
  {id:'INV01',skill:'auditory_sequencing',title_fr:'Ordre des syllabes',activity_family:'syllable_ordering',activity_family_label_fr:'Ordre des syllabes',objective_fr:'Construire le mot.',instruction_ar:'رَتِّبِ الْمَقَاطِعَ.',example_ar:'مَ + دْ = مَدْ',interaction:{kind:'ordering',tokens:['مَ','سَ','كْ'],answer:['سَ','مَ','كْ'],hint:'اِبْدَأْ بِـ سَ.'},audio:{status:'not_required',url:null,message_fr:'Sans audio.'}},
  {id:'INS02',skill:'controlled_blending',title_fr:'Ordre des lettres',activity_family:'letter_ordering',activity_family_label_fr:'Ordre des lettres',objective_fr:'Assembler sans répétition.',instruction_ar:'رَتِّبِ الْحُرُوفَ.',example_ar:'بَ + ا = بَا',interaction:{kind:'ordering',tokens:['نْ','مَ'],answer:['مَ','نْ'],hint:'اِبْدَأْ بِـ مَ.'},audio:{status:'not_required',url:null,message_fr:'Sans audio.'}},
  {id:'INS03',skill:'phoneme_segmentation',title_fr:'Le son ajouté',activity_family:'extra_phoneme_detection',activity_family_label_fr:'Son ajouté',objective_fr:'Repérer le segment en plus.',instruction_ar:'اِخْتَرِ الْمَقْطَعَ الزَّائِدَ.',example_ar:'سَ مَ كْ / سَ مَ كَ كْ',interaction:{kind:'choice',options:['سَ','مَ','كَ'],answer:'كَ',hint:'قَارِنِ النِّهَايَةَ.'},audio:{status:'not_required',url:null,message_fr:'Sans audio.'}},
  {id:'SUB01',skill:'auditory_discrimination',title_fr:'Deux consonnes',activity_family:'auditory_discrimination',activity_family_label_fr:'Discrimination auditive',objective_fr:'Distinguer deux sons.',instruction_ar:'اِطْلُبْ مِنَ الْمُرَافِقِ نُطْقَ الصَّوْتِ.',example_ar:'سَ — صَ',interaction:{kind:'choice',options:['سَ','صَ'],answer:'سَ',model:'سَ',hint:'رَاقِبِ الْفَمَ.'},audio:{status:'unavailable',url:null,message_fr:'Aucun fichier audio pédagogique validé.'}},
  {id:'INV03',skill:'controlled_decoding',title_fr:'Lecture guidée',activity_family:'guided_reading',activity_family_label_fr:'Lecture guidée',objective_fr:'Lire en gardant l’ordre.',instruction_ar:'اِقْرَأِ الْكَلِمَتَيْنِ.',example_ar:'سَ — مَ',interaction:{kind:'human',items:['سَمَك','مَسَك'],hint:'اِقْرَأْ بِبُطْءٍ.'},audio:{status:'not_required',url:null,message_fr:'Sans audio.'}},
].map(exercise=>({...exercise,recommendation_kind:'targeted',adaptation_reason_fr:'Adaptation de test'}));

async function mockFlow(page, options = {}) {
  await page.addInitScript(()=>{window.__ACODYSLEX_TEST_WORKSPACE__=true;});
  if(!options.i18n)await page.addInitScript(()=>{window.__ACODYSLEX_TEST_SOURCE_UI__=true;});
  const state = {profile: options.existingProfile ? profile() : null, recordings: 0, analyses: 0, batchCalls: 0, attempts: 0, sessionBody: null, lastState: null, lastAttempt: null, verifyPayloads: []};
  await page.route('**/api/config', route => route.fulfill({json: {modal_ready: true, whisper_enabled: false, reading_mode: options.readingMode || 'mixed'}}));
  if(options.legacyReadingBank)await page.route('**/static/reading_words.json*', route => route.fulfill({json: {words: Array.from({length: 20}, (_, index) => ({id: `legacy_${index + 1}`, text: `word${index + 1}`, category: 'decoding', target_error_type: 'omission', phonemes: []}))}}));
  await page.route('**/api/acoustic-model', route => route.fulfill({json: options.acousticModel || confirmedAcousticModel}));
  await page.route('**/api/reset', route => { if(options.legacyReset) return route.fulfill({status: 404, json: {detail: 'Not Found'}}); state.profile = null; state.sessionBody = null; return route.fulfill({json: {status: 'reset', removed_profiles: 1, removed_recording_files: 0}}); });
  await page.route('**/api/recordings**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/api/recordings' && request.method() === 'GET') return route.fulfill({json: []});
    if (url.pathname === '/api/recordings' && request.method() === 'POST') {
      state.recordings++; return route.fulfill({status: 201, json: {id: `recording_${state.recordings}`, duration_seconds: .25}});
    }
    if (url.pathname.endsWith('/analyze')) {
      state.analyses++;
      return route.fulfill({json: {status: 'ok', expected_phonemes: ['k','a'], predicted_phonemes: ['k','a'],
        candidate_errors: state.analyses < 4 ? [{type: 'omission'}] : [],
        recommendation_observations: state.analyses < 4 ? [{error_type: 'omission', count: 1, opportunities: 1, distinct_items: 1}] : []}});
    }
    return route.fallback();
  });
  await page.route('**/v1/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const json = () => request.postDataJSON();
    if (path === '/v1/reading/analyze-batch' && request.method() === 'POST') {
      state.batchCalls++;
      if(options.batchDelay)await new Promise(resolve=>setTimeout(resolve,options.batchDelay));
      if(state.batchCalls<=(options.batchFailures||0))return route.fulfill({status:503,json:{detail:'Service Acoustic AI temporairement indisponible'}});
      const wordResults = state.sessionBody.reading_words.map((word, index) => ({
        word_id: word.word_id, word_order: word.order, reference_text: word.text,
        analysis_status: 'ok', expected_phonemes: word.expected_phonemes,
        predicted_phonemes: word.expected_phonemes, audio_id: `batch:test:${word.word_id}`,
        candidate_errors: index < 3 ? [{error_type: 'omission', count: 1}] : [],
        phoneme_classification: null, confidence: .8, uncertainty: null,
        duration_seconds: .25, recognized_text: null, provenance: 'modal_batch_candidate',
      }));
      return route.fulfill({json: {analysis_id: 'batch_test', session_id: state.sessionBody.session_id,
        batch_status: 'completed', word_results: wordResults,
        global_summary: {total_words: 15, analyzed_words: 15, unusable_words: 0,
          words_with_candidates: 3, candidate_error_count: 3,
          error_type_frequencies: {omission: 3}, error_type_word_frequencies: {omission: 3},
          recurrent_error_types: ['omission'], potential_skills: ['phoneme_detection'],
          uncertain_word_ids: [], provenance: 'aggregated_from_word_results'},
        model_versions: {acoustic: 'mock'}, processing_metadata: {modal_invocations: 1}}});
    }
    if (path === '/v1/progress/children' && request.method() === 'GET') return route.fulfill({json: {children: state.profile ? [state.profile] : []}});
    if (path === '/v1/progress/children' && request.method() === 'POST') { state.profile = {...profile(),...json()}; return route.fulfill({status: 201, json: state.profile}); }
    if (path === '/v1/progress/children/child_mock' && request.method() === 'PATCH') { state.profile = {...state.profile,...json()}; return route.fulfill({json: state.profile}); }
    if (path === '/v1/progress/children/child_mock' && request.method() === 'DELETE') { state.profile = null; return route.fulfill({status: 204}); }
    if (path.endsWith('/history')) {
      const sessions = options.historySessions || [];
      return route.fulfill({json: {child_id: 'child_mock', total: sessions.length, offset: 0, limit: 3, next_offset: null, sessions}});
    }
    if (path === '/v1/progress/sessions' && request.method() === 'POST') {
      state.sessionBody = json();
      return route.fulfill({status: 201, json: {...state.sessionBody, status: 'open', state: 'created', completed_at: null, attempts: [], reading_words: state.sessionBody.reading_words}});
    }
    if (path.endsWith('/state')) { state.lastState = json().state; return route.fulfill({json: {session_id: 'mock', child_id: 'child_mock', status: 'open', state: state.lastState, started_at: '2026-11-08T09:00:00Z', completed_at: null, recommendation_engine_version: '0.3.2', recommended_exercise_ids: [], observations: [], attempts: [], reading_words: state.sessionBody?.reading_words || []}}); }
    if (path.includes('/words/') && path.endsWith('/analysis')) return route.fulfill({json: {session_id: 'mock', child_id: 'child_mock', status: 'open', state: 'analyzing', started_at: '2026-11-08T09:00:00Z', completed_at: null, recommendation_engine_version: '0.3.0', recommended_exercise_ids: [], observations: [], attempts: [], reading_words: state.sessionBody.reading_words}});
    if (path === '/v1/recommendations/observations/verify') {
      const payload = json(); state.verifyPayloads.push(payload);
      if (options.verifyFailure) return route.fulfill({status: 422, json: {detail: options.verifyFailure}});
      return route.fulfill({json: {verified_by: payload.reviewer_id, verification_receipt: `nonce${state.analyses}.signature`, expires_at: 9999999999}});
    }
    if (path.endsWith('/observations')) return route.fulfill({json: {status: 'ok'}});
    if (path.endsWith('/recommendations') && request.method() === 'GET') return route.fulfill({json: {recommended_exercises: remediationExercises}});
    if (path.endsWith('/recommendations') && request.method() === 'POST') return route.fulfill({json: {status: 'ok'}});
    if (path.endsWith('/attempts')) { state.attempts++; state.lastAttempt = json(); return route.fulfill({status: 201, json: {...state.lastAttempt, session_id: 'mock'}}); }
    if (path.endsWith('/complete')) return route.fulfill({json: {session: {state: 'completed'}, profile: {...state.profile, skills: [{skill: 'phoneme_detection', mastery_estimate: .63, evidence_count: 1, updated_at: '2026-11-08T10:00:00Z', interpretation: 'progression_en_cours'}]}, already_completed: false}});
    return route.fulfill({status: 404, json: {detail: `Unmocked ${request.method()} ${path}`}});
  });
  return state;
}

test('the welcome screen precedes the profile workspace', async ({page}) => {
  await page.goto('/');
  await expect(page.locator('#intro-home')).toBeVisible();
  await expect(page.locator('#intro-logo, .intro-logo')).toBeVisible();
  await expect(page.locator('#app-shell')).toBeHidden();
  await page.locator('#intro-start').click();
  await expect(page.locator('#intro-home')).toBeHidden();
  await expect(page.locator('#app-shell')).toBeVisible();
  await expect(page.locator('.brand-logo')).toHaveAttribute('src', '/guideres/logo1.png');
  await expect(page.locator('.brand strong')).toHaveText('AcoDyslex');
});

async function reachAcousticAnalysis(page){
  await page.locator('.profile-card .primary').click();
  for(let index=0;index<15;index++){
    await page.locator('#session-file').setInputFiles({name:'reading.wav',mimeType:'audio/wav',buffer:wav()});
    if(index<14){const expected=await page.evaluate(current=>document.documentElement.lang==='fr'?`Mot ${current} sur 15`:window.acodyslexI18n.t('patterns.wordProgress',{current,total:15}),index+2);await expect(page.locator('#reading-progress')).toHaveText(expected);}
  }
  await expect(page.locator('#v3-ready')).toBeVisible();
}

test('V0.4 creates a persisted randomized 8-word and 7-sentence mixed plan', async ({page}) => {
  const mock = await mockFlow(page,{existingProfile:true});
  await page.goto('/');
  await page.locator('.profile-card .primary').click();
  await expect.poll(() => mock.sessionBody?.reading_words?.length || 0).toBe(15);
  const units = mock.sessionBody.reading_words;
  expect(units.filter(unit => unit.unit_type === 'word')).toHaveLength(8);
  expect(units.filter(unit => unit.unit_type === 'short_sentence')).toHaveLength(7);
  expect(units.filter(unit => unit.unit_type === 'word').every(unit => unit.max_recording_seconds === 10)).toBeTruthy();
  expect(units.filter(unit => unit.unit_type === 'short_sentence').every(unit => unit.word_count >= 2 && unit.word_count <= 3 && unit.max_recording_seconds === 15)).toBeTruthy();
  await expect(page.locator('#reading-word')).not.toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('#reading-word')).not.toHaveText('');
  await expect(page.locator('#reading-home')).toBeVisible();
  await page.locator('#reading-home').click();
  await expect(page.locator('#v3-home')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBeTruthy();
  await page.setViewportSize({width:980,height:697});
  await page.locator('#profile-welcome').click();
  await expect(page.locator('#intro-home')).toBeVisible();
  await expect(page.locator('#app-shell')).toBeHidden();
  await expect(page.locator('#intro-title')).toHaveText('نموذج أولي لمنصة دعم متخصصة');
  await expect(page.locator('.intro-model-summary')).toContainText('Arabic Phoneme ASR v2');
  await expect(page.locator('.intro-model-summary')).toContainText('facebook/wav2vec2-large-xlsr-53');
  await expect(page.locator('.intro-model-summary a')).toHaveAttribute('href', 'https://modal.com');
  expect(await page.locator('.intro-model-summary').evaluate(node => getComputedStyle(node).borderStyle)).toBe('none');
  expect(await page.locator('[data-intro-slide="0"]').evaluate(node => getComputedStyle(node).transitionProperty.includes('opacity'))).toBeTruthy();
  expect(await page.locator('.intro-logo').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return Math.abs((rect.left + rect.width / 2) - window.innerWidth / 2) < 2;
  })).toBeTruthy();
  await page.locator('[data-intro-page="1"]').click();
  await expect(page.locator('[data-intro-slide="1"]')).toBeVisible();
  await expect(page.locator('#intro-prototype-title')).not.toHaveText('نموذج أولي لمنصة دعم متخصصة');
  await expect(page.locator('#intro-prototype-first')).not.toBeEmpty();
  await page.locator('[data-intro-page="0"]').click();
  await expect(page.locator('#intro-start')).toBeVisible();
  await page.waitForTimeout(5100);
  await expect(page.locator('[data-intro-slide="1"]')).toBeVisible();
  await page.locator('[data-intro-page="0"]').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBeTruthy();
});

test('mixed mode fills missing legacy phrases from the embedded sentence bank', async ({page}) => {
  const mock = await mockFlow(page,{existingProfile:true,legacyReadingBank:true});
  await page.goto('/');
  await page.locator('.profile-card .primary').click();
  await expect.poll(() => mock.sessionBody?.reading_words?.length || 0).toBe(15);
  expect(mock.sessionBody.reading_words.filter(unit => unit.unit_type === 'short_sentence')).toHaveLength(7);
});

test('report presents a compact RTL phoneme comparison without candidate cards', async ({page}) => {
  await mockFlow(page,{existingProfile:true,i18n:true});
  await page.addInitScript(() => localStorage.setItem('acodyslex-v03-session', JSON.stringify({
    phase:'review', child:{child_id:'child_mock',display_name:'Lecteur Soleil'}, sessionId:'session_report',
    words:[], index:0, globalSummary:{analyzed_words:1,candidate_error_count:0,words_with_candidates:0,unusable_words:0},
    results:[{word_id:'sentence_1',word_order:1,unit_type:'short_sentence',text:'قرأ سامي كتابًا',expected:['sh','a','r','a','l','w','a','l','a','d'],expectedPhonemesArabic:[{symbol:'sh',arabic:'ش',name_ar:'الشين',mapping_status:'documente_dans_recapitulatif'}],observed:['sh','a','q','a','z','i','l','a','y','b','a','a'],analysis_status:'ok',candidates:[{error_type:'omission',count:1,reviewStatus:'confirmed'},{error_type:'addition',count:1}]}],
    exercises:[],attempts:[],exerciseIndex:0,exerciseDrafts:{},analysisId:'report_test',recordingMeta:{},
  })));
  await page.goto('/');
  await expect(page.locator('#v3-review')).toBeVisible();
  await expect(page.locator('.report-reference-output .report-label')).toHaveText('الجملة المرجعية');
  await expect(page.locator('.report-output-grid .report-label')).toHaveText(['الجملة المرجعية','الصوت المسجل','إنتاج النموذج الصوتي','الصوت المنتظر','ملاحظة']);
  await expect(page.locator('.report-phoneme-note')).toContainText(/استبدال|حذف|إضافة|قلب/);
  await expect(page.locator('#phoneme-display-arabic')).toBeChecked();
  await expect(page.locator('.report-phoneme-token').first()).toHaveText('ش');
  await expect(page.locator('.report-phoneme-note')).toContainText('صوت القاف (ق)');
  await expect(page.locator('.sentence-evidence')).toHaveCount(0);
  await expect(page.locator('.word-candidates,.word-candidate,.candidate-edit,.candidate-delete')).toHaveCount(0);
  await expect(page.locator('.report-phoneme-table')).toHaveCount(2);
  await expect(page.locator('.report-model-phonemes .report-phoneme-token').first()).toHaveText('ش');
  await expect(page.locator('.report-target-phonemes .report-phoneme-token').first()).toHaveText('ش');
  await expect(page.locator('.report-target-phonemes')).toHaveAttribute('data-phoneme-source','reading-bank');
  await expect(page.locator('.report-phoneme-index-row').first().locator('.report-phoneme-index')).toHaveCount(12);
  await expect(page.locator('.report-phoneme-table').first()).toHaveCSS('text-align','right');
  await expect(page.locator('.report-phoneme-table').first()).toHaveCSS('direction','rtl');
  expect(await page.locator('.report-phoneme-table').first().evaluate(table=>{
    const indexes=[...table.querySelectorAll('.report-phoneme-index')],tokens=[...table.querySelectorAll('.report-phoneme-token')];
    return indexes.length===tokens.length&&indexes.every((index,position)=>Math.abs((index.getBoundingClientRect().left+index.getBoundingClientRect().width/2)-(tokens[position].getBoundingClientRect().left+tokens[position].getBoundingClientRect().width/2))<1);
  })).toBeTruthy();
  expect(await page.locator('.report-phoneme-table').first().evaluate(table=>{
    const indexes=[...table.querySelectorAll('.report-phoneme-index')];
    return indexes.length>1&&indexes[0].getBoundingClientRect().left>indexes[indexes.length-1].getBoundingClientRect().left;
  })).toBeTruthy();
  await page.locator('#phoneme-display-arabic').uncheck();
  await expect(page.locator('.report-phoneme-token').first()).toHaveText('sh');
  await expect(page.locator('.report-phoneme-note')).toContainText('/q/');
  expect(await page.locator('.report-phonemes').evaluateAll(nodes=>nodes.every(node=>node.scrollWidth<=node.clientWidth))).toBeTruthy();
  expect(await page.locator('.report-output-grid .report-output').count()).toBe(5);
  expect(await page.locator('.report-output-grid').evaluate(node=>getComputedStyle(node).direction)).toBe('rtl');
  await expect(page.locator('.report-verify-word')).toBeVisible();
  await expect(page.locator('#verify-report')).toBeDisabled();
});

test('V0.5 opens a free eight-activity library and preserves an activity draft', async ({page}) => {
  await mockFlow(page,{existingProfile:true,i18n:true});
  await fs.mkdir('artifacts/v050',{recursive:true});
  await page.setViewportSize({width:1366,height:768});
  await page.addInitScript(() => {if(!localStorage.getItem('acodyslex-v03-session'))localStorage.setItem('acodyslex-v03-session', JSON.stringify({
    phase:'review', child:{child_id:'child_mock',display_name:'Lecteur Soleil'}, sessionId:'session_v05', words:[], index:0,
    globalSummary:{analyzed_words:1,candidate_error_count:0,words_with_candidates:0,unusable_words:0},
    results:[{word_id:'word_1',word_order:1,unit_type:'word',text:'كتاب',expected:['k','a','t','a','b'],observed:['k','a','t','a','b'],analysis_status:'ok',candidates:[],reviewedByCompanion:true}],
    exercises:[],attempts:[],exerciseIndex:0,exerciseDrafts:{},analysisId:'v05_test',recordingMeta:{},
  }));});
  await page.goto('/');
  await expect(page.locator('#verify-report')).toBeEnabled();
  await page.locator('#verify-report').click();
  await expect(page.locator('#v3-remediation')).toBeVisible();
  await expect(page.locator('.activity-library-card')).toHaveCount(8);
  await expect(page.locator('.activity-library-companion-note')).toContainText('يقرأ المرافق');
  await expect(page.locator('.activity-library-card.review .activity-library-meta')).toContainText('16');
  const reviewMix=await page.evaluate(()=>{const first=window.acodyslexActivityLibrary.createPlan([],'session-a').review.tasks,second=window.acodyslexActivityLibrary.createPlan([],'session-b').review.tasks;return {count:first.length,sources:[...new Set(first.map(task=>task.sourceActivityId))],different:first.map(task=>task.id).join('|')!==second.map(task=>task.id).join('|')};});
  expect(reviewMix.count).toBe(16);expect(reviewMix.sources.length).toBeGreaterThan(1);expect(reviewMix.different).toBeTruthy();
  expect(await page.locator('.activity-library-grid').evaluate(node=>getComputedStyle(node).gridTemplateColumns.split(' ').length)).toBe(3);
  await page.screenshot({path:'artifacts/v050/activity-library-desktop.png',fullPage:true});
  await page.setViewportSize({width:768,height:900});
  expect(await page.locator('.activity-library-grid').evaluate(node=>getComputedStyle(node).gridTemplateColumns.split(' ').length)).toBe(2);
  await page.setViewportSize({width:375,height:812});
  expect(await page.locator('.activity-library-grid').evaluate(node=>getComputedStyle(node).gridTemplateColumns.split(' ').length)).toBe(1);
  await page.setViewportSize({width:1366,height:768});
  await page.locator('.activity-library-card').first().locator('.activity-library-open').click();
  await expect(page.locator('.exercise-focus')).toBeVisible();
  await expect(page.locator('#back-to-activities')).toBeVisible();
  await expect(page.locator('#exercise-progress')).toContainText('4');
  await expect(page.locator('.audio-play-button')).toHaveCount(0);
  await page.screenshot({path:'artifacts/v050/activity-detail-desktop.png',fullPage:true});
  await page.locator('#pause-remediation').click();
  await expect(page.locator('.activity-paused')).toBeVisible();
  await page.locator('.activity-paused button').click();
  await page.locator('.choice-button').first().click();
  await page.locator('.check-button').click();
  await expect(page.locator('.companion-evaluation')).toBeVisible();
  await page.locator('.exercise-continue').click();
  await expect(page.locator('#exercise-progress')).toContainText('2');
  await page.locator('#back-to-activities').click();
  await expect(page.locator('.activity-library-card.in_progress')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('#v3-remediation')).toBeVisible();
  await expect(page.locator('.activity-library-card.in_progress')).toHaveCount(1);
  await page.locator('.activity-library-card.review .activity-library-open').click();
  await expect(page.locator('#exercise-progress')).toContainText('16');
  await page.locator('#back-to-activities').click();
  await page.locator('#language-select').selectOption('en');
  await expect(page.locator('#exercise-title')).toHaveText('Choose an activity');
});

test('a learner profile reopens a saved analysis and resumes its available activities', async ({page}) => {
  const savedSession = {
    session_id: 'session_saved', child_id: 'child_mock', started_at: '2026-11-10T09:00:00Z', completed_at: null,
    status: 'open', state: 'remediation', recommendation_engine_version: '0.5.0', recommended_exercise_ids: ['OMI01'],
    observations: [], attempts: [],
    reading_words: [{word_id: 'saved_word', unit_id: 'saved_word', text: 'كتاب', order: 1, role: 'revision', category: 'decoding',
      expected_phonemes: ['k','a','t','a','b'], phonemes_by_word: [], phoneme_reference_status: 'validated',
      requires_linguistic_review: false, reference_warnings: [], unit_type: 'word', word_count: 1, difficulty_level: 1,
      target_skills: ['controlled_decoding'], language_variety: 'ar-MSA', max_recording_seconds: 10, recording_id: 'recording_saved',
      analysis_status: 'ok', observed_text: 'k a t a b', predicted_phonemes: ['k','a','d','a','b'], candidate_errors: [], analyzed_at: '2026-11-10T09:02:00Z'}],
  };
  await mockFlow(page,{existingProfile:true,historySessions:[savedSession]});
  await page.goto('/');
  await expect(page.locator('.profile-saved-sessions')).toBeVisible();
  await expect(page.locator('.profile-saved-session')).toContainText('Exercices disponibles');
  await expect(page.getByRole('button',{name:'Consulter le bilan'})).toBeVisible();
  await page.getByRole('button',{name:'Consulter le bilan'}).click();
  await expect(page.locator('#v3-review')).toBeVisible();
  await expect(page.locator('.report-output-grid .report-phonemes').first().locator('.report-phoneme-token')).toHaveText(['ك','َ','د','َ','ب']);
  await expect(page.locator('#verify-report')).toBeHidden();
  await expect(page.locator('.word-card-actions')).toBeHidden();
  await page.evaluate(() => localStorage.removeItem('acodyslex-v03-session'));
  await page.reload();
  await page.getByRole('button',{name:'Reprendre les exercices'}).click();
  await expect(page.locator('#v3-remediation')).toBeVisible();
  await expect(page.locator('.activity-library-card')).toHaveCount(8);
  await page.locator('.activity-library-open').first().click();
  await expect(page.locator('.activity-detail')).toBeVisible();
  await page.locator('#leave-remediation').click();
  await expect(page.locator('#v3-home')).toBeVisible();
  await page.getByRole('button',{name:'Reprendre les exercices'}).click();
  await expect(page.locator('.activity-detail')).toBeVisible();
});

test('a learner profile directly reopens activities from an abandoned session', async ({page}) => {
  const abandonedSession = {
    session_id: 'session_abandoned', child_id: 'child_mock', started_at: '2026-11-10T09:00:00Z', completed_at: null,
    status: 'open', state: 'abandoned', recommendation_engine_version: '0.5.0', recommended_exercise_ids: ['OMI01'],
    observations: [], attempts: [], reading_words: [],
  };
  const mock = await mockFlow(page,{existingProfile:true,historySessions:[abandonedSession]});
  await page.goto('/');
  await expect(page.locator('.profile-saved-session')).toContainText('Parcours arrêté');
  await expect(page.locator('.profile-guide-ready')).toBeVisible();
  await expect(page.locator('.profile-guide-ready img')).toHaveAttribute('src','/guideres/Maquette3D.png');
  await page.getByRole('button',{name:'Consulter les activités'}).click();
  await expect(page.locator('#v3-remediation')).toBeVisible();
  await expect(page.locator('.activity-library-card')).toHaveCount(8);
  expect(mock.lastState).toBe('remediation');
});

test('global reset button removes local application data after confirmation', async ({page}) => {
  const mock = await mockFlow(page,{existingProfile:true});
  await page.goto('/');
  await expect(page.locator('.profile-card')).toHaveCount(1);
  await page.locator('#laboratory-nav-btn').click();
  await expect(page.locator('#app-reset-zone')).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#reset-app').click();
  await expect(page.locator('#profile-empty')).toBeVisible();
  await expect(page.locator('#laboratory-page')).toBeHidden();
  expect(mock.profile).toBeNull();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('acodyslex-v03-session'))).toBeNull();
  await expect(page.locator('#app-reset-zone')).toBeHidden();
});

test('global reset button stays hidden for a fresh application', async ({page}) => {
  await mockFlow(page);
  await page.goto('/');
  await expect(page.locator('#profile-empty')).toBeVisible();
  await page.locator('#laboratory-nav-btn').click();
  await expect(page.locator('#app-reset-zone')).toBeHidden();
});

test('reset button is available in the laboratory page', async ({page}) => {
  await mockFlow(page,{existingProfile:true});
  await page.goto('/');
  await page.locator('#laboratory-nav-btn').click();
  await expect(page.locator('#laboratory-page')).toBeVisible();
  await expect(page.locator('#app-reset-zone')).toBeVisible();
});

test('global reset button works with a server without the reset endpoint', async ({page}) => {
  const mock = await mockFlow(page,{existingProfile:true,legacyReset:true});
  await page.goto('/');
  await page.locator('#laboratory-nav-btn').click();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#reset-app').click();
  await expect(page.locator('#profile-empty')).toBeVisible();
  expect(mock.profile).toBeNull();
});

test('V0.3.6 starts in Arabic, switches to English and preserves Arabic reading content', async ({page}) => {
  await mockFlow(page,{existingProfile:true,i18n:true});
  await fs.mkdir('artifacts/v036',{recursive:true});
  await page.setViewportSize({width:1440,height:900});
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang','ar');
  await expect(page.locator('html')).toHaveAttribute('dir','rtl');
  await expect(page.locator('#profiles-title')).toHaveText('من سيقرأ اليوم؟');
  await page.screenshot({path:'artifacts/v036/interface-ar.png',fullPage:true});

  await page.locator('#language-select').selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang','en');
  await expect(page.locator('html')).toHaveAttribute('dir','ltr');
  await expect(page.locator('#profiles-title')).toHaveText('Who will read today?');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang','en');
  await expect(page.locator('#profiles-title')).toHaveText('Who will read today?');
  await page.getByRole('button',{name:'Start',exact:true}).click();
  await expect(page.locator('#reading-title')).toHaveText('Ask the child to read this word aloud');
  await expect(page.locator('#reading-word')).toHaveAttribute('lang','ar');
  await expect(page.locator('#reading-word')).toHaveAttribute('dir','rtl');
  await page.screenshot({path:'artifacts/v036/interface-en.png',fullPage:true});
  await page.locator('#language-select').selectOption('ar');
  await expect(page.locator('#reading-title')).toHaveText('اطلب من الطفل قراءة هذه الكلمة بصوت مرتفع');
  await expect(page.locator('#reading-word')).toHaveAttribute('dir','rtl');
});

test('V0.3.7 persists a local SVG avatar, uses Latin digits and explains result provenance', async ({page}) => {
  const mock = await mockFlow(page,{i18n:true});
  await fs.mkdir('artifacts/v037',{recursive:true});
  await page.setViewportSize({width:1440,height:900});
  await page.goto('/');

  await page.locator('#new-profile-btn').click();
  await page.locator('#profile-name').fill('Reader Test');
  await page.locator('#profile-age').fill('8');
  await page.locator('input[name="avatar_id"][value="violet"]').check();
  await page.locator('#profile-form button[type="submit"]').click();
  await expect(page.locator('.profile-avatar img')).toHaveAttribute('src','/static/avatars/violet.svg');
  expect(mock.profile.avatar_id).toBe('violet');
  await page.reload();
  await expect(page.locator('.profile-avatar img')).toHaveAttribute('src','/static/avatars/violet.svg');
  await page.screenshot({path:'artifacts/v037/profiles-ar-desktop.png',fullPage:true});

  await page.evaluate(child=>localStorage.setItem('acodyslex-v03-session',JSON.stringify({
    phase:'review',child,sessionId:'session_v037',words:[],index:0,globalSummary:{analyzed_words:15,candidate_error_count:7,words_with_candidates:4,unusable_words:1},
    results:[
      {word_id:'word_1',text:'سَمَك',expected:['s','a'],observed:['s','a'],analysis_status:'ok',candidates:[{error_type:'omission',count:3}],uncertainty:null},
      {word_id:'word_2',text:'كَتَبَ',expected:['k','a'],observed:['k','a','t'],analysis_status:'ok',candidates:[{error_type:'insertion',count:1}],uncertainty:null},
      {word_id:'word_3',text:'مَدْرَسَة',expected:['m','a'],observed:['d','a','m'],analysis_status:'ok',candidates:[{error_type:'inversion',count:2}],uncertainty:null},
      {word_id:'word_4',text:'دَرَّاجَة',expected:['d','a'],observed:['t','a'],analysis_status:'ok',candidates:[{error_type:'consonant_substitution',count:1}],uncertainty:null},
      ...Array.from({length:11},(_,index)=>({word_id:`word_${index+5}`,text:'قَلَم',expected:['q','a'],observed:['q','a'],analysis_status:index===10?'unusable':'ok',candidates:[],uncertainty:index===10?'low_signal':null})),
    ],
    exercises:[],attempts:[],exerciseIndex:0,exerciseDrafts:{},analysisId:'batch_v037',recordingMeta:{},
  })),mock.profile);
  await page.reload();
  await expect(page.locator('#v3-review')).toBeVisible();
  await expect(page.locator('.report-metric')).toHaveCount(4);
  await expect(page.locator('.report-metric p')).toHaveCount(4);
  await expect(page.locator('#report-word-nav button')).toHaveCount(15);
  await expect(page.locator('#report-word-nav button[aria-current="step"]')).toHaveText('1');
  await expect(page.locator('.word-card')).toHaveCount(1);
  await expect(page.locator('.report-verify-word')).toHaveCount(1);
  await expect(page.locator('.word-candidates,.word-candidate,.candidate-edit,.candidate-delete,.report-edit-word')).toHaveCount(0);
  await expect(page.locator('.report-phoneme-note.match')).toHaveText('لا يوجد فرق صوتي ملحوظ.');
  await expect(page.locator('#verify-report')).toBeDisabled();
  expect(await page.locator('#v3-review').evaluate(root=>[...root.querySelectorAll('.word-card')].every(node=>node.scrollWidth<=node.clientWidth+1))).toBe(true);
  const nonWesternDigits=await page.locator('#v3-review').evaluate(root=>(root.innerText.match(/[\u0660-\u0669\u06f0-\u06f9]/g)||[]));
  expect(nonWesternDigits).toEqual([]);
  await expect(page.locator('.report-arabic-word').first()).toHaveAttribute('dir','rtl');
  await page.screenshot({path:'artifacts/v037/results-ar-desktop.png',fullPage:true});

  const firstCard=page.locator('.word-card').nth(0);
  await firstCard.locator('.report-verify-word').click();
  await expect(page.locator('#report-word-nav button[aria-current="step"]')).toHaveText('2');
  await page.locator('#report-word-nav button').nth(0).click();
  await expect(page.locator('.word-card .report-status')).toHaveClass(/human/);
  expect(mock.verifyPayloads[0]).toMatchObject({error_type:'omission',human_confirmed:true});
  await page.locator('#report-word-nav button').nth(1).click();
  const secondCard=page.locator('.word-card');
  await secondCard.locator('.report-reject-word').click();
  await expect(secondCard.locator('.report-status')).toHaveClass(/rejected/);
  await page.locator('#report-word-nav button').nth(2).click();
  await page.locator('.word-card .report-verify-word').click();
  await expect(page.locator('#report-word-nav button[aria-current="step"]')).toHaveText('4');
  await page.locator('.word-card .report-verify-word').click();
  for(let index=4;index<15;index++)await page.locator('.word-card .report-verify-word').click();
  await expect(page.locator('#verify-report')).toBeEnabled();
  await expect(page.locator('.report-metric.confirmed strong')).toHaveText('3');

  await page.locator('#language-select').selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('dir','ltr');
  await expect(page.locator('#report-title')).toHaveText('Reading Report');
  await expect(page.locator('.report-metric').first().locator('span')).toHaveText('Words in session');
  await expect(page.locator('.report-arabic-word').first()).toHaveAttribute('dir','rtl');
  const frenchResidue=await page.locator('#v3-review').evaluate(root=>['Mots analys?s','Erreurs candidates','Mots concern?s','Analyses incertaines','? v?rifier','Validation accompagnant'].filter(value=>root.innerText.includes(value)));
  expect(frenchResidue).toEqual([]);
  await page.screenshot({path:'artifacts/v037/results-en-desktop.png',fullPage:true});

  await page.locator('#report-filter').selectOption('confirmed');
  await expect(page.locator('#report-word-nav button')).toHaveCount(3);
  await expect(page.locator('.word-card')).toHaveCount(1);
  await page.locator('#report-filter').selectOption('all');
  for(const viewport of [{name:'tablet',width:768,height:1024},{name:'mobile',width:375,height:812}]){
    await page.setViewportSize({width:viewport.width,height:viewport.height});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
    expect(await page.locator('#v3-review').evaluate(root=>[...root.querySelectorAll('.word-card')].every(node=>node.scrollWidth<=node.clientWidth+1))).toBe(true);
    await page.screenshot({path:`artifacts/v037/results-en-${viewport.name}.png`,fullPage:true});
  }
  await page.locator('#language-select').selectOption('ar');
  await expect(page.locator('html')).toHaveAttribute('dir','rtl');
  await expect(page.locator('.report-arabic-word').first()).toHaveAttribute('dir','rtl');
  await page.screenshot({path:'artifacts/v037/results-ar-mobile.png',fullPage:true});
  await page.locator('#verify-report').click();
  await expect(page.locator('#v3-remediation')).toBeVisible();
  await expect(page.locator('.activity-library-card')).toHaveCount(8);
  expect(mock.verifyPayloads).toHaveLength(3);

});

test('report shows repeated candidate observations only once per word', async ({page}) => {
  const mock=await mockFlow(page,{existingProfile:true});
  await page.addInitScript(child=>localStorage.setItem('acodyslex-v03-session',JSON.stringify({
    phase:'review',child,sessionId:'session_deduped',words:[],index:0,
    results:[{word_id:'word_1',text:'WORD',expected:['w'],observed:['w'],analysis_status:'ok',
      candidates:[{error_type:'omission',count:1},{error_type:'omission',count:2}],uncertainty:null}],
    globalSummary:{analyzed_words:1,candidate_error_count:2,words_with_candidates:1,unusable_words:0},
    exercises:[],attempts:[],exerciseIndex:0,exerciseDrafts:{},analysisId:'batch_deduped',recordingMeta:{},
  })),profile());
  await page.goto('/');
  await expect(page.locator('.word-candidate')).toHaveCount(0);
  await expect(page.locator('.report-metric.ai strong')).toHaveText('1');
  await page.locator('.report-verify-word').click();
  expect(mock.verifyPayloads).toHaveLength(1);
  expect(mock.verifyPayloads[0]).toMatchObject({error_type:'omission',count:3,human_confirmed:true});
  page.once('dialog',dialog=>dialog.accept());
  await page.locator('#quit-report').click();
  await expect(page.locator('#v3-home')).toBeVisible();
  expect(mock.lastState).toBe('abandoned');
});

test('V0.3.6 localizes remediation instructions while Arabic learning content stays RTL', async ({page}) => {
  await mockFlow(page,{existingProfile:true,i18n:true});
  await fs.mkdir('artifacts/v036',{recursive:true});
  await page.addInitScript(({child, exercises}) => {
    localStorage.setItem('acodyslex-ui-language','ar');
    localStorage.setItem('acodyslex-v03-session',JSON.stringify({
      phase:'remediation',child,sessionId:'session_i18n',words:[],index:0,results:[],globalSummary:null,
      exercises,attempts:[],exerciseIndex:0,exerciseDrafts:{},analysisId:null,recordingMeta:{},
    }));
  },{child:profile(),exercises:remediationExercises});
  await page.setViewportSize({width:1440,height:900});
  await page.goto('/');
  await expect(page.locator('#v3-remediation')).toBeVisible();
  await page.locator('.activity-library-open').first().click();
  await expect(page.locator('.exercise-focus')).toHaveCount(1);
  await expect(page.locator('.exercise-focus h3')).not.toHaveText(remediationExercises[0].title_fr);
  expect(await page.locator('.exercise-focus h3').textContent()).toMatch(/[\u0600-\u06ff]/);
  await expect(page.locator('.exercise-instruction')).toHaveAttribute('lang','ar');
  await expect(page.locator('.exercise-instruction')).toHaveAttribute('dir','rtl');
  await expect(page.locator('.choice-button').first()).toHaveAttribute('lang','ar');
  await expect(page.locator('.choice-button').first()).toHaveAttribute('dir','rtl');
  await page.screenshot({path:'artifacts/v036/remediation-ar.png',fullPage:true});

  await page.locator('#language-select').selectOption('en');
  await expect(page.locator('.exercise-focus h3')).toHaveText('Distinguish two sounds');
  await expect(page.locator('.exercise-instruction')).toHaveAttribute('lang','en');
  await expect(page.locator('.exercise-instruction')).toHaveAttribute('dir','ltr');
  await expect(page.locator('.choice-button').first()).toHaveAttribute('lang','ar');
  await expect(page.locator('.choice-button').first()).toHaveAttribute('dir','rtl');
  const frenchResidue=await page.locator('#v3-remediation').evaluate(root=>{
    const text=root.innerText;
    return ['Activité','Consigne','Voir un exemple','Prends ton temps','Aide','Vérifier','Quitter le parcours'].filter(value=>text.includes(value));
  });
  expect(frenchResidue).toEqual([]);
  await page.screenshot({path:'artifacts/v036/remediation-en.png',fullPage:true});

  const englishTitles=['Find the missing letter','Match the sound to the letter','Put the syllables in order','Put the letters in order','Identify the added sound','Distinguish two sounds','Read a minimal pair'];
  const renderedEnglish=await page.evaluate(exercises=>exercises.map(exercise=>{
    const container=document.createElement('div');document.body.append(container);
    window.acodyslexRemediation.render({container,exercise,position:1,total:7,onDraft:()=>{},onComplete:()=>{}});
    const result={title:container.querySelector('h3').textContent,instruction:container.querySelector('.exercise-instruction').textContent,contentDir:container.querySelector('[lang="ar"]')?.dir};
    container.remove();return result;
  }),remediationExercises);
  expect(renderedEnglish.map(item=>item.title)).toEqual(englishTitles);
  expect(renderedEnglish.every(item=>item.instruction&&!/[À-ÿ]/.test(item.instruction)&&item.contentDir==='rtl')).toBe(true);

  await page.locator('#language-select').selectOption('ar');
  const renderedArabic=await page.evaluate(exercises=>exercises.map(exercise=>{
    const container=document.createElement('div');document.body.append(container);
    window.acodyslexRemediation.render({container,exercise,position:1,total:7,onDraft:()=>{},onComplete:()=>{}});
    const result={title:container.querySelector('h3').textContent,instruction:container.querySelector('.exercise-instruction').textContent,dir:container.querySelector('.exercise-instruction').dir,contentDir:container.querySelector('[lang="ar"]')?.dir};
    container.remove();return result;
  }),remediationExercises);
  expect(renderedArabic.every(item=>/[\u0600-\u06ff]/.test(item.title)&&/[\u0600-\u06ff]/.test(item.instruction)&&item.dir==='rtl'&&item.contentDir==='rtl')).toBe(true);
});

test('V0.3.6 localizes the audio laboratory and Acoustic AI states', async ({page}) => {
  await mockFlow(page,{existingProfile:true,i18n:true,batchFailures:1});
  await page.addInitScript(()=>localStorage.setItem('acodyslex-ui-language','ar'));
  await page.goto('/');
  await page.locator('#laboratory-nav-btn').click();
  await expect(page.locator('#laboratory-page')).toBeVisible();
  const arabicLaboratoryTitle=await page.evaluate(()=>window.acodyslexI18n.translate('Laboratoire audio'));
  await expect(page.locator('#laboratory-title')).toHaveText(arabicLaboratoryTitle);
  await page.locator('#language-select').selectOption('en');
  await expect(page.locator('#laboratory-title')).toHaveText('Audio laboratory');
  const laboratoryResidue=await page.locator('#laboratory-page').evaluate(root=>{
    const text=root.innerText;
    return ['Retour à l’accueil','Nouvelle lecture','Enregistrement vocal','Analyse de lecture','Séance sélectionnée','Audios sauvegardés','Chargement'].filter(value=>text.includes(value));
  });
  expect(laboratoryResidue).toEqual([]);

  await page.locator('#laboratory-back-btn').click();
  await page.locator('#language-select').selectOption('ar');
  await page.locator('.profile-card .primary').click();
  for(let index=0;index<15;index++){
    await page.locator('#session-file').setInputFiles({name:'reading.wav',mimeType:'audio/wav',buffer:wav()});
    if(index<14)await expect(page.locator('#reading-progress')).toHaveText(`الكلمة ${index+2} من 15`);
  }
  await expect(page.locator('#v3-ready')).toBeVisible();
  await expect(page.locator('#ready-title')).toHaveText(await page.evaluate(()=>window.acodyslexI18n.translate('Analyse Acoustique AI')));
  await expect(page.locator('#analysis-status-title')).toHaveText(await page.evaluate(()=>window.acodyslexI18n.translate('Les 15 lectures sont prêtes')));
  await page.locator('#language-select').selectOption('en');
  await expect(page.locator('#ready-title')).toHaveText('AI Acoustic Analysis');
  await expect(page.locator('#analysis-status-title')).toHaveText('The 15 recordings are ready');
  await page.locator('#session-transfer').check();
  await page.locator('#analyze-batch').click();
  await expect(page.locator('.ai-processing-modal')).toBeVisible();
  await expect(page.locator('#analysis-state')).toHaveAttribute('data-state','error');
  await expect(page.locator('#analysis-status-title')).toHaveText('The batch could not be analyzed');
  await expect(page.locator('.ai-processing-stage')).toHaveText('The analysis could not be completed');
  await expect(page.locator('.ai-processing-message')).toContainText('15 local recordings are preserved');
});

test('complete V0.3.3 journey keeps batch analysis, human review and seven interactive exercises', async ({page}) => {
  const state = await mockFlow(page);
  await fs.mkdir('artifacts/v03', {recursive: true});
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#profile-empty')).toBeVisible();
  await page.locator('#new-profile-btn').click(); await page.locator('#profile-name').fill('Lecteur Soleil');
  await page.locator('#profile-form button[type=submit]').click();
  await expect(page.locator('.profile-card')).toHaveCount(1);
  await page.screenshot({path: 'artifacts/v03/01-profils.png', fullPage: true});
  await page.getByRole('button', {name: 'Commencer', exact: true}).click();
  await expect(page.locator('#v3-reading')).toBeVisible();
  await page.screenshot({path: 'artifacts/v03/02-lecture.png', fullPage: true});
  expect(state.sessionBody.reading_words).toHaveLength(15);
  expect(new Set(state.sessionBody.reading_words.map(word => word.word_id)).size).toBe(15);
  await expect(page.locator('#reading-word')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('#reading-word')).not.toHaveAttribute('aria-hidden', 'true');
  await page.locator('#colored-letters').check();
  const colored = await page.locator('#reading-word').evaluate(node => { node.textContent = 'مَدْرَسَة'; node.removeAttribute('aria-hidden'); window.acodyslexArabicColoring.apply(node.textContent, true); return ({children: node.children.length, textNodes: node.childNodes.length, background: getComputedStyle(node).backgroundImage, highlights: CSS.highlights?.size || 0}); });
  expect(colored).toMatchObject({children: 0, textNodes: 1, background: 'none'}); expect(colored.highlights).toBeGreaterThan(0);
  for (const sample of ['مَدْرَسَة', 'الْكِتَابُ', 'الشَّمْسُ']) {
    expect(await page.evaluate(value => { const node = document.querySelector('#reading-word'); node.textContent = value; window.acodyslexArabicColoring.apply(value, true); return {text: node.textContent, children: node.children.length, highlights: CSS.highlights.size}; }, sample)).toEqual({text: sample, children: 0, highlights: expect.any(Number)});
  }
  for (let index = 0; index < 15; index++) {
    await page.locator('#session-file').setInputFiles({name: 'reading.wav', mimeType: 'audio/wav', buffer: wav()});
    if (index < 14) await expect(page.locator('#reading-progress')).toHaveText(`Mot ${index + 2} sur 15`);
  }
  await expect(page.locator('#v3-ready')).toBeVisible();
  expect(state.batchCalls).toBe(0);
  await page.locator('#session-transfer').check();
  await expect(page.locator('#analyze-batch')).toBeEnabled();
  await page.locator('#analyze-batch').click();
  await expect(page.locator('#v3-review')).toBeVisible();
  await page.screenshot({path: 'artifacts/v03/03-bilan.png', fullPage: true});
  await expect(page.locator('#report-word-nav button')).toHaveCount(15);
  await expect(page.locator('.word-card')).toHaveCount(1);
  await expect(page.locator('#report-summary')).toContainText('15');
  await expect(page.locator('.audio-play')).toHaveCount(1);
  await expect(page.locator('.report-audio-player')).toHaveAttribute('dir','ltr');
  expect(await page.locator('.report-audio-player').evaluate(node=>getComputedStyle(node).direction)).toBe('ltr');
  const firstRecording=page.locator('.word-card').first();
  const audio=firstRecording.locator('audio');
  await expect.poll(()=>audio.evaluate(node=>node.duration)).toBeGreaterThan(0);
  await firstRecording.locator('.audio-play').click();
  await expect.poll(()=>audio.evaluate(node=>node.currentTime)).toBeGreaterThan(0);
  await expect(page.locator('#verify-report')).toBeDisabled();
  for(let index=0;index<15;index++)await page.locator('.word-card .report-verify-word').click();
  await expect(page.locator('#verify-report')).toBeEnabled();
  await page.locator('#verify-report').click();
  await expect(page.locator('#v3-remediation')).toBeVisible();
  await page.screenshot({path: 'artifacts/v03/04-exercices.png', fullPage: true});
  await expect(page.locator('.exercise-focus')).toHaveCount(1);
  await expect(page.locator('.exercise-focus')).toHaveClass(/family-missing_letter/);
  await expect(page.locator('.exercise-instruction')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('#exercise-steps li')).toHaveCount(7);
  await expect(page.locator('#complete-session')).toBeHidden();
  await page.getByRole('button', {name: 'د', exact: true}).click(); await page.getByRole('button', {name: 'Vérifier'}).click();
  await expect(page.locator('.exercise-feedback')).toContainText(/pas encore/i);
  await page.getByRole('button', {name: 'ر', exact: true}).click(); await page.getByRole('button', {name: 'Vérifier'}).click();
  await expect(page.locator('.companion-evaluation')).toBeVisible();
  await expect(page.locator('.objective-result')).toContainText('Correction automatique');
  await page.getByRole('button', {name: 'Continuer'}).click();
  await expect(page.locator('#exercise-progress')).toHaveText('Activité 2 sur 7');
  await expect(page.locator('.exercise-focus')).toHaveClass(/family-phoneme_grapheme_matching/);
  await expect(page.locator('.audio-unavailable')).toHaveCount(0); await expect(page.locator('.companion-preparation')).toHaveCount(0); await expect(page.getByRole('button', {name: 'Réécouter'})).toHaveCount(0);
  await page.getByRole('button', {name: 'Aide'}).click(); await page.getByRole('button', {name: 'س', exact: true}).click(); await page.getByRole('button', {name: 'Vérifier'}).click(); await page.getByRole('button', {name: 'Continuer'}).click();
  await expect(page.locator('.exercise-focus')).toHaveClass(/family-syllable_ordering/);
  for (const token of ['سَ','مَ','كْ']) await page.locator('.ordering-bank').getByRole('button', {name: `Ajouter ${token}`, exact: true}).click();
  await page.getByRole('button', {name: 'Vérifier l’ordre'}).click(); await page.getByRole('button', {name: 'Continuer'}).click();
  await expect(page.locator('.exercise-focus')).toHaveClass(/family-letter_ordering/);
  for (const token of ['مَ','نْ']) await page.locator('.ordering-bank').getByRole('button', {name: `Ajouter ${token}`, exact: true}).click();
  await page.getByRole('button', {name: 'Vérifier l’ordre'}).click(); await page.getByRole('button', {name: 'Continuer'}).click();
  await expect(page.locator('.exercise-focus')).toHaveClass(/family-extra_phoneme_detection/);
  await page.getByRole('button', {name: 'كَ', exact: true}).click(); await page.getByRole('button', {name: 'Vérifier'}).click(); await page.getByRole('button', {name: 'Continuer'}).click();
  await expect(page.locator('.exercise-focus')).toHaveClass(/family-auditory_discrimination/);
  await page.getByRole('button', {name: 'سَ', exact: true}).click(); await page.getByRole('button', {name: 'Vérifier'}).click(); await page.getByRole('button', {name: 'Continuer'}).click();
  await expect(page.locator('.exercise-focus')).toHaveClass(/family-guided_reading/);
  await page.getByRole('button', {name: 'J’ai terminé ma lecture'}).click();
  await page.getByRole('button', {name: 'Réussi seul'}).click();
  await page.getByRole('button', {name: 'Valider la 7e activité'}).click();
  await expect(page.locator('#exercise-progress')).toHaveText('7 activités terminées');
  await page.locator('#complete-session').click();
  await expect(page.locator('#v3-completed')).toBeVisible();
  await page.screenshot({path: 'artifacts/v03/05-progres.png', fullPage: true});
  await expect(page.locator('#completion-text')).toContainText('15 mots');
  expect(state.recordings).toBe(0); expect(state.analyses).toBe(0); expect(state.batchCalls).toBe(1); expect(state.attempts).toBe(7); expect(errors).toEqual([]);
});

test('Acoustic AI screen explains the batch, consent and responsive flow', async ({page}) => {
  await mockFlow(page,{existingProfile:true});
  await fs.mkdir('artifacts/v035',{recursive:true});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.setViewportSize({width:1440,height:1000});
  await page.goto('/'); await reachAcousticAnalysis(page);
  await expect(page.getByRole('heading',{name:'Analyse Acoustique AI',exact:true})).toBeVisible();
  await expect(page.locator('#ready-count')).toHaveText('15 / 15');
  await expect(page.locator('#analysis-flow li')).toHaveCount(4);
  await expect(page.locator('[data-analysis-step="ai"]')).toContainText('Modal Acoustic AI');
  await expect(page.locator('#model-config-status')).toHaveText('Configuration Modal confirmée');
  await expect(page.locator('#acoustic-model-name')).toHaveText('Arabic Phoneme ASR v2');
  await expect(page.locator('#acoustic-model-id')).toHaveText('MostafaMaroof/wav2vec2-arabic-phoneme-asr');
  await expect(page.locator('#acoustic-model-version')).toHaveText('v2');
  await expect(page.locator('#acoustic-model-revision')).toHaveText('Non exposée par Modal');
  await expect(page.locator('#model-developer-card')).toBeVisible();
  await expect(page.locator('#model-developer-logo')).toHaveAttribute('alt','Meta');
  await expect(page.locator('#model-base-id')).toHaveText('facebook/wav2vec2-large-xlsr-53');
  await expect(page.locator('#acoustic-infrastructure')).toHaveText('Modal');
  await expect(page.locator('#acoustic-api-version')).toHaveText('0.3.0');
  await expect(page.locator('#acoustic-arabic-capability')).toContainText('Arabe standard moderne');
  await expect(page.locator('.analysis-consent')).toContainText('Les audios servent uniquement à l’analyse de cette séance.');
  await expect(page.locator('#analyze-batch')).toBeDisabled();
  await page.screenshot({path:'artifacts/v035/analyse-acoustique-desktop-1440.png',fullPage:true});
  await page.setViewportSize({width:375,height:812});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.screenshot({path:'artifacts/v035/analyse-acoustique-mobile-375.png',fullPage:true});
  await page.locator('#session-transfer').check();
  await expect(page.locator('#analyze-batch')).toBeEnabled();
});

test('an unreviewed Modal model never inherits the Meta attribution', async ({page}) => {
  await mockFlow(page,{existingProfile:true,acousticModel:{
    runtime_source:'Modal /health',checked_at:'2026-11-10T10:00:00Z',model_id:'example/changed-runtime-model',runtime_revision:'abc123',metadata_verified:false,
    model:{display_name:'example/changed-runtime-model',release:null,publisher:null,task:'Capacité non documentée pour ce déploiement',arabic_capability:'Non confirmée',base_model:null,base_developer:null,base_developer_confirmed:false,metadata_url:null,base_model_url:null},
    infrastructure:{provider:'Modal',deployment:'changed-deployment',api_title:'Changed API',api_version:'1.0.0'},
  }});
  await page.goto('/');await reachAcousticAnalysis(page);
  await expect(page.locator('#model-config-status')).toHaveText('Modèle déployé non documenté');
  await expect(page.locator('#model-developer-card')).toBeHidden();
  await expect(page.locator('#acoustic-model-id')).toHaveText('example/changed-runtime-model');
  await expect(page.locator('#acoustic-model-revision')).toHaveText('abc123');
  await expect(page.locator('#acoustic-arabic-capability')).toHaveText('Non confirmée');
  await expect(page.locator('#model-rigor-note')).toContainText('ne sont pas dans la liste vérifiée');
});

test('Acoustic AI progress highlights processing and a failed lot can be retried', async ({page}) => {
  const state=await mockFlow(page,{existingProfile:true,batchDelay:900,batchFailures:1});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto('/'); await reachAcousticAnalysis(page);
  await page.locator('#session-transfer').check(); await page.locator('#analyze-batch').click();
  await expect(page.locator('[data-analysis-step="ai"]')).toHaveClass(/active/,{timeout:2000});
  await expect(page.locator('#analysis-status-title')).toHaveText('Analyse Acoustique AI en cours…');
  await expect(page.locator('#analysis-status-title')).toHaveText('Le lot n’a pas pu être analysé',{timeout:2500});
  await expect(page.locator('#analyze-batch')).toHaveText('Réessayer l’Analyse Acoustique AI');
  await expect(page.locator('.ai-processing-modal')).toHaveAttribute('data-state','error');
  const localCount=await page.evaluate(async()=>{const saved=JSON.parse(localStorage.getItem('acodyslex-v03-session'));return (await window.acodyslexAudioStore.getSession(saved.child.child_id,saved.sessionId)).length;});
  expect(localCount).toBe(15); expect(state.batchCalls).toBe(1);
  await page.locator('.ai-processing-retry').click();
  await expect(page.locator('[data-analysis-step="ai"]')).toHaveClass(/active/,{timeout:2000});
  await expect(page.locator('#v3-review')).toBeVisible({timeout:3500});
  await expect(page.locator('.ai-processing-modal')).toBeHidden();
  expect(await page.locator('#analysis-state').getAttribute('data-state')).toBe('success');
  expect(state.batchCalls).toBe(2);
});

test('AI processing modal is accessible, indeterminate, responsive and closes on success', async ({page}) => {
  const state=await mockFlow(page,{existingProfile:true,i18n:true,batchDelay:3000});
  await fs.mkdir('artifacts/ai-modal',{recursive:true});
  await page.addInitScript(()=>localStorage.setItem('acodyslex-ui-language','ar'));
  await page.setViewportSize({width:1440,height:900});
  await page.goto('/');await reachAcousticAnalysis(page);
  await page.locator('#session-transfer').check();await page.locator('#analyze-batch').click();
  const modal=page.locator('.ai-processing-modal'),dialog=modal.getByRole('dialog');
  await expect(modal).toBeVisible();await expect(dialog).toHaveAttribute('aria-modal','true');
  await expect(modal.locator('.ai-processing-technology.modal img[alt="Modal"]')).toBeVisible();
  await expect(modal.locator('.ai-processing-technology.meta img[alt="Meta"]')).toBeVisible();
  await expect(modal.locator('#ai-processing-title')).toHaveText(await page.evaluate(()=>window.acodyslexI18n.t('aiModal.title')));
  await expect(modal.locator('.ai-processing-message')).toHaveAttribute('aria-live','polite');
  await expect(modal.locator('.ai-processing-indeterminate')).not.toHaveAttribute('aria-valuenow',/.+/);
  await expect(page.locator('body>.container')).toHaveJSProperty('inert',true);
  await expect(modal.locator('#ai-processing-stage')).toHaveText(await page.evaluate(()=>window.acodyslexI18n.t('aiModal.steps.analyzing.label')),{timeout:2200});
  expect(await modal.locator('.ai-processing-wave i').first().evaluate(node=>getComputedStyle(node).animationName)).not.toBe('none');
  await page.evaluate(()=>document.querySelector('#analyze-batch').click());expect(state.batchCalls).toBe(1);
  for(const viewport of [{name:'desktop',width:1440,height:900},{name:'tablet',width:768,height:1024},{name:'mobile',width:375,height:812}]){await page.setViewportSize({width:viewport.width,height:viewport.height});const geometry=await dialog.boundingBox();expect(geometry.x).toBeGreaterThanOrEqual(0);expect(geometry.x+geometry.width).toBeLessThanOrEqual(viewport.width+1);expect(Math.abs((geometry.x+geometry.width/2)-(viewport.width/2))).toBeLessThan(4);await page.screenshot({path:`artifacts/ai-modal/processing-ar-${viewport.name}.png`});}
  await page.emulateMedia({reducedMotion:'reduce'});expect(await modal.locator('.ai-processing-wave i').first().evaluate(node=>getComputedStyle(node).animationName)).toBe('none');
  await expect(page.locator('#v3-review')).toBeVisible({timeout:6000});await expect(modal).toBeHidden();
  await expect(page.locator('#report-title')).toBeFocused();expect(state.batchCalls).toBe(1);
});

test('AI processing modal timeout preserves audio and returns control without claiming cancellation', async ({page}) => {
  const state=await mockFlow(page,{existingProfile:true,i18n:true,batchDelay:700});
  await page.addInitScript(()=>{window.ACODYSLEX_ANALYSIS_TIMEOUT_MS=150;localStorage.setItem('acodyslex-ui-language','en');});
  await page.goto('/');await reachAcousticAnalysis(page);
  await page.locator('#session-transfer').check();await page.locator('#analyze-batch').click();
  const modal=page.locator('.ai-processing-modal');await expect(modal).toHaveAttribute('data-state','timeout',{timeout:1800});
  await expect(modal.locator('.ai-processing-stage')).toHaveText('The browser stopped waiting');
  await expect(modal.locator('.ai-processing-message')).toContainText('Remote processing may still continue');
  await expect(modal.locator('.ai-processing-retry')).toBeFocused();await page.keyboard.press('Shift+Tab');await expect(modal.locator('.ai-processing-close')).toBeFocused();await page.keyboard.press('Tab');await expect(modal.locator('.ai-processing-retry')).toBeFocused();
  const localCount=await page.evaluate(async()=>{const saved=JSON.parse(localStorage.getItem('acodyslex-v03-session'));return (await window.acodyslexAudioStore.getSession(saved.child.child_id,saved.sessionId)).length;});
  expect(localCount).toBe(15);expect(state.batchCalls).toBe(1);await expect(page.locator('body>.container')).toHaveJSProperty('inert',true);
  await modal.locator('.ai-processing-close').click();await expect(modal).toBeHidden();await expect(page.locator('body>.container')).toHaveJSProperty('inert',false);await expect(page.locator('#analyze-batch')).toBeEnabled();await expect(page.locator('#analyze-batch')).toBeFocused();
});

test('reading state survives a reload and mobile layout stays within the viewport', async ({page}) => {
  await mockFlow(page); await page.setViewportSize({width: 390, height: 844}); await page.goto('/');
  await page.locator('#new-profile-btn').click(); await page.locator('#profile-name').fill('Lecteur Soleil'); await page.locator('#profile-form button[type=submit]').click();
  await page.getByRole('button', {name: 'Commencer', exact: true}).click();
  await page.locator('#session-file').setInputFiles({name: 'reading.wav', mimeType: 'audio/wav', buffer: wav()});
  await expect(page.locator('#reading-progress')).toHaveText('Mot 2 sur 15');
  await page.reload(); await expect(page.locator('#v3-reading')).toBeVisible(); await expect(page.locator('#reading-progress')).toHaveText('Mot 2 sur 15');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('human validation canonicalizes candidates and displays the exact FastAPI 422 field', async ({page}) => {
  const state = await mockFlow(page, {existingProfile: true, verifyFailure: [{
    type: 'int_type', loc: ['body', 'count'], msg: 'Input should be a valid integer', input: null,
  }]});
  await page.addInitScript(child => localStorage.setItem('acodyslex-v03-session', JSON.stringify({
    phase: 'review', child, sessionId: 'session_review', words: [], index: 0,
    results: [{word_id: 'w01', text: 'كَتَبَ', observed: [], analysis_status: 'ok',
      candidates: [{error_type: 'substitution', count: {invalid: true}}], uncertainty: null}],
    globalSummary: {analyzed_words: 1, candidate_error_count: 1, words_with_candidates: 1, unusable_words: 0},
    exercises: [], attempts: [], exerciseIndex: 0, exerciseDrafts: {}, analysisId: 'batch_review', recordingMeta: {},
  })), profile());
  await page.goto('/');
  await expect(page.locator('#v3-review')).toBeVisible();
  await expect(page.locator('.candidate-edit')).toHaveCount(0);
  await page.locator('.report-verify-word').first().click();
  await expect(page.locator('#receipt-message')).toContainText('count : Input should be a valid integer');
  await expect(page.locator('#receipt-message')).not.toContainText('[object Object]');
  expect(state.verifyPayloads[0]).toMatchObject({error_type: 'consonant_substitution', count: 1, opportunities: 15, distinct_items: 1});
  expect(Number.isInteger(state.verifyPayloads[0].count)).toBe(true);
});

test('V0.3.3 remediation uses the viewport at 1440, short 768 and 375 pixels', async ({page}) => {
  await mockFlow(page, {existingProfile: true});
  await fs.mkdir('artifacts/v033', {recursive: true});
  await page.addInitScript(({child, exercises}) => localStorage.setItem('acodyslex-v03-session', JSON.stringify({
    phase:'remediation', child, sessionId:'session_responsive', words:[], index:0, results:[], globalSummary:null,
    exercises, attempts:[], exerciseIndex:0, exerciseDrafts:{}, analysisId:null, recordingMeta:{},
  })), {child: profile(), exercises: remediationExercises});
  const sizes = [
    {width:1440, height:1000, name:'remediation-desktop-1440.png'},
    {width:768, height:1024, name:'remediation-tablet-768.png'},
    {width:768, height:760, name:'remediation-tablet-768x760.png', mustFit:true},
    {width:375, height:812, name:'remediation-mobile-375.png'},
  ];
  for (const size of sizes) {
    await page.setViewportSize(size); await page.goto('/');
    await expect(page.locator('#v3-remediation')).toBeVisible();
    await expect(page.locator('.exercise-focus')).toHaveCount(1);
    const metrics = await page.evaluate(() => {
      const instruction = document.querySelector('.exercise-instruction'), choice = document.querySelector('.choice-button');
      const shell = document.querySelector('.v3-shell').getBoundingClientRect(), screen = document.querySelector('#v3-remediation').getBoundingClientRect(), actions = document.querySelector('.remediation-session-actions').getBoundingClientRect();
      return {overflow: document.documentElement.scrollWidth - innerWidth, instructionSize: parseFloat(getComputedStyle(instruction).fontSize), lineHeight: parseFloat(getComputedStyle(instruction).lineHeight), choiceHeight: choice.getBoundingClientRect().height, dir: instruction.dir, leftGap: screen.left-shell.left, rightGap: shell.right-screen.right, actionsBottom: actions.bottom};
    });
    expect(metrics.overflow).toBeLessThanOrEqual(1); expect(metrics.instructionSize).toBeGreaterThanOrEqual(24); expect(metrics.lineHeight).toBeGreaterThan(metrics.instructionSize); expect(metrics.choiceHeight).toBeGreaterThanOrEqual(48); expect(metrics.dir).toBe('rtl'); expect(metrics.leftGap).toBeLessThanOrEqual(2); expect(metrics.rightGap).toBeLessThanOrEqual(2);
    if(size.mustFit)expect(metrics.actionsBottom).toBeLessThanOrEqual(size.height);
    await page.screenshot({path:`artifacts/v033/${size.name}`, fullPage:true});
  }
  await page.emulateMedia({reducedMotion:'reduce'}); await page.reload();
  expect(await page.locator('.choice-button').first().evaluate(node => getComputedStyle(node).transitionDuration)).toBe('0s');
});

test('remediation never displays audio controls because the child reads the activity', async ({page}) => {
  await mockFlow(page, {existingProfile: true});
  const available = {...remediationExercises[5], audio:{status:'available', url:'data:audio/wav;base64,UklGRgQAAABXQVZF'}};
  await page.addInitScript(({child, exercises}) => {
    localStorage.setItem('acodyslex-v03-session', JSON.stringify({phase:'remediation',child,sessionId:'session_audio',words:[],index:0,results:[],globalSummary:null,exercises,attempts:[],exerciseIndex:0,exerciseDrafts:{},analysisId:null,recordingMeta:{}}));
  }, {child:profile(), exercises:[available, ...remediationExercises.slice(1)]});
  await page.goto('/');
  await expect(page.locator('.audio-play-button')).toHaveCount(0);
  await expect(page.locator('.audio-ready audio')).toHaveCount(0);
  await expect(page.locator('.audio-unavailable')).toHaveCount(0);
  await expect(page.locator('.companion-preparation')).toHaveCount(0);
});

test('guided reading is listened to directly by the companion without application audio', async ({page}) => {
  const state = await mockFlow(page, {existingProfile: true});
  await page.setViewportSize({width:768,height:760});
  await page.addInitScript(({child, exercises}) => localStorage.setItem('acodyslex-v03-session', JSON.stringify({
    phase:'remediation',child,sessionId:'session_guided',words:[],index:0,results:[],globalSummary:null,exercises,
    attempts:Array.from({length:6},(_,index)=>({attempt_id:`done_${index}`})),exerciseIndex:6,exerciseDrafts:{},analysisId:null,recordingMeta:{},
  })), {child:profile(), exercises:remediationExercises});
  await page.goto('/');
  await page.locator('.activity-library-card.guided_read .activity-library-open').click();
  await expect(page.locator('.exercise-focus')).toHaveClass(/family-guided_reading/);
  await expect(page.locator('.companion-evaluation')).toBeHidden();
  const initialLayout=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth-innerWidth,actionsBottom:document.querySelector('.remediation-session-actions').getBoundingClientRect().bottom}));
  expect(initialLayout.overflow).toBeLessThanOrEqual(1);expect(initialLayout.actionsBottom).toBeLessThanOrEqual(760);
  await page.screenshot({path:'artifacts/v033/remediation-guided-768x760.png',fullPage:true});
  await expect(page.locator('.guided-recording, .audio-play-button, .audio-ready audio')).toHaveCount(0);
  await page.getByRole('button', {name:'L’accompagnateur a écouté la lecture'}).click();
  await expect(page.locator('.companion-evaluation')).toBeVisible();
  await page.locator('.observation-field textarea').fill('Lecture posée.');
  await page.getByRole('button', {name:'Réussi seul'}).click();
  await page.locator('.exercise-continue').click();
  await expect(page.locator('.exercise-focus')).toBeVisible();
  expect(state.attempts).toBe(1); expect(state.lastAttempt).toMatchObject({activity_family:'guided_reading', interaction_attempts:1, assistance_level:'independent', outcome:'independent_success'});
});

test('remediation resumes on the next unfinished exercise and abandonment records no failures', async ({page}) => {
  const state = await mockFlow(page, {existingProfile: true});
  await page.addInitScript(({child, exercises}) => {
    localStorage.setItem('acodyslex-v03-session', JSON.stringify({phase:'remediation',child,sessionId:'session_resume',words:[],index:0,results:[],globalSummary:null,exercises,attempts:[{attempt_id:'done_1'}],exerciseIndex:1,exerciseDrafts:{SUB02:{tries:1,helpUsed:true}},analysisId:null,recordingMeta:{}}));
  }, {child: profile(), exercises: remediationExercises});
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/');
  await expect(page.locator('#v3-remediation')).toBeVisible();
  await expect(page.locator('#exercise-progress')).toHaveText('Activité 2 sur 7');
  await expect(page.locator('.exercise-hint')).toBeVisible();
  await page.locator('#abandon-remediation').click();
  await expect(page.locator('#v3-home')).toBeVisible();
  expect(state.lastState).toBe('abandoned'); expect(state.attempts).toBe(0);
});

test('canceling an in-progress recording discards it without saving or sending it', async ({page}) => {
  await mockFlow(page, {existingProfile: true}); await page.goto('/');
  await page.getByRole('button', {name: 'Commencer', exact: true}).click();
  await expect(page.locator('#v3-reading')).toBeVisible();
  const bytes = [...wav()];
  await page.evaluate(data => {
    const blob = new Blob([new Uint8Array(data)], {type: 'audio/wav'});
    window.testCancelCapture = {recording: false, startCalls: 0, stopCalls: 0};
    window.acodyslexLegacyAudio = {
      start: async () => { window.testCancelCapture.startCalls++; window.testCancelCapture.recording = true; },
      stopAndGetBlob: async () => { window.testCancelCapture.stopCalls++; window.testCancelCapture.recording = false; return blob; },
      pause: async () => {}, resume: async () => {},
      isRecording: () => window.testCancelCapture.recording,
      isPaused: () => false,
      useFile: async () => ({usable: true, signal: {rms: .2, peak: .35}}),
      getLiveSamples: () => new Float32Array([0,.2,-.2]),
      release: async () => { window.testCancelCapture.recording = false; },
    };
  }, bytes);
  await page.locator('#session-start').click();
  await expect(page.locator('#session-cancel')).toBeEnabled();
  await page.locator('#session-cancel').click();
  await expect(page.locator('#recording-indicator')).toHaveText('Prêt');
  await expect(page.locator('#reading-progress')).toHaveText('Mot 1 sur 15');
  await expect(page.locator('#reading-message')).toContainText('ni sauvegardé ni envoyé');
  await expect(page.locator('#session-cancel')).toBeDisabled();
  const result = await page.evaluate(async () => {
    const saved = JSON.parse(localStorage.getItem('acodyslex-v03-session'));
    const rows = await window.acodyslexAudioStore.getSession(saved.child.child_id, saved.sessionId);
    return {telemetry: window.testCancelCapture, count: rows.length};
  });
  expect(result).toEqual({telemetry: {recording: false, startCalls: 1, stopCalls: 1}, count: 0});
});

test('a saved recording can be canceled from the review list before analysis', async ({page}) => {
  await mockFlow(page, {existingProfile: true}); await page.goto('/');
  await page.getByRole('button', {name: 'Commencer', exact: true}).click();
  await expect(page.locator('#v3-reading')).toBeVisible();
  const bytes = [...wav()];
  await page.evaluate(async data => {
    const saved = JSON.parse(localStorage.getItem('acodyslex-v03-session'));
    const word = saved.words[0];
    await window.acodyslexAudioStore.put({
      child_id: saved.child.child_id, session_id: saved.sessionId, word_id: word.word_id,
      word_order: word.order, reference_text: word.text, expected_phonemes: word.expected_phonemes,
      audio_duration_ms: 250, audio_format: 'audio/wav;codecs=pcm_s16le', recording_status: 'ready',
      blob: new Blob([new Uint8Array(data)], {type: 'audio/wav'}),
    });
    saved.phase = 'ready'; localStorage.setItem('acodyslex-v03-session', JSON.stringify(saved));
  }, bytes);
  page.on('dialog', dialog => dialog.accept());
  await page.reload();
  await expect(page.locator('#v3-ready')).toBeVisible();
  await expect(page.locator('#ready-count')).toHaveText('1 / 15');
  await page.locator('.analysis-recordings summary').click();
  await page.locator('.recording-row').first().getByRole('button', {name: 'Annuler'}).click();
  await expect(page.locator('#ready-count')).toHaveText('0 / 15');
  const count = await page.evaluate(async () => {
    const saved = JSON.parse(localStorage.getItem('acodyslex-v03-session'));
    return (await window.acodyslexAudioStore.getSession(saved.child.child_id, saved.sessionId)).length;
  });
  expect(count).toBe(0);
});

test('pause excludes paused time and resumes the same word without analysis', async ({page}) => {
  const state = await mockFlow(page, {existingProfile: true}); await page.goto('/');
  await page.getByRole('button', {name: 'Commencer', exact: true}).click();
  const bytes = [...wav()];
  await page.evaluate(data => {
    const blob = new Blob([new Uint8Array(data)], {type: 'audio/wav'});
    window.testCapture = {recording: false, paused: false, pauseCalls: 0, resumeCalls: 0, startCalls: 0, active: 0, maxActive: 0};
    window.acodyslexLegacyAudio = {
      start: async () => { window.testCapture.startCalls++; window.testCapture.active++; window.testCapture.maxActive=Math.max(window.testCapture.maxActive,window.testCapture.active); window.testCapture.recording = true; },
      stopAndGetBlob: async () => { window.testCapture.active--; window.testCapture.recording = false; return blob; },
      pause: async () => { window.testCapture.paused = true; window.testCapture.pauseCalls++; },
      resume: async () => { window.testCapture.paused = false; window.testCapture.resumeCalls++; },
      isRecording: () => window.testCapture.recording,
      isPaused: () => window.testCapture.paused,
      useFile: async () => ({usable: true, signal: {rms: .1, peak: .2}}),
      getLiveSamples: () => new Float32Array([0,.2,-.2,.1]),
      release: async () => { window.testCapture.recording=false; window.testCapture.active=0; },
    };
  }, bytes);
  await expect(page.locator('#reading-word')).not.toBeEmpty();
  await page.locator('#session-start').click();
  await expect(page.locator('#reading-word')).not.toBeEmpty();
  await page.locator('#session-pause').click();
  const pausedAt = await page.locator('#session-timer').textContent(); await page.waitForTimeout(500);
  await expect(page.locator('#session-timer')).toHaveText(pausedAt);
  await page.locator('#session-pause').click(); await page.waitForTimeout(250); await page.locator('#session-stop').click();
  await expect(page.locator('#reading-progress')).toHaveText('Mot 2 sur 15');
  await expect(page.locator('#recording-indicator')).toContainText('Enregistrement en cours');
  expect(await page.evaluate(() => window.testCapture)).toMatchObject({pauseCalls: 1, resumeCalls: 1, startCalls: 2, maxActive: 1, recording: true});
  expect(state.batchCalls).toBe(0); expect(state.analyses).toBe(0);
});

test('one click records fifteen isolated WAVs before one explicit grouped analysis', async ({page}) => {
  const state = await mockFlow(page, {existingProfile: true});
  await fs.mkdir('artifacts/v034', {recursive: true});
  await page.setViewportSize({width: 1440, height: 1000});
  await page.goto('/');
  await page.getByRole('button', {name: 'Commencer', exact: true}).click();
  const bytes = [...wav()];
  await page.evaluate(data => {
    const blob = new Blob([new Uint8Array(data)], {type:'audio/wav'});
    const samples = Float32Array.from({length:256},(_,index)=>Math.sin(index/8)*.35);
    window.testContinuous={recording:false,paused:false,startCalls:0,stopCalls:0,active:0,maxActive:0,releaseCalls:0,startOptions:[],stopOptions:[]};
    window.acodyslexLegacyAudio={
      start:async options=>{const t=window.testContinuous;t.startCalls++;t.active++;t.maxActive=Math.max(t.maxActive,t.active);t.startOptions.push(options);t.recording=true;},
      stopAndGetBlob:async options=>{const t=window.testContinuous;t.stopCalls++;t.active--;t.stopOptions.push(options);t.recording=false;return blob;},
      pause:async()=>{window.testContinuous.paused=true;},resume:async()=>{window.testContinuous.paused=false;},
      isRecording:()=>window.testContinuous.recording,isPaused:()=>window.testContinuous.paused,
      useFile:async()=>({usable:true,signal:{rms:.2,peak:.35}}),getLiveSamples:()=>samples,
      release:async()=>{const t=window.testContinuous;t.releaseCalls++;t.recording=false;t.active=0;},
    };
  }, bytes);

  await page.locator('#session-start').click();
  await expect(page.locator('#recording-indicator')).toContainText('Enregistrement en cours');
  await page.waitForTimeout(120);
  await page.screenshot({path:'artifacts/v034/lecture-desktop-1440.png',fullPage:true});
  await page.setViewportSize({width:375,height:812});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.screenshot({path:'artifacts/v034/lecture-mobile-375.png',fullPage:true});
  await page.setViewportSize({width:768,height:1024});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);

  for(let index=0;index<15;index++){
    await page.locator('#session-stop').click();
    if(index<14){
      await expect(page.locator('#reading-progress')).toHaveText(`Mot ${index+2} sur 15`);
      await expect(page.locator('#recording-indicator')).toContainText('Enregistrement en cours');
    }
  }
  await expect(page.locator('#v3-ready')).toBeVisible();
  await expect(page.locator('#ready-count')).toHaveText('15 / 15');
  const captured=await page.evaluate(async()=>{
    const saved=JSON.parse(localStorage.getItem('acodyslex-v03-session'));
    const rows=await window.acodyslexAudioStore.getSession(saved.child.child_id,saved.sessionId);
    return {telemetry:window.testContinuous,rows:rows.map(row=>({word_id:row.word_id,word_order:row.word_order,reference_text:row.reference_text}))};
  });
  expect(captured.telemetry).toMatchObject({startCalls:15,stopCalls:15,maxActive:1,active:0,recording:false});
  expect(captured.telemetry.startOptions.every(options=>options.keepStream===true)).toBe(true);
  expect(captured.rows).toHaveLength(15);
  expect(new Set(captured.rows.map(row=>row.word_id)).size).toBe(15);
  expect(captured.rows.sort((a,b)=>a.word_order-b.word_order).map(row=>row.reference_text)).toEqual(state.sessionBody.reading_words.map(word=>word.text));
  expect(state.batchCalls).toBe(0); expect(state.analyses).toBe(0);

  await page.locator('#session-transfer').check();
  await page.locator('#analyze-batch').click();
  await expect(page.locator('#v3-review')).toBeVisible();
  expect(state.batchCalls).toBe(1); expect(state.analyses).toBe(0);
});

test('the word duration limit finalizes once and starts the next segment', async ({page}) => {
  await page.addInitScript(()=>{window.ACODYSLEX_WORD_LIMIT_SECONDS=1;});
  const state=await mockFlow(page,{existingProfile:true});
  await page.goto('/'); await page.getByRole('button',{name:'Commencer',exact:true}).click();
  const bytes=[...wav()];
  await page.evaluate(data=>{
    const blob=new Blob([new Uint8Array(data)],{type:'audio/wav'});
    window.testLimit={recording:false,startCalls:0,stopCalls:0};
    window.acodyslexLegacyAudio={start:async()=>{window.testLimit.startCalls++;window.testLimit.recording=true;},stopAndGetBlob:async()=>{window.testLimit.stopCalls++;window.testLimit.recording=false;return blob;},pause:async()=>{},resume:async()=>{},isRecording:()=>window.testLimit.recording,isPaused:()=>false,useFile:async()=>({usable:true}),getLiveSamples:()=>new Float32Array([0,.2,-.2]),release:async()=>{window.testLimit.recording=false;}};
  },bytes);
  await page.locator('#session-start').click();
  await expect(page.locator('#reading-progress')).toHaveText('Mot 2 sur 15',{timeout:3000});
  await expect(page.locator('#recording-indicator')).toContainText('Enregistrement en cours');
  expect(await page.evaluate(()=>window.testLimit)).toMatchObject({startCalls:2,stopCalls:1,recording:true});
  expect(state.batchCalls).toBe(0);
});

test('two seconds of silence after speech finalize the word but initial silence does not', async ({page}) => {
  const state=await mockFlow(page,{existingProfile:true});
  await page.goto('/'); await page.getByRole('button',{name:'Commencer',exact:true}).click();
  const bytes=[...wav()];
  await page.evaluate(data=>{
    const blob=new Blob([new Uint8Array(data)],{type:'audio/wav'});
    window.testSilence={recording:false,startCalls:0,stopCalls:0,signal:{rms:0,peak:0}};
    window.acodyslexLegacyAudio={start:async()=>{window.testSilence.startCalls++;window.testSilence.recording=true;},stopAndGetBlob:async()=>{window.testSilence.stopCalls++;window.testSilence.recording=false;return blob;},pause:async()=>{},resume:async()=>{},isRecording:()=>window.testSilence.recording,isPaused:()=>false,useFile:async()=>({usable:true}),getLiveSamples:()=>new Float32Array([0]),getLiveSignal:()=>window.testSilence.signal,release:async()=>{window.testSilence.recording=false;}};
  },bytes);
  await page.locator('#session-start').click();
  await page.waitForTimeout(2200);
  await expect(page.locator('#reading-progress')).toHaveText('Mot 1 sur 15');
  expect(await page.evaluate(()=>window.testSilence.stopCalls)).toBe(0);
  await page.evaluate(()=>{window.testSilence.signal={rms:.02,peak:.08};});
  await page.waitForTimeout(350);
  await page.evaluate(()=>{window.testSilence.signal={rms:0,peak:0};});
  await expect(page.locator('#reading-progress')).toHaveText('Mot 2 sur 15',{timeout:3500});
  await expect(page.locator('#recording-indicator')).toContainText('Enregistrement en cours');
  expect(await page.evaluate(()=>window.testSilence)).toMatchObject({startCalls:2,stopCalls:1,recording:true});
  expect(state.batchCalls).toBe(0);
});

test('the reading waveform uses live samples and stops while paused or reduced', async ({page}) => {
  await mockFlow(page,{existingProfile:true}); await page.goto('/');
  const active=await page.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=420;canvas.height=100;document.body.append(canvas);
    const samples=Float32Array.from({length:512},(_,index)=>Math.sin(index/10)*.42);
    const instance=window.acodyslexReadingWaveform.create(canvas,()=>({getLiveSamples:()=>samples}));
    window.testWave=instance;instance.setState('recording');await new Promise(resolve=>setTimeout(resolve,100));return instance.metrics();
  });
  expect(active.framesDrawn).toBeGreaterThan(1); expect(active.lastAmplitude).toBeGreaterThan(.4); expect(active.running).toBe(true);
  const paused=await page.evaluate(async()=>{window.testWave.setState('paused');const before=window.testWave.metrics().framesDrawn;await new Promise(resolve=>setTimeout(resolve,80));return {before,after:window.testWave.metrics().framesDrawn,running:window.testWave.metrics().running};});
  expect(paused.after).toBe(paused.before); expect(paused.running).toBe(false);
  await page.evaluate(()=>window.testWave.destroy());
  await page.emulateMedia({reducedMotion:'reduce'});
  const reduced=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=300;canvas.height=80;document.body.append(canvas);const wave=window.acodyslexReadingWaveform.create(canvas,()=>({getLiveSamples:()=>new Float32Array([.5,-.5])}));wave.setState('recording');const metrics=wave.metrics();wave.destroy();return metrics;});
  expect(reduced.running).toBe(false);
});

test('redo from recap replaces only that word and preserves the other fourteen', async ({page}) => {
  await mockFlow(page, {existingProfile: true}); await page.goto('/');
  await page.getByRole('button', {name: 'Commencer', exact: true}).click();
  for (let index = 0; index < 15; index++) {
    await page.locator('#session-file').setInputFiles({name: 'reading.wav', mimeType: 'audio/wav', buffer: wav()});
    if(index<14)await expect(page.locator('#reading-progress')).toHaveText(`Mot ${index+2} sur 15`);
  }
  await expect(page.locator('#v3-ready')).toBeVisible();
  await page.locator('.analysis-recordings summary').click();
  await page.locator('.recording-row').first().getByRole('button', {name: 'Recommencer'}).click();
  await expect(page.locator('#reading-progress')).toHaveText('Mot 1 sur 15');
  await page.locator('#session-file').setInputFiles({name: 'replacement.wav', mimeType: 'audio/wav', buffer: wav()});
  await expect(page.locator('#v3-ready')).toBeVisible(); await expect(page.locator('#ready-count')).toHaveText('15 / 15');
  const stored = await page.evaluate(async () => {
    const raw = JSON.parse(localStorage.getItem('acodyslex-v03-session'));
    const rows = await window.acodyslexAudioStore.getSession(raw.child.child_id, raw.sessionId);
    return {count: rows.length, unique: new Set(rows.map(row => row.word_id)).size};
  });
  expect(stored).toEqual({count: 15, unique: 15});
});

test('a second session excludes the 15 recent words and keeps revision, consolidation and transfer', async ({page}) => {
  const recentWords = Array.from({length: 15}, (_, index) => ({word_id: `w${String(index + 1).padStart(2, '0')}`}));
  const state = await mockFlow(page, {existingProfile: true, historySessions: [{session_id: 'previous', reading_words: recentWords}]});
  await page.goto('/'); await page.getByRole('button', {name: 'Commencer', exact: true}).click();
  await expect(page.locator('#v3-reading')).toBeVisible();
  const selected = state.sessionBody.reading_words;
  expect(selected).toHaveLength(15);
  expect(selected.every(word => !recentWords.some(recent => recent.word_id === word.word_id))).toBe(true);
  expect(selected.filter(word => word.role === 'revision')).toHaveLength(6);
  expect(selected.filter(word => word.role === 'consolidation')).toHaveLength(6);
  expect(selected.filter(word => word.role === 'transfer')).toHaveLength(3);
});

test('backend outage is explicit on the profile screen', async ({page}) => {
  await page.addInitScript(()=>{window.__ACODYSLEX_TEST_SOURCE_UI__=true;});
  await page.route('**/api/config', route => route.fulfill({json: {modal_ready: false, whisper_enabled: false}}));
  await page.route('**/api/recordings', route => route.fulfill({json: []}));
  await page.route('**/v1/progress/children', route => route.fulfill({status: 503, json: {detail: 'Service temporairement indisponible'}}));
  await page.goto('/');
  await expect(page.locator('#profile-list')).toContainText('Backend indisponible');
  await expect(page.locator('#profile-list')).toContainText('Service temporairement indisponible');
});

test('laboratory is lazy, responsive and returns to the preserved child session', async ({page}) => {
  const state = await mockFlow(page, {existingProfile: true});
  await fs.mkdir('artifacts/v03', {recursive: true});
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('/');
  await expect(page.locator('#laboratory-page')).toBeHidden();
  expect(await page.evaluate(() => window.acodyslexLaboratory.isInitialized())).toBe(false);
  expect(state.sessionBody).toBeNull();

  await page.getByRole('button', {name: 'Commencer', exact: true}).click();
  await expect(page.locator('#v3-reading')).toBeVisible();
  const wordBefore = await page.locator('#reading-word').textContent();

  await page.locator('#laboratory-nav-btn').click();
  await expect(page.locator('#laboratory-page')).toBeVisible();
  await expect(page.locator('#child-page')).toBeHidden();
  expect(await page.evaluate(() => window.acodyslexLaboratory.isInitialized())).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({path: 'artifacts/v03/06-laboratoire-mobile.png', fullPage: true});

  await page.evaluate(() => { window.testConfirmCalls = 0; window.confirm = () => { window.testConfirmCalls++; return false; }; pcmCapture = {}; });
  await page.locator('#laboratory-back-btn').click();
  await expect(page.locator('#laboratory-page')).toBeVisible();
  expect(await page.evaluate(() => window.testConfirmCalls)).toBe(1);
  await page.evaluate(() => { pcmCapture = null; });
  await page.locator('#laboratory-back-btn').click();
  await expect(page.locator('#laboratory-page')).toBeHidden();
  await expect(page.locator('#v3-reading')).toBeVisible();
  await expect(page.locator('#reading-word')).toHaveText(wordBefore);
  await expect(page.locator('#reading-progress')).toHaveText('Mot 1 sur 15');
});
