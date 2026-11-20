const {test, expect} = require('@playwright/test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test.beforeEach(async ({page}) => { await page.addInitScript(()=>{window.__ACODYSLEX_TEST_SOURCE_UI__=true;}); });

function toneWav(amplitude=8000) {
  const rate = 48000, frames = rate * 8;
  const data = Buffer.alloc(44 + frames * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36);
  data.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(amplitude * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
  return data;
}

// Capture a known audible signal via Chromium's virtual microphone, never the real mic.
for (const scenario of [
  {name: 'audible microphone survives conversion, playback and archive', amplitude: 16000},
  {name: 'soft microphone voice is boosted and can be saved', amplitude: 500, minMeter: 20, minRms: 0.003, minPeak: 0.01, minPlaybackPeak: 0.01},
  {name: 'silent microphone is blocked from saving', amplitude: 0, warning: 'WAV silencieux ou quasi silencieux'},
  {name: 'near-silent microphone remains blocked after voice boost', amplitude: 10, warning: 'WAV silencieux ou quasi silencieux'},
].filter(scenario=>process.env.ACODYSLEX_COMPARE_AUDIO_BACKUP!=='1'||!scenario.warning)) {
test(scenario.name, async ({playwright}) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acodyslex-tone-'));
  const tonePath = path.join(directory, 'tone.wav');
  await fs.writeFile(tonePath, toneWav(scenario.amplitude));
  const browser = await playwright.chromium.launch({headless: true,
    ...(process.env.ACODYSLEX_CHROMIUM ? {executablePath: process.env.ACODYSLEX_CHROMIUM} : {}),
    args: [
    ...(process.env.ACODYSLEX_CHROMIUM ? ['--no-sandbox'] : []),
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${tonePath}`,
  ]});
  try {
    const page = await browser.newPage({baseURL: 'http://127.0.0.1:8765', permissions: ['microphone']});
    await page.addInitScript(() => {
      window.__ACODYSLEX_TEST_SOURCE_UI__=true;
      const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      window.testCaptureCalls=[];
      navigator.mediaDevices.getUserMedia=async constraints=>{
        window.testCaptureCalls.push(constraints);
        const stream=await original(constraints);
        window.testInputStream=stream;
        return stream;
      };
    });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    let entries = [], savedWav = null;
    await page.route('**/api/**', async route => {
      const request = route.request(), pathname = new URL(request.url()).pathname;
      if (pathname === '/api/config') return route.fulfill({json: {modal_ready: false, whisper_enabled: false}});
      if (pathname === '/api/acoustic-model') return route.fulfill({json: {metadata_verified: false, model: {}, infrastructure: {}}});
      if (pathname.endsWith('/audio')) return route.fulfill({body: savedWav, contentType: 'audio/wav'});
      if (pathname === '/api/recordings' && request.method() === 'POST') {
        const form = await new Request('http://localhost', {
          method: 'POST', headers: request.headers(), body: request.postDataBuffer(),
        }).formData();
        savedWav = Buffer.from(await form.get('file').arrayBuffer());
        entries = [{id: '00000000-0000-4000-8000-000000000001', learner_code: 'synthetic-tone', target_text: 'كَتَبَ', duration_seconds: 2, created_at: '2026-11-05T00:00:00Z'}];
        return route.fulfill({status: 201, json: entries[0]});
      }
      if (pathname === '/api/recordings') return route.fulfill({json: entries});
      throw new Error(`Unexpected request: ${pathname}`);
    });
    if (process.env.ACODYSLEX_COMPARE_AUDIO_BACKUP === '1') {
      const oldScript = await fs.readFile(path.resolve('.codex-backups/20261105T185736Z-classification/static/app.js'), 'utf8');
      await page.route('**/static/app.js', route => route.fulfill({body: oldScript, contentType: 'text/javascript'}));
    }
    await page.goto('/');
    await page.locator('#laboratory-nav-btn').click();
    let selectedDevice;
    if(process.env.ACODYSLEX_COMPARE_AUDIO_BACKUP!=='1'){
      await expect.poll(()=>page.locator('#microphone-select option').count()).toBeGreaterThan(1);
      selectedDevice=await page.locator('#microphone-select option').last().getAttribute('value');
      await page.locator('#microphone-select').selectOption(selectedDevice);
    }
    await page.locator('#start-btn').click();
    await expect(page.locator('#timer')).toHaveText('00:02', {timeout: 8000});
    if(process.env.ACODYSLEX_COMPARE_AUDIO_BACKUP!=='1'){
      await expect(page.locator('#microphone-select')).toBeDisabled();
      expect(await page.evaluate(()=>window.testCaptureCalls[0].audio.deviceId)).toEqual({exact:selectedDevice});
      if(!scenario.warning){
        await expect.poll(()=>page.locator('#microphone-meter').evaluate(meter=>meter.value)).toBeGreaterThan(scenario.minMeter||40);
        await expect(page.locator('#microphone-status')).toContainText('signal PCM reçu');
      }
    }
    await page.locator('#stop-btn').click();
    await expect(page.locator('#alert')).toContainText(scenario.warning||'Enregistrement PCM terminé');
    if(process.env.ACODYSLEX_COMPARE_AUDIO_BACKUP!=='1'){
      await expect(page.locator('#microphone-select')).toBeEnabled();
      expect(await page.evaluate(()=>window.testInputStream.getTracks().every(track=>track.readyState==='ended'))).toBe(true);
      expect(await page.evaluate(()=>microphoneMonitor)).toBeNull();
    }
    const captured = await page.evaluate(async () => {
      const bytes = await wavBlob.arrayBuffer(), view = new DataView(bytes);
      let squares = 0, peak = 0;
      for (let i = 44; i < bytes.byteLength; i += 2) {
        const sample = view.getInt16(i, true) / 32768;
        squares += sample * sample; peak = Math.max(peak, Math.abs(sample));
      }
      return {rms: Math.sqrt(squares / ((bytes.byteLength - 44) / 2)), peak,
        rate: view.getUint32(24, true), channels: view.getUint16(22, true), bits: view.getUint16(34, true),
        bytes: [...new Uint8Array(bytes)]};
    });
    expect(captured.rate).toBe(16000); expect(captured.channels).toBe(1); expect(captured.bits).toBe(16);
    if(scenario.warning){
      expect(captured.rms).toBeLessThan(0.003);
      if(scenario.amplitude===0)expect(captured.peak).toBe(0);
      await expect(page.locator('#download-btn')).toBeEnabled();
      if(scenario.amplitude===0 || scenario.amplitude===10){
        await expect(page.locator('#save-btn')).toBeDisabled();
        await page.evaluate(()=>saveRecord());
        await expect(page.locator('#alert')).toContainText('Sauvegarde refusée');
        expect(savedWav).toBeNull();
      }
      expect(pageErrors).toEqual([]);
      return;
    }
    expect(captured.rms).toBeGreaterThan(scenario.minRms||0.10); expect(captured.peak).toBeGreaterThan(scenario.minPeak||0.18);

    // Measure the rendered audio stream, not just elapsed time or nonempty WAV bytes.
    async function measurePlayback() {
      return page.evaluate(async () => {
        const player = document.getElementById('preview');
        if (!window.testPlayback) {
          const context = new AudioContext(), analyser = context.createAnalyser();
          context.createMediaElementSource(player).connect(analyser);
          analyser.connect(context.destination);
          window.testPlayback = {context, analyser};
        }
        const {context, analyser} = window.testPlayback;
        await context.resume();
        player.currentTime = 0;
        await player.play();
        const samples = new Float32Array(analyser.fftSize);
        let peak = 0;
        for (let tick = 0; tick < 20; tick++) {
          await new Promise(resolve => setTimeout(resolve, 25));
          analyser.getFloatTimeDomainData(samples);
          for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
        }
        player.pause();
        return {peak, muted: player.muted, volume: player.volume, error: player.error?.code};
      });
    }
    if (process.env.ACODYSLEX_COMPARE_AUDIO_BACKUP !== '1') {
      await page.evaluate(() => {const player=document.getElementById('preview');player.muted=true;player.volume=0;});
      await page.locator('#replay-btn').click();
    }
    const localPlayback = await measurePlayback();
    expect(localPlayback.muted).toBe(false); expect(localPlayback.volume).toBeGreaterThan(0);
    expect(localPlayback.peak).toBeGreaterThan(scenario.minPlaybackPeak||0.18); expect(localPlayback.error).toBeUndefined();
    await page.locator('#save-consent').check();
    await page.locator('#save-btn').click();
    await expect(page.locator('.archive-entry')).toHaveCount(1);
    expect(savedWav).toEqual(Buffer.from(captured.bytes));
    if (process.env.ACODYSLEX_COMPARE_AUDIO_BACKUP !== '1') {
      await page.evaluate(() => {const player=document.getElementById('preview');player.muted=true;player.volume=0;});
    }
    await page.getByRole('button', {name: 'Écouter', exact: true}).click();
    const archivePlayback = await measurePlayback();
    expect(archivePlayback.peak).toBeGreaterThan(scenario.minPlaybackPeak||0.18);
    expect(archivePlayback.muted).toBe(false); expect(archivePlayback.volume).toBeGreaterThan(0);
    expect(pageErrors).toEqual([]);
    console.log(`Audible capture: rms=${captured.rms.toFixed(3)}, local peak=${localPlayback.peak.toFixed(3)}, archive peak=${archivePlayback.peak.toFixed(3)}`);
  } finally {
    await browser.close();
    await fs.rm(directory, {recursive: true, force: true});
  }
});
}

test('continuous reading segments reuse one authorized microphone stream until release', async ({playwright}) => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'acodyslex-continuous-'));
  const tonePath=path.join(directory,'tone.wav');
  await fs.writeFile(tonePath,toneWav(14000));
  const browser=await playwright.chromium.launch({headless:true,
    ...(process.env.ACODYSLEX_CHROMIUM?{executablePath:process.env.ACODYSLEX_CHROMIUM}:{}),
    args:[...(process.env.ACODYSLEX_CHROMIUM?['--no-sandbox']:[]),'--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',`--use-file-for-fake-audio-capture=${tonePath}`],
  });
  try{
    const page=await browser.newPage({baseURL:'http://127.0.0.1:8765',permissions:['microphone']});
    await page.addInitScript(()=>{
      window.__ACODYSLEX_TEST_SOURCE_UI__=true;
      const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      window.testCaptureCalls=0;
      navigator.mediaDevices.getUserMedia=async constraints=>{window.testCaptureCalls++;return original(constraints);};
    });
    await page.route('**/api/config',route=>route.fulfill({json:{modal_ready:false,whisper_enabled:false}}));
    await page.route('**/api/recordings',route=>route.fulfill({json:[]}));
    await page.goto('/');
    await page.evaluate(()=>window.acodyslexLegacyAudio.start({keepStream:true}));
    await page.waitForFunction(()=>window.acodyslexLegacyAudio.getLiveSamples()?.length>0);
    const first=await page.evaluate(async()=>{const blob=await window.acodyslexLegacyAudio.stopAndGetBlob({keepStream:true});return {size:blob?.size||0,live:window.acodyslexLegacyAudio.hasLiveStream()};});
    await page.evaluate(()=>window.acodyslexLegacyAudio.start({keepStream:true}));
    await page.waitForFunction(()=>window.acodyslexLegacyAudio.getLiveSamples()?.length>0);
    const second=await page.evaluate(async()=>{const blob=await window.acodyslexLegacyAudio.stopAndGetBlob({keepStream:true});return {size:blob?.size||0,live:window.acodyslexLegacyAudio.hasLiveStream()};});
    const result=await page.evaluate(async()=>{await window.acodyslexLegacyAudio.release();return {calls:window.testCaptureCalls,liveAfterRelease:window.acodyslexLegacyAudio.hasLiveStream(),captureClosed:pcmCapture===null,meterClosed:microphoneMonitor===null};});
    expect(result).toMatchObject({calls:1,liveAfterRelease:false,captureClosed:true,meterClosed:true});
    expect(first.live).toBe(true);expect(second.live).toBe(true);
    expect(first.size).toBeGreaterThan(44); expect(second.size).toBeGreaterThan(44);
  }finally{
    await browser.close();
    await fs.rm(directory,{recursive:true,force:true});
  }
});

test('microphone permission failure restores capture controls without losing the previous audio', async ({page}) => {
  test.skip(process.env.ACODYSLEX_COMPARE_AUDIO_BACKUP==='1','The backup comparison covers the audible capture path only.');
  await page.route('**/api/config', route=>route.fulfill({json:{whisper_enabled:false,modal_ready:false}}));
  await page.route('**/api/recordings', route=>route.fulfill({json:[]}));
  await page.addInitScript(()=>{
    navigator.mediaDevices.getUserMedia=()=>Promise.reject(new DOMException('Denied','NotAllowedError'));
  });
  await page.goto('/');
  await page.locator('#laboratory-nav-btn').click();
  await page.locator('#file-input').setInputFiles({name:'tone.wav',mimeType:'audio/wav',buffer:toneWav()});
  await expect(page.locator('#preview')).toHaveAttribute('src', /blob:/);
  const previous=await page.locator('#preview').getAttribute('src');
  await page.locator('#start-btn').click();
  await expect(page.locator('#alert')).toContainText('Accès au microphone refusé');
  await expect(page.locator('#start-btn')).toBeEnabled();
  await expect(page.locator('#microphone-select')).toBeEnabled();
  await expect(page.locator('#preview')).toHaveAttribute('src',previous);
  await expect(page.locator('#save-btn')).toBeEnabled();
});

test('silenced WAV import is diagnosable but cannot be saved', async ({page}) => {
  await page.route('**/api/config',route=>route.fulfill({json:{modal_ready:false,whisper_enabled:false}}));
  await page.route('**/api/recordings',route=>route.fulfill({json:[]}));
  await page.goto('/');
  await page.locator('#laboratory-nav-btn').click();
  await page.locator('#file-input').setInputFiles({name:'empty.wav',mimeType:'audio/wav',buffer:toneWav(0)});
  await expect(page.locator('#alert')).toContainText('silencieux');
  await expect(page.locator('#save-btn')).toBeDisabled();
  await expect(page.locator('#download-btn')).toBeEnabled();
});

test('a distant low-level WAV is rejected before it can be saved', async ({page}) => {
  await page.route('**/api/config',route=>route.fulfill({json:{modal_ready:false,whisper_enabled:false}}));
  await page.route('**/api/recordings',route=>route.fulfill({json:[]}));
  await page.goto('/');
  await page.locator('#laboratory-nav-btn').click();
  await page.locator('#file-input').setInputFiles({name:'distant.wav',mimeType:'audio/wav',buffer:toneWav(1500)});
  await expect(page.locator('#alert')).toContainText('Voix trop faible ou trop éloignée');
  await expect(page.locator('#save-btn')).toBeDisabled();
});
