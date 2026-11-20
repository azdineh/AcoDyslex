const {test: base, expect} = require('@playwright/test');
const fs = require('node:fs/promises');

// All examples are synthetic fixtures, never observations of a child's speech.
function candidate() {
  return {
    status: 'ok', model: 'simulated-model',
    expected_phonemes: ['k', 'a', 't', 'a', 'b', 'a'],
    predicted_phonemes: ['k', 'a', 't', 'a', 'b'],
    candidate_errors: [{type: 'omission'}], acoustics: {duration_seconds: 1},
    reference_source: 'g2p_v0.1_conservative', reference_validation_status: 'g2p_provisional',
    classification_available: true,
    phoneme_classification: {
      status: 'candidate_only', reference_status: 'g2p_provisional', confirmed_child_error: false,
      analysis: {
        error_counts: {omission: 1, inversion: 2, insertion: 3, substitution: 4},
        errors: [{type: 'omission', reference_position: 5, reference_tokens: ['a'], observed_tokens: []}],
        type_ambiguous: false, standard_per: 0.2,
      },
    },
  };
}

function wav() {
  const data = Buffer.alloc(32044);
  data.write('RIFF'); data.writeUInt32LE(32036, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(32000, 40);
  for(let i=0;i<16000;i++)data.writeInt16LE(Math.round(7500*Math.sin(2*Math.PI*440*i/16000)),44+2*i);
  return data;
}

const test = base.extend({
  app: async ({page}, use) => {
    await page.addInitScript(()=>{window.__ACODYSLEX_TEST_SOURCE_UI__=true;});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const state = {
      payload: candidate(), status: 200, raw: null, requests: [], delay: null,
      entries: [1, 2].map(number => ({
        id: `00000000-0000-4000-8000-00000000000${number}`, learner_code: `test-${number}`,
        target_text: 'كَتَبَ', duration_seconds: 1, created_at: '2026-11-05T00:00:00Z',
      })),
    };
    await page.route('**/api/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      state.requests.push({path: url.pathname, method: request.method(), body: request.postData(), headers: request.headers()});
      if (url.pathname === '/api/config') return route.fulfill({json: {whisper_enabled: true, modal_ready: true}});
      if (url.pathname.endsWith('/analyze')) {
        const response = {status: state.status, body: state.raw ?? JSON.stringify(state.payload), contentType: 'application/json'};
        if (state.delay) await state.delay;
        return route.fulfill(response);
      }
      if (url.pathname === '/api/recordings' && request.method() === 'POST') {
        const entry = {...state.entries[0], id: '00000000-0000-4000-8000-000000000003'};
        state.entries.push(entry);
        return route.fulfill({status: 201, json: entry});
      }
      if (url.pathname === '/api/recordings') return route.fulfill({json: state.entries});
      if (url.pathname.endsWith('/audio')) return route.fulfill({body: wav(), contentType: 'audio/wav'});
      if (request.method() === 'DELETE') {
        state.entries = state.entries.filter(entry => !url.pathname.endsWith(entry.id));
        return route.fulfill({json: {status: 'deleted'}});
      }
      throw new Error(`Unexpected API request: ${request.method()} ${url.pathname}`);
    });
    await page.goto('/');
    await page.locator('#laboratory-nav-btn').click();
    await expect(page.getByRole('button', {name: 'Sélectionner'})).toHaveCount(2);
    await page.getByRole('button', {name: 'Sélectionner'}).first().click();
    await page.locator('#transfer-consent').check();
    await use(state);
    expect(errors).toEqual([]);
  },
});

async function analyze(page) {
  await page.locator('#analyze-btn').click();
  await expect(page.locator('#analyze-btn')).toBeEnabled();
}

