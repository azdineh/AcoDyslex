'use strict';
const $ = (id) => document.getElementById(id);
const formatNumber = (value, options) => window.acodyslexI18n?.formatNumber?.(value, options) ?? String(value);
const formatDate = value => window.acodyslexI18n?.formatDate?.(value) ?? new Date(value).toLocaleString('en-US');
let stream = null, pcmCapture = null, clock = null, begun = 0;
let wavBlob = null, previewUrl = null, currentId = null, lastResult = null, entries = [];
let analysisRequest = 0;
let captureBusy = false, microphoneMonitor = null, captureKeepsStream = false;
let lastCaptureDiagnostic = 'Aucun enregistrement effectué.';
let audioSaveAllowed = false;
// Keep rejecting silence, but accept a softly spoken yet audible reading.
// The capture graph below supplies a modest +6 dB boost before PCM is stored.
const MIN_AUDIO_RMS = 0.003, MIN_AUDIO_PEAK = 0.01;
const MIN_VOICED_FRAME_RMS = 0.005, MIN_VOICED_FRAME_RATIO = 0.03;
const VOICE_CAPTURE_GAIN = 2;
function audioIsUsable(signal) {
  return !audioQualityMessage(signal);
}
function audioQualityMessage(signal) {
  if(!signal || signal.rms < MIN_AUDIO_RMS || signal.peak < MIN_AUDIO_PEAK)return 'WAV silencieux ou quasi silencieux : aucune voix captée.';
  if(Number.isFinite(signal.voicedFrameRatio) && signal.voicedFrameRatio < MIN_VOICED_FRAME_RATIO)return 'Voix insuffisamment détectée dans l\'enregistrement.';
  return '';
}

function status(message, type='info') {
  const el = $('alert'); el.textContent = message; el.className = `alert show ${type}`;
}
function elapsed(s) { return `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(Math.floor(s % 60)).padStart(2,'0')}`; }
function setAudio(blob, filename, signal) {
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  wavBlob = blob; audioSaveAllowed = audioIsUsable(signal);
  previewUrl = URL.createObjectURL(blob);
  $('preview').src = previewUrl; $('preview').hidden = false;
  $('replay-btn').disabled = false;
  $('audio-details').textContent = `${filename} · ${formatNumber(blob.size/1024,{minimumFractionDigits:1,maximumFractionDigits:1})} Ko`;
  $('save-btn').disabled = !audioSaveAllowed; $('download-btn').disabled = false;
}

// Single source of truth: live meter and WAV use the very same captured PCM blocks.
function downsampleSamples(mono, sourceRate, outRate=16000) {
  if(!mono?.length || !Number.isFinite(sourceRate) || sourceRate<=0)throw new Error('Signal PCM invalide.');
  const outputLength = Math.floor(mono.length*outRate/sourceRate);
  if(outputLength<1)throw new Error('Signal PCM trop court.');
  const result = new Float32Array(outputLength);
  if(sourceRate===outRate){result.set(mono.subarray(0,outputLength));return result;}
  if(sourceRate < outRate){
    for(let i=0;i<outputLength;i++){
      const location=i*sourceRate/outRate, a=Math.floor(location), b=Math.min(a+1,mono.length-1), f=location-a;
      result[i]=mono[a]*(1-f)+mono[b]*f;
    }
  } else {
    const ratio=sourceRate/outRate;
    for(let i=0;i<outputLength;i++){
      const start=Math.floor(i*ratio), end=Math.min(mono.length,Math.max(start+1,Math.floor((i+1)*ratio)));
      let sum=0;for(let j=start;j<end;j++)sum+=mono[j];
      result[i]=sum/(end-start);
    }
  }
  return result;
}
function downsample(buffer, outRate=16000) {
  const mono=new Float32Array(buffer.length);
  for(let channel=0;channel<buffer.numberOfChannels;channel++){
    const data=buffer.getChannelData(channel);
    for(let i=0;i<mono.length;i++)mono[i]+=data[i]/buffer.numberOfChannels;
  }
  return downsampleSamples(mono,buffer.sampleRate,outRate);
}
function encodeWav(samples) {
  const arrayBuffer = new ArrayBuffer(44 + samples.length*2), view = new DataView(arrayBuffer);
  function word(offset, str) { for(let i=0;i<str.length;i++) view.setUint8(offset+i,str.charCodeAt(i)); }
  word(0,'RIFF'); view.setUint32(4,36+samples.length*2,true); word(8,'WAVE'); word(12,'fmt ');
  view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true);
  view.setUint32(24,16000,true); view.setUint32(28,32000,true); view.setUint16(32,2,true);
  view.setUint16(34,16,true); word(36,'data'); view.setUint32(40,samples.length*2,true);
  for(let i=0;i<samples.length;i++) {
    const sample=Math.max(-1,Math.min(1,samples[i]));
    view.setInt16(44 + i*2, sample<0?sample*0x8000:sample*0x7fff, true);
  }
  return new Blob([arrayBuffer],{type:'audio/wav'});
}