test('successful analysis displays counts, provenance, details, historical output and JSON export', async ({page, app}) => {
  await analyze(page);
  await expect(page.locator('#results')).toBeVisible();
  await expect(page.locator('#empty-state')).toBeHidden();
  await expect(page.locator('#phonemeResult dd')).toHaveText(['1', '2', '3', '4']);
  await expect(page.locator('#phonemeResult')).toContainText('Référence G2P provisoire');
  await expect(page.locator('#phonemeResult')).toContainText('Hypothèse ASR — confirmation humaine nécessaire');
  await expect(page.locator('#phonemeResult')).toContainText('non validé sur un audio annoté humainement');
  await page.locator('#phonemeResult summary').click();
  await expect(page.locator('#phonemeResult pre')).toContainText('reference_position');
  await expect(page.locator('#predicted span')).toHaveText(app.payload.predicted_phonemes);
  await expect(page.locator('#errors')).toContainText('omission');
  await expect(page.locator('#acoustics')).toContainText('Durée');
  const request = app.requests.find(item => item.path.endsWith('/analyze'));
  expect(request.path).toBe(`/api/recordings/${app.entries[0].id}/analyze`);
  expect(request.headers['x-acodyslex-key']).toBeUndefined();
  expect(request.body).toContain('transfer_consent');
  const downloaded = page.waitForEvent('download');
  await page.locator('#export-json').click();
  const download = await downloaded;
  expect(JSON.parse(await fs.readFile(await download.path(), 'utf8'))).toEqual(app.payload);
});

test('ambiguous classification remains provisional', async ({page, app}) => {
  app.payload.phoneme_classification.analysis.type_ambiguous = true;
  await analyze(page);
  await expect(page.locator('#phonemeResult')).toContainText('Classification ambiguë / à réviser');
  await expect(page.locator('#phonemeResult dd')).toHaveCount(4);
});

test('manual reference stays unverified', async ({page, app}) => {
  app.payload.reference_source = 'manual';
  app.payload.reference_validation_status = 'provided_unverified';
  await analyze(page);
  await expect(page.locator('#phonemeResult')).toContainText('fournie manuellement, non validée humainement');
});

test('missing reference and warning are explicit', async ({page, app}) => {
  app.payload.reference_source = 'missing';
  app.payload.reference_validation_status = 'missing';
  app.payload.reference_warning = 'Mot non vocalisé.';
  app.payload.expected_phonemes = [];
  app.payload.phoneme_classification = {status: 'skipped_missing_reference'};
  await analyze(page);
  await expect(page.locator('#phonemeResult')).toContainText('Référence phonémique absente');
  await expect(page.locator('#phonemeResult')).toContainText('Mot non vocalisé.');
  await expect(page.locator('#phonemeResult dd')).toHaveCount(0);
  await expect(page.locator('#errors')).toContainText('comparaison désactivée');
});

for (const [status, reason] of Object.entries({
  skipped_missing_reference: 'référence phonémique absente',
  skipped_missing_observation: 'phonèmes reconnus absents',
  skipped_unsupported_tokens: 'phonèmes non pris en charge',
  future_status: 'statut non pris en charge',
})) {
  test(`${status} never displays error counts`, async ({page, app}) => {
    app.payload.phoneme_classification.status = status;
    await analyze(page);
    await expect(page.locator('#phonemeResult')).toContainText(reason);
    await expect(page.locator('#phonemeResult dd')).toHaveCount(0);
  });
}

test('omitted classification clears previous counts and never implies zero errors', async ({page, app}) => {
  await analyze(page);
  delete app.payload.phoneme_classification;
  app.payload.classification_available = false;
  app.payload.classification_note = 'Classification non fournie par Modal.';
  await analyze(page);
  await expect(page.locator('#phonemeResult')).toContainText('Classification indisponible');
  await expect(page.locator('#phonemeResult dd')).toHaveCount(0);
  await expect(page.locator('#predicted span')).toHaveCount(5);
});

for (const [name, mutate] of [
  ['missing count', data => delete data.analysis.error_counts.omission],
  ['negative count', data => data.analysis.error_counts.omission = -1],
  ['text count', data => data.analysis.error_counts.omission = '1'],
  ['fractional count', data => data.analysis.error_counts.omission = 0.5],
  ['missing analysis', data => delete data.analysis],
  ['invalid details', data => data.analysis.errors = 'bad'],
  ['invalid ambiguity', data => data.analysis.type_ambiguous = 'false'],
  ['contradictory confirmed error', data => data.confirmed_child_error = true],
]) {
  test(`malformed classification: ${name}`, async ({page, app}) => {
    mutate(app.payload.phoneme_classification);
    await analyze(page);
    await expect(page.locator('#phonemeResult')).toContainText('Classification indisponible');
    await expect(page.locator('#phonemeResult dd')).toHaveCount(0);
  });
}

test('explicit genuine zero counts may be displayed as candidates', async ({page, app}) => {
  app.payload.phoneme_classification.analysis.error_counts = {omission: 0, inversion: 0, insertion: 0, substitution: 0};
  app.payload.phoneme_classification.analysis.errors = [];
  await analyze(page);
  await expect(page.locator('#phonemeResult dd')).toHaveText(['0', '0', '0', '0']);
  await expect(page.locator('#phonemeResult')).toContainText('ne prouve pas une erreur de l’enfant');
});

for (const status of [401, 403, 502]) {
  test(`HTTP ${status} hides previous result and permits retry`, async ({page, app}) => {
    await analyze(page);
    app.status = status;
    app.payload = {detail: 'Échec simulé'};
    await analyze(page);
    await expect(page.locator('#alert')).toContainText(`HTTP ${status}`);
    await expect(page.locator('#results')).toBeHidden();
    await expect(page.locator('#phonemeResult')).toBeEmpty();
    expect(await page.evaluate(() => lastResult)).toBeNull();
  });
}

for (const [name, response] of [
  ['invalid JSON', '<html>bad gateway</html>'], ['null', 'null'], ['array', '[]'],
  ['empty object', '{}'], ['error status', '{"status":"error"}'],
  ['wrong phonemes', '{"status":"ok","predicted_phonemes":{}}'],
]) {
  test(`invalid analysis response: ${name}`, async ({page, app}) => {
    app.raw = response;
    await analyze(page);
    await expect(page.locator('#alert')).toContainText('Analyse impossible');
    await expect(page.locator('#results')).toBeHidden();
    await expect(page.locator('#phonemeResult dd')).toHaveCount(0);
  });
}

test('session change ignores an old in-flight response', async ({page, app}) => {
  let finish;
  app.delay = new Promise(resolve => { finish = resolve; });
  await page.locator('#analyze-btn').click();
  await expect.poll(() => app.requests.filter(item => item.path.endsWith('/analyze')).length).toBe(1);
  await page.getByRole('button', {name: 'Sélectionner'}).nth(1).click();
  const response = page.waitForResponse(res => res.url().endsWith('/analyze'));
  finish();
  await response;
  // Execute after the resolved request's continuation has had a chance to run.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('#selected-name')).toContainText('test-2');
  await expect(page.locator('#results')).toBeHidden();
  await expect(page.locator('#phonemeResult')).toBeEmpty();
  await expect(page.locator('#analyze-btn')).toHaveText("Analyser l'audio");
  app.delay = null;
  await analyze(page);
  await expect(page.locator('#results')).toBeVisible();
});

test('consent gates analysis and Whisper option is forwarded and displayed', async ({page, app}) => {
  await page.locator('#transfer-consent').uncheck();
  await page.locator('#analyze-btn').click();
  await expect(page.locator('#alert')).toContainText('autorisation de traitement distant');
  expect(app.requests.filter(item => item.path.endsWith('/analyze'))).toHaveLength(0);
  await page.locator('#transfer-consent').check();
  await page.locator('#whisper').check();
  app.payload.whisper_transcript = 'نص تجريبي';
  await analyze(page);
  await expect(page.locator('#whisper-result')).toBeVisible();
  await expect(page.locator('#whisper-text')).toHaveText('نص تجريبي');
  expect(app.requests.find(item => item.path.endsWith('/analyze')).body).toMatch(/name="use_whisper"\r\n\r\ntrue/);
});

test('remote strings are rendered as text, never HTML', async ({page, app}) => {
  const attack = '<img src=x onerror="window.injected=true">';
  app.payload.reference_warning = attack;
  app.payload.phoneme_classification.analysis.errors[0].reference_tokens = [attack];
  await analyze(page);
  await expect(page.locator('#phonemeResult')).toContainText(attack);
  await expect(page.locator('#phonemeResult img')).toHaveCount(0);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
});