function measureSignal(samples) {
  let sum=0, squares=0, peak=0;
  for(const sample of samples){sum+=sample;squares+=sample*sample;}
  const mean=sum/Math.max(samples.length,1);
  for(const sample of samples)peak=Math.max(peak,Math.abs(sample-mean));
  // AC level: a constant DC offset is not audible speech.
  const rms=Math.sqrt(Math.max(0,squares/Math.max(samples.length,1)-mean*mean));
  return {rms,peak,db:rms>0?20*Math.log10(rms):-Infinity};
}
function measureRecordingQuality(samples, sampleRate=16000) {
  const signal=measureSignal(samples), frameSize=Math.max(1,Math.round(sampleRate*.02));
  let frames=0, voiced=0;
  for(let start=0;start<samples.length;start+=frameSize){
    const frame=samples.subarray(start,Math.min(samples.length,start+frameSize));
    if(frame.length<frameSize/2)continue;
    frames++;
    if(measureSignal(frame).rms>=MIN_VOICED_FRAME_RMS)voiced++;
  }
  return {...signal,voicedFrameRatio:frames?voiced/frames:0};
}
async function refreshMicrophones(activeId) {
  if(!navigator.mediaDevices?.enumerateDevices)return;
  try{
    const devices=await navigator.mediaDevices.enumerateDevices();
    const select=$('microphone-select'), selected=activeId||select.value;
    select.replaceChildren(new Option('Microphone par défaut',''));
    for(const device of devices.filter(device=>device.kind==='audioinput' && device.deviceId)){
      select.append(new Option(device.label||`Microphone ${select.options.length}`,device.deviceId));
    }
    if(selected && ![...select.options].some(option=>option.value===selected)){
      select.append(new Option('Microphone indisponible — choisissez une autre entrée',selected));
    }
    select.value=selected;
  }catch{
    // Enumeration can be restricted before permission; default capture remains available.
  }
}
function setCaptureBusy(busy) {
  captureBusy=busy;
  $('start-btn').disabled=busy;
  $('microphone-select').disabled=busy;
  $('file-input').disabled=busy;
  $('save-btn').disabled=busy||!wavBlob||!audioSaveAllowed;
  $('download-btn').disabled=busy||!wavBlob;
  $('replay-btn').disabled=busy||!$('preview').getAttribute('src');
}
function appendCapturedSamples(capture, data){
  if(!capture || !capture.accepting || !data?.length)return;
  const maxSamples=Math.ceil(capture.context.sampleRate*20);
  if(capture.samplesCount>=maxSamples)return;
  const samples=data.length>maxSamples-capture.samplesCount?data.slice(0,maxSamples-capture.samplesCount):data;
  capture.chunks.push(samples);
  capture.samplesCount+=samples.length;
  capture.latestSamples=samples;
  // Display the levels measured from the captured data, not from a separate analyser.
  capture.latestSignal=measureSignal(samples);
  capture.highestRms=Math.max(capture.highestRms,capture.latestSignal.rms);
  capture.highestPeak=Math.max(capture.highestPeak,capture.latestSignal.peak);
}
function showMicDiagnostic(text){
  lastCaptureDiagnostic=text;
  const node=$('mic-diagnostics-text');if(node)node.textContent=text;
}
function updateMicrophoneLevel(capture){
  if(microphoneMonitor!==capture)return;
  const signal=capture.latestSignal;
  const track=capture.track;
  $('microphone-meter').value=signal?Math.max(0,Math.min(100,(signal.db+60)/60*100)):0;
  const label=track.label||'Microphone sélectionné';
  let message;
  if(track.readyState!=='live')message=`${label} : piste déconnectée.`;
  else if(track.muted || !track.enabled)message=`${label} : piste muette ou désactivée.`;
  else if(capture.context.state!=='running')message=`${label} : moteur audio suspendu (${capture.context.state}).`;
  else if(!signal || signal.db < -60)message=`${label} : aucun signal PCM reçu. Vérifiez le microphone dans Windows et Chrome.`;
  else if(signal.db < -45)message=`${label} : signal très faible (${formatNumber(signal.db,{minimumFractionDigits:1,maximumFractionDigits:1})} dBFS).`;
  else message=`${label} : signal PCM reçu (${formatNumber(signal.db,{minimumFractionDigits:1,maximumFractionDigits:1})} dBFS).`;
  if($('microphone-status').textContent!==message)$('microphone-status').textContent=message;
  capture.frame=requestAnimationFrame(()=>updateMicrophoneLevel(capture));
}
async function stopMicrophoneMonitor() {
  const capture=microphoneMonitor;
  microphoneMonitor=null;
  if(capture?.frame)cancelAnimationFrame(capture.frame);
  $('microphone-meter').value=0;
}
async function startPcmCapture(inputStream){
  const context=new (window.AudioContext||window.webkitAudioContext)();
  const capture={context,source:null,filter:null,boost:null,compressor:null,node:null,sink:null,track:inputStream.getAudioTracks()[0],
    chunks:[],samplesCount:0,latestSignal:null,highestRms:0,highestPeak:0,
    accepting:true,flushResolve:null,frame:null,method:null};
  try{
    const source=context.createMediaStreamSource(inputStream);
    capture.source=source;
    const sink=context.createGain();sink.gain.value=0;capture.sink=sink;
    // Worklet processes float PCM; never route microphone sound to speakers.
    if(context.audioWorklet && window.AudioWorkletNode){
      try{
        await context.audioWorklet.addModule('/static/pcm-processor.js');
        const node=new AudioWorkletNode(context,'acodyslex-pcm-capture',{
          numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]
        });
        capture.node=node;capture.method='AudioWorklet PCM direct';
        node.port.onmessage=(event)=>{
          if(event.data?.type==='samples')appendCapturedSamples(capture,new Float32Array(event.data.samples));
          if(event.data?.type==='flushed')capture.flushResolve?.();
        };
      }catch(err){
        // ScriptProcessor is deprecated, but preserves direct PCM capture on old/limited browsers.
        if(capture.node){capture.node.disconnect();capture.node.port.close();capture.node=null;}
        capture.workletError=String(err?.message||err);
      }
    }
    if(!capture.node){
      if(typeof context.createScriptProcessor!=='function')throw new Error('Capture PCM non prise en charge par ce navigateur.');
      const node=context.createScriptProcessor(2048,1,1);
      node.onaudioprocess=(event)=>{
        event.outputBuffer.getChannelData(0).fill(0);
        appendCapturedSamples(capture,new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      capture.node=node;capture.method='ScriptProcessor PCM direct (secours)';
    }
    const filter=context.createBiquadFilter();
    filter.type='highpass';filter.frequency.value=100;filter.Q.value=.707;
    capture.filter=filter;
    // Raise quiet speech before it reaches both the meter and the saved WAV.
    // A compressor protects normal or loud speech from digital clipping.
    const boost=context.createGain();boost.gain.value=VOICE_CAPTURE_GAIN;capture.boost=boost;
    const compressor=context.createDynamicsCompressor();
    compressor.threshold.value=-8;compressor.knee.value=6;compressor.ratio.value=4;
    compressor.attack.value=.003;compressor.release.value=.25;capture.compressor=compressor;
    source.connect(filter);filter.connect(boost);boost.connect(compressor);compressor.connect(capture.node);
    capture.node.connect(sink);
    sink.connect(context.destination);
    await context.resume();
    if(context.state!=='running')throw new Error(`Moteur audio non actif : ${context.state}.`);
    microphoneMonitor=capture;
    capture.frame=requestAnimationFrame(()=>updateMicrophoneLevel(capture));
    return capture;
  }catch(error){
    capture.accepting=false;
    try{capture.node?.disconnect();}catch{}
    try{sourceCleanup(capture);}catch{}
    await context.close().catch(()=>{});
    throw error;
  }
}
function sourceCleanup(capture){
  if(!capture)return;
  try{capture.node?.disconnect();}catch{}
  if('onaudioprocess' in (capture.node||{}))capture.node.onaudioprocess=null;
  if(capture.node?.port)capture.node.port.close();
  try{capture.source?.disconnect();}catch{}
  try{capture.filter?.disconnect();}catch{}
  try{capture.boost?.disconnect();}catch{}
  try{capture.compressor?.disconnect();}catch{}
  try{capture.sink?.disconnect();}catch{}
}
async function flushPcmCapture(capture){
  if(!capture?.node?.port)return;
  // Messages from a single worklet port are ordered: the final partial PCM block
  // arrives before "flushed". A short timeout also handles a crashed/suspended worklet.
  await new Promise(resolve=>{
    const timer=setTimeout(()=>{capture.flushResolve=null;resolve();},750);
    capture.flushResolve=()=>{clearTimeout(timer);capture.flushResolve=null;resolve();};
    capture.node.port.postMessage({type:'flush'});
  });
}
async function finalizePcmCapture(capture){
  await flushPcmCapture(capture);
  capture.accepting=false;
  const merged=new Float32Array(capture.samplesCount);
  let offset=0;
  for(const chunk of capture.chunks){merged.set(chunk,offset);offset+=chunk.length;}
  return merged;
}
function captureDiagnostics(capture, signal, seconds, stoppedTrackState){
  const t=capture?.track, opts=t?.getSettings?.()||{};
  const db=signal?.db===-Infinity?'−∞':Number.isFinite(signal?.db)?formatNumber(signal.db,{minimumFractionDigits:1,maximumFractionDigits:1}):'indéfini';
  return [
    `Source : ${t?.label||'Non déterminée'}`,
    `Méthode : ${capture?.method||'Non démarrée'}`,
    `Piste (avant arrêt) : ${stoppedTrackState||'inconnue'}`,
    `Contexte audio : ${capture?.context.state||'indéfini'}`,
    `Fréquence source : ${capture?.context.sampleRate||'indéfinie'} Hz`,
    `Réglages : sampleRate=${opts.sampleRate??'auto'}, channelCount=${opts.channelCount??'auto'}`,
    `Échantillons capturés : ${formatNumber(capture?.samplesCount||0)} (${formatNumber(seconds,{minimumFractionDigits:2,maximumFractionDigits:2})} s)`,
    `RMS du WAV : ${Number.isFinite(signal?.rms)?formatNumber(signal.rms,{minimumFractionDigits:6,maximumFractionDigits:6}):'indéfini'} (${db} dBFS)`,
    `Crête du WAV : ${Number.isFinite(signal?.peak)?formatNumber(signal.peak,{minimumFractionDigits:6,maximumFractionDigits:6}):'indéfini'}`,
    `RMS maximal instantané : ${Number.isFinite(capture?.highestRms)?formatNumber(capture.highestRms,{minimumFractionDigits:6,maximumFractionDigits:6}):'indéfini'}`,
    `Crête instantanée maximale : ${Number.isFinite(capture?.highestPeak)?formatNumber(capture.highestPeak,{minimumFractionDigits:6,maximumFractionDigits:6}):'indéfini'}`,
    capture?.workletError?`Worklet non utilisé : ${capture.workletError}`:''
  ].filter(Boolean).join('\n');
}
async function inspectRecordedSignal(blob) {
  const ctx = new (window.AudioContext||window.webkitAudioContext)();
  try {
    const decoded=await ctx.decodeAudioData(await blob.arrayBuffer());
    return measureRecordingQuality(downsample(decoded));
  } finally { await ctx.close(); }
}
async function recordStopped(keepStream=captureKeepsStream) {
  if(captureBusy)return;
  // Prevent double clicks and keep the microphone alive until PCM is drained.
  setCaptureBusy(true);
  clearInterval(clock);clock=null;
  $('stop-btn').disabled=true;
  $('timer').classList.remove('recording');
  const capture=pcmCapture;
  const state=capture?.track?`readyState=${capture.track.readyState}, muted=${capture.track.muted}, enabled=${capture.track.enabled}`:'sans piste';
  try{
    if(!capture)throw new Error('Capture PCM absente.');
    status('Finalisation de la capture PCM directe…');
    const merged=await finalizePcmCapture(capture);
    if(!merged.length)throw new Error('Aucun échantillon reçu. Vérifiez l’autorisation du micro, la source sélectionnée et le niveau Windows.');
    const seconds=merged.length/capture.context.sampleRate;
    const samples=downsampleSamples(merged,capture.context.sampleRate);
    const signal=measureRecordingQuality(samples);
    const wav=encodeWav(samples);
    showMicDiagnostic(captureDiagnostics(capture,signal,seconds,state));
    if(wav.size>1000000)throw new Error('WAV trop volumineux.');
    setAudio(wav,'lecture.wav',signal);
    const liveHadSignal=capture.highestRms>=MIN_AUDIO_RMS && capture.highestPeak>=MIN_AUDIO_PEAK;
    const qualityIssue=audioQualityMessage(signal);
    if(qualityIssue){
      $('microphone-status').textContent=liveHadSignal
        ? qualityIssue
        : 'Aucun signal PCM suffisant ne vient du microphone. Vérifiez la source et le niveau d’entrée Windows.';
      status(`${qualityIssue} Sauvegarde bloquée. Rapprochez-vous du microphone puis recommencez.`,'err');
    }else if(signal.db < -45){
      $('microphone-status').textContent='PCM capturé, mais niveau sonore faible.';
      status('Signal PCM très faible. Vérifiez la source et réécoutez le WAV.');
    }else{
      $('microphone-status').textContent='Signal PCM présent dans le fichier WAV.';
      status('Enregistrement PCM terminé : réécoutez puis sauvegardez.','ok');
    }
  }catch(err){
    $('microphone-status').textContent='Capture interrompue ou impossible.';
    showMicDiagnostic(captureDiagnostics(capture,null,(capture?.samplesCount||0)/(capture?.context.sampleRate||1),state)+`\nErreur : ${err.message}`);
    status(`Enregistrement impossible : ${err.message}`,'err');
  }finally{
    await stopMicrophoneMonitor();
    if(capture){capture.accepting=false;sourceCleanup(capture);await capture.context.close().catch(()=>{});}
    pcmCapture=null;captureKeepsStream=false;
    if(!keepStream){stream?.getTracks().forEach(track=>track.stop());stream=null;}
    setCaptureBusy(false);
  }
}
async function startRecord(options={}){
  if(captureBusy || pcmCapture)return;
  if(!navigator.mediaDevices?.getUserMedia || !(window.AudioContext||window.webkitAudioContext)){
    status('Capture audio indisponible : utilisez Chrome ou Edge via http://localhost:8000.','err');return;
  }
  setCaptureBusy(true);
  $('preview').pause();
  $('microphone-status').textContent='Ouverture du microphone…';
  showMicDiagnostic('Demande de capture en cours…');
  try{
    const keepStream=!!options?.keepStream,deviceId=$('microphone-select').value;
    // Reuse the already-authorized live track between reading words.
    const reusable=stream?.getAudioTracks?.().some(track=>track.readyState==='live');
    if(!reusable){
      stream?.getTracks().forEach(track=>track.stop());
      const audio={echoCancellation:{ideal:true},noiseSuppression:{ideal:true},autoGainControl:{ideal:true},channelCount:{ideal:1}};if(deviceId)audio.deviceId={exact:deviceId};
      stream=await navigator.mediaDevices.getUserMedia({audio});
    }
    const track=stream.getAudioTracks()[0];
    if(!track || track.readyState!=='live')throw new Error('Aucune piste microphone active.');
    await refreshMicrophones(track.getSettings().deviceId);
    pcmCapture=await startPcmCapture(stream);captureKeepsStream=keepStream;
    track.addEventListener('ended',()=>{if(pcmCapture && !captureBusy)stopRecord();},{once:true});
    begun=Date.now();
    $('start-btn').disabled=true;$('stop-btn').disabled=false;$('timer').classList.add('recording');
    $('timer').textContent='00:00';
    clock=setInterval(()=>{
      const seconds=(Date.now()-begun)/1000;
      $('timer').textContent=elapsed(seconds);
      if(seconds>=(window.acodyslexCaptureLimitSeconds||19.5))stopRecord();
    },100);
    setCaptureBusy(false);
    // Start remains disabled throughout recording; stop is enabled.
    $('start-btn').disabled=true;$('microphone-select').disabled=true;$('file-input').disabled=true;
    status('Capture PCM directe en cours. Le niveau affiché provient du même signal que le WAV.');
  }catch(e){
    const message=e.name==='OverconstrainedError'||e.name==='NotFoundError'
      ? 'Microphone sélectionné indisponible. Choisissez une autre entrée.'
      : e.name==='NotAllowedError' ? 'Accès au microphone refusé. Autorisez le microphone pour cette page.' : e.message;
    status(`Impossible de démarrer le micro : ${message}`,'err');
    $('microphone-status').textContent=message;
    showMicDiagnostic(`Erreur d’accès au microphone : ${message}`);
    await stopMicrophoneMonitor();
    if(pcmCapture){pcmCapture.accepting=false;sourceCleanup(pcmCapture);await pcmCapture.context.close().catch(()=>{});pcmCapture=null;}
    captureKeepsStream=false;
    if(!options?.keepStream){stream?.getTracks().forEach(track=>track.stop());stream=null;}
    setCaptureBusy(false);
  }
}
async function stopRecord(options={}){
  if(pcmCapture && !captureBusy)await recordStopped(options?.keepStream??captureKeepsStream);
  return wavBlob;
}
async function pauseRecord(){
  if(!pcmCapture || captureBusy || !pcmCapture.accepting)return false;
  pcmCapture.accepting=false;
  await pcmCapture.context.suspend();
  return true;
}
async function resumeRecord(){
  if(!pcmCapture || captureBusy || pcmCapture.accepting)return false;
  await pcmCapture.context.resume();
  pcmCapture.accepting=true;
  return true;
}
async function releaseMicrophone(){
  if(pcmCapture && !captureBusy)await recordStopped(false);
  stream?.getTracks().forEach(track=>track.stop());stream=null;captureKeepsStream=false;
}
async function replayAudio(){
  if(captureBusy)return;
  const player=$('preview');
  if(!player.getAttribute('src'))return;
  // Explicit listening action: restore a muted/zero-volume player without altering the WAV.
  player.muted=false;
  if(player.volume===0)player.volume=1;
  player.currentTime=0;
  try{
    await player.play();
  }catch(error){
    const message=error.name==='NotAllowedError'
      ? 'Le navigateur a bloqué la lecture. Cliquez de nouveau sur Réécouter.'
      : 'Lecture impossible. Réessayez ou téléchargez le WAV pour vérifier le fichier.';
    status(message,'err');
  }
}
function downloadBlob(blob,name){const link=document.createElement('a'),url=URL.createObjectURL(blob);link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);}
async function jsonFetch(url,options={}){
  const res=await fetch(url,options); let data;
  try{ data=await res.json(); }catch{throw new Error(res.ok?'Réponse JSON invalide du serveur.':`HTTP ${res.status}`);}
  if(!res.ok) throw new Error(typeof data?.detail==='string'?`HTTP ${res.status} : ${data.detail}`:`HTTP ${res.status}`);
  return data;
}
async function saveRecord(){
  if(!wavBlob) return;
  if(!audioSaveAllowed){status('Sauvegarde refusée : le WAV ne contient pas de signal audio suffisant. Recommencez la capture.','err');return;}
  if(!$('save-consent').checked){status('Confirmez l’autorisation de conservation avant la sauvegarde.','err');return;}
  const fields=new FormData();
  fields.append('file',wavBlob,'reading.wav');
  fields.append('learner_code',$('learner').value.trim());
  fields.append('target_text',$('target').value.trim());
  fields.append('expected_phonemes',$('phonemes').value.trim());
  fields.append('verified_error_type',$('verified-error').value);
  fields.append('local_consent','true');
  $('save-btn').disabled=true;
  try{
    const entry=await jsonFetch('/api/recordings',{method:'POST',body:fields});
    currentId=entry.id;await loadEntries();selectRecord(entry.id);
    status('Enregistrement sauvegardé localement avec succès.','ok');
  }catch(e){status(`Échec de sauvegarde : ${e.message}`,'err');}
  finally{$('save-btn').disabled=!wavBlob||!audioSaveAllowed;}
}
function make(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
function clearResult(){
  $('results').hidden=true;$('empty-state').hidden=false;lastResult=null;
  $('phonemeResult').replaceChildren();$('json-output').textContent='';
}
function selectRecord(id){
  // Ignore an in-flight response when the operator changes the selected session.
  analysisRequest++;clearResult();
  currentId=id;const entry=entries.find(x=>x.id===id);
  $('selected-name').textContent=entry?`${entry.learner_code} · ${entry.target_text} · ${entry.duration_seconds}s`:'Aucune séance sauvegardée';
  $('analyze-btn').disabled=!entry;$('analyze-btn').textContent="Analyser l'audio";
  // An archived selection is not a newly recorded WAV: prevent accidental duplicate saves.
  wavBlob=null;audioSaveAllowed=false;$('save-btn').disabled=true;$('download-btn').disabled=true;
  if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=null;
  if(entry){$('preview').src=`/api/recordings/${id}/audio`;$('preview').hidden=false;$('audio-details').textContent=`Audio sauvegardé : ${entry.learner_code}`;}
  else{$('preview').removeAttribute('src');$('preview').hidden=true;$('audio-details').textContent='Aucun audio sélectionné.';}
  $('replay-btn').disabled=!entry;
  renderEntries();
}
function renderEntries(){
  const parent=$('archive-list');parent.replaceChildren();
  if(!entries.length){parent.append(make('p','Aucun audio sauvegardé. Enregistrez votre première séance.'));return;}
  for(const item of entries){
    const row=make('div',undefined,'archive-entry'+(item.id===currentId?' active':''));
    row.append(make('div','♫','archive-icon'));
    const meta=make('div',undefined,'archive-meta');
    meta.append(make('strong',`${item.learner_code} · ${item.target_text}`));
    meta.append(make('small',`${formatDate(item.created_at)} · ${formatNumber(item.duration_seconds)}s`));row.append(meta);
    const btns=make('div',undefined,'archive-buttons');
    const choose=make('button','Sélectionner');choose.onclick=()=>selectRecord(item.id);btns.append(choose);
    const audio=make('button','Écouter');audio.onclick=()=>{
      const player=$('preview');if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=null;
      player.src=`/api/recordings/${item.id}/audio`;player.hidden=false;
      $('replay-btn').disabled=false;
      $('audio-details').textContent=`Audio sauvegardé : ${item.learner_code}`;replayAudio();
    };btns.append(audio);
    const dl=make('button','WAV');dl.onclick=()=>{const link=document.createElement('a');link.href=`/api/recordings/${item.id}/audio`;link.download=`${item.id}.wav`;link.click()};btns.append(dl);
    const del=make('button','Supprimer','delete');del.onclick=()=>deleteEntry(item.id);btns.append(del);row.append(btns);parent.append(row);
  }
}
async function deleteEntry(id){
  if(!confirm('Supprimer définitivement cet audio local et ses métadonnées ?'))return;
  try{await jsonFetch(`/api/recordings/${id}`,{method:'DELETE'});if(currentId===id)currentId=null;await loadEntries();selectRecord(currentId);status('Enregistrement supprimé.','ok');}
  catch(e){status(e.message,'err');}
}
async function loadEntries(){entries=await jsonFetch('/api/recordings');renderEntries();}
function renderResult(data){
  lastResult=data;$('empty-state').hidden=true;$('results').hidden=false;
  $('model-name').textContent=data.model||'';
  const phonemes=$('predicted');phonemes.replaceChildren();
  for(const p of(data.predicted_phonemes||[]))phonemes.append(make('span',String(p)));
  const errs=$('errors');errs.replaceChildren();
  if(!data.expected_phonemes?.length)errs.textContent='Référence phonémique absente : comparaison désactivée.';
  else if(!Array.isArray(data.candidate_errors))errs.textContent='Résultats historiques indisponibles. Consultez la classification phonémique ci-dessus.';
  else if(!data.candidate_errors.length)errs.textContent='Aucune différence candidate signalée dans la liste historique ; cela ne garantit pas une lecture correcte.';
  else{const pre=make('pre',JSON.stringify(data.candidate_errors,null,2));errs.append(pre)}
  const metrics=$('acoustics');metrics.replaceChildren();
  const names={duration_seconds:'Durée',rms_amplitude:'Amplitude RMS',peak_amplitude:'Amplitude maximale',low_energy_frame_ratio:'Trames peu énergétiques',quiet_recording_warning:'Audio faible ?'};
  for(const [key,label] of Object.entries(names)){
    if(data.acoustics?.[key]===undefined)continue;
    const box=make('div',undefined,'metric');box.append(make('small',label),make('strong',String(data.acoustics[key])));metrics.append(box);
  }
  $('warning').textContent=data.warning||'Les différences phonémiques restent à vérifier.';
  $('whisper-result').hidden=!data.whisper_transcript;
  $('whisper-text').textContent=data.whisper_transcript||'';
  $('json-output').textContent=JSON.stringify(data,null,2);
}
function validateAnalysisResult(data){
  const isObject=value=>value!==null && typeof value==='object' && !Array.isArray(value);
  const isTokens=value=>Array.isArray(value) && value.every(token=>typeof token==='string');
  if(!isObject(data) || data.status!=='ok' ||
     (data.predicted_phonemes!=null && !isTokens(data.predicted_phonemes)) ||
     (data.expected_phonemes!=null && typeof data.expected_phonemes!=='string' && !isTokens(data.expected_phonemes)) ||
     (data.candidate_errors!=null && !Array.isArray(data.candidate_errors)) ||
     (data.acoustics!=null && !isObject(data.acoustics)) ||
     (data.whisper_transcript!=null && typeof data.whisper_transcript!=='string')){
    throw new Error('Réponse d’analyse incohérente ou incomplète.');
  }
}
async function analyze(){
  if(!currentId)return;
  if(!$('transfer-consent').checked){status('Confirmez l’autorisation de traitement distant avant l’analyse.','err');return;}
  const fields=new FormData();fields.append('transfer_consent','true');fields.append('use_whisper',$('whisper').checked?'true':'false');
  const recordId=currentId, request=++analysisRequest;
  clearResult();
  $('analyze-btn').disabled=true;$('analyze-btn').textContent='Analyse en cours…';
  status('Appel de Wav2Vec2 sur Modal. Le premier lancement GPU peut être plus lent.');
  try {
    const result=await jsonFetch(`/api/recordings/${recordId}/analyze`,{method:'POST',body:fields});
    if(request!==analysisRequest || recordId!==currentId)return;
    validateAnalysisResult(result);
    renderResult(result);
    displayPhonemeClassification(result);
    status('Analyse acoustique reçue. Les différences éventuelles doivent être vérifiées.','ok');
  }
  catch(e){if(request===analysisRequest){clearResult();status(`Analyse impossible : ${e.message}`,'err');}}
  finally{if(request===analysisRequest){$('analyze-btn').disabled=!currentId;$('analyze-btn').textContent="Analyser l'audio";}}
}
let laboratoryInitialized=false;
async function initializeLaboratory(){
  if(laboratoryInitialized)return;
  laboratoryInitialized=true;
  $('start-btn').addEventListener('click',startRecord);$('stop-btn').addEventListener('click',stopRecord);
  $('save-btn').addEventListener('click',saveRecord);
  $('replay-btn').addEventListener('click',replayAudio);
  refreshMicrophones();
  navigator.mediaDevices?.addEventListener('devicechange',()=>{
    if(!$('laboratory-page').hidden)refreshMicrophones();
  });
  $('download-btn').addEventListener('click',()=>wavBlob&&downloadBlob(wavBlob,'acodyslex_lecture.wav'));
  $('analyze-btn').addEventListener('click',analyze);
  $('file-input').addEventListener('change',async e=>{
    const file=e.target.files?.[0];if(!file)return;
    if(!file.name.toLowerCase().endsWith('.wav')){status('Veuillez importer un fichier .wav','err');return;}
    setCaptureBusy(true);
    try{
      const signal=await inspectRecordedSignal(file);
      setAudio(file,file.name,signal);
      const qualityIssue=audioQualityMessage(signal);
      if(qualityIssue){
        status(`${qualityIssue} Sauvegarde bloquée. Rapprochez-vous du microphone puis recommencez.`,'err');
      }else if(signal.db < -45){
        status('WAV importé avec un signal faible. Réécoutez-le avant de sauvegarder.');
      }else{
        status('WAV importé : signal détecté. Le format sera contrôlé à la sauvegarde.','ok');
      }
    }catch(error){
      status(`Impossible de lire le WAV importé : ${error.message}`,'err');
    }finally{setCaptureBusy(false);}
  });
  $('export-json').addEventListener('click',()=>{if(lastResult)downloadBlob(new Blob([JSON.stringify(lastResult,null,2)],{type:'application/json'}),'acodyslex_analyse.json')});
  try{
    const cfg=await jsonFetch('/api/config');
    $('whisper').disabled=!cfg.whisper_enabled;
    $('whisper-state').textContent=cfg.whisper_enabled?'Disponible (local, sur demande).':'Non activé sur ce serveur.';
    if(!cfg.modal_ready) status('Clé Modal absente : la sauvegarde locale fonctionne, mais l’analyse distante sera indisponible.');
    await loadEntries();
  }catch(e){status(`Impossible de communiquer avec le serveur local : ${e.message}`,'err');}
}
async function openLaboratory(){
  $('child-page').hidden=true;$('laboratory-page').hidden=false;
  $('home-nav-btn').classList.remove('active');$('home-nav-btn').removeAttribute('aria-current');
  $('laboratory-nav-btn').classList.add('active');$('laboratory-nav-btn').setAttribute('aria-current','page');
  await initializeLaboratory();
  $('laboratory-title').focus?.();
  window.scrollTo({top:0,behavior:'smooth'});
}
function closeLaboratory(){
  if(pcmCapture){
    if(!confirm("Un enregistrement du laboratoire est en cours. L'arrêter et retourner à l'accueil ?"))return false;
    stopRecord();
  }
  $('laboratory-page').hidden=true;$('child-page').hidden=false;
  $('laboratory-nav-btn').classList.remove('active');$('laboratory-nav-btn').removeAttribute('aria-current');
  $('home-nav-btn').classList.add('active');$('home-nav-btn').setAttribute('aria-current','page');
  window.scrollTo({top:0,behavior:'smooth'});
  return true;
}
window.acodyslexLegacyAudio={
  start:startRecord,
  stop:stopRecord,
  stopAndGetBlob:stopRecord,
  pause:pauseRecord,
  resume:resumeRecord,
  getBlob:()=>wavBlob,
  isRecording:()=>Boolean(pcmCapture),
  isPaused:()=>Boolean(pcmCapture && !pcmCapture.accepting),
  getLiveSamples:()=>pcmCapture?.latestSamples||null,
  getLiveSignal:()=>pcmCapture?.latestSignal||null,
  hasLiveStream:()=>Boolean(stream?.getAudioTracks?.().some(track=>track.readyState==='live')),
  release:releaseMicrophone,
  useFile:async file=>{
    const signal=await inspectRecordedSignal(file);
    setAudio(file,file.name||'lecture.wav',signal);
    return {usable:audioIsUsable(signal),signal,reason:audioQualityMessage(signal)};
  },
};
window.acodyslexLaboratory={
  open:openLaboratory,
  close:closeLaboratory,
  initialize:initializeLaboratory,
  isInitialized:()=>laboratoryInitialized,
  isOpen:()=>!$('laboratory-page').hidden,
};
$('laboratory-nav-btn').addEventListener('click',openLaboratory);
$('laboratory-back-btn').addEventListener('click',closeLaboratory);
$('home-nav-btn').addEventListener('click',()=>{if(!$('laboratory-page').hidden)closeLaboratory();});