test('WAV import, consent, save, playback selection and delete still work', async ({page, app}) => {
  await page.locator('#file-input').setInputFiles({name: 'synthetic.wav', mimeType: 'audio/wav', buffer: wav()});
  await expect(page.locator('#save-btn')).toBeEnabled();
  await page.locator('#save-btn').click();
  await expect(page.locator('#alert')).toContainText('autorisation de conservation');
  expect(app.requests.filter(item => item.method === 'POST')).toHaveLength(0);
  await page.locator('#save-consent').check();
  await page.locator('#save-btn').click();
  await expect(page.locator('.archive-entry')).toHaveCount(3);
  await expect(page.locator('#preview')).toHaveAttribute('src', `/api/recordings/${app.entries[2].id}/audio`);
  await expect(page.locator('#save-btn')).toBeDisabled();
  await page.getByRole('button', {name: 'Écouter', exact: true}).first().click();
  await expect(page.locator('#preview')).toHaveAttribute('src', `/api/recordings/${app.entries[0].id}/audio`);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('.archive-entry.active').getByRole('button', {name: 'Supprimer'}).click();
  await expect(page.locator('.archive-entry')).toHaveCount(2);
  await expect(page.locator('#analyze-btn')).toBeDisabled();
  await expect(page.locator('#results')).toBeHidden();
});

test('mobile classification fits viewport', async ({page, app}) => {
  await page.setViewportSize({width: 390, height: 844});
  await analyze(page);
  await expect(page.locator('#phonemeResult dd')).toHaveCount(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path: 'test-results/classification-mobile.png', fullPage: true});
});

test('playback rejection is visible instead of being silently ignored', async ({page, app}) => {
  await page.evaluate(() => {
    document.getElementById('preview').play = () => Promise.reject(new DOMException('Blocked', 'NotAllowedError'));
  });
  await page.locator('#replay-btn').click();
  await expect(page.locator('#alert')).toContainText('Le navigateur a bloqué la lecture');
  await page.getByRole('button', {name: 'Écouter', exact: true}).first().click();
  await expect(page.locator('#alert')).toContainText('Le navigateur a bloqué la lecture');
});

test('replay availability follows the selected or imported audio', async ({page, app}) => {
  await expect(page.locator('#replay-btn')).toBeEnabled();
  await page.evaluate(() => selectRecord(null));
  await expect(page.locator('#replay-btn')).toBeDisabled();
  await page.locator('#file-input').setInputFiles({name: 'synthetic.wav', mimeType: 'audio/wav', buffer: wav()});
  await expect(page.locator('#replay-btn')).toBeEnabled();
});

// No /api mocks here: exercise browser -> FastAPI -> mocked Modal -> browser.
base('full local flow with real storage and proxy, simulated acoustics', async ({page}) => {
  await page.addInitScript(()=>{window.__ACODYSLEX_TEST_SOURCE_UI__=true;});
  await page.goto('/');
  await page.locator('#laboratory-nav-btn').click();
  await page.locator('#target').fill('كَتَبَ');
  await page.locator('#file-input').setInputFiles({name: 'synthetic.wav', mimeType: 'audio/wav', buffer: wav()});
  await page.locator('#save-consent').check();
  await page.locator('#save-btn').click();
  await expect(page.locator('.archive-entry')).toHaveCount(1);
  await page.locator('#transfer-consent').check();
  await analyze(page);
  await expect(page.locator('#phonemeResult dd')).toHaveText(['0', '0', '0', '1']);
  await expect(page.locator('#phonemeResult')).toContainText('Référence G2P provisoire');
  await expect(page.locator('#model-name')).toContainText('SIMULATION');
  await expect(page.locator('#predicted span')).toHaveText(['k', 'a', 'd', 'a', 'b', 'a']);
  const audioUrl = await page.locator('#preview').getAttribute('src');
  const audio = await page.request.get(audioUrl);
  expect(await audio.body()).toEqual(wav());
  await page.screenshot({path: 'test-results/classification-desktop.png', fullPage: true});
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', {name: 'Supprimer'}).click();
  await expect(page.locator('.archive-entry')).toHaveCount(0);
  await expect(page.locator('#results')).toBeHidden();
  expect((await page.request.get(audioUrl)).status()).toBe(404);
});
