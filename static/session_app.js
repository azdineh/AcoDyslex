/* AcoDyslex V0.4: mixed reading, bilingual UI and traceable results. */
(() => {
  const $ = id => document.getElementById(id);
  const i18n=()=>window.acodyslexI18n;
  const t=(key,fallback=key,params={})=>{const value=i18n()?.t?.(key,params);return value&&value!==key?value:fallback;};
  const pt=(key,fallback,params={})=>String(t(key,fallback,params)).replace(/\{(\w+)\}/g,(_,name)=>params[name]??`{${name}}`);
  const formatNumber=(value,options)=>i18n()?.formatNumber?.(value,options)??String(value);
  const formatPercent=value=>i18n()?.formatPercent?.(value)??`${Math.round(Number(value)*100)}%`;
  const AVATARS=new Set(['neutral','sky','mint','coral','violet']);
  const avatarId=value=>AVATARS.has(value)?value:'neutral';
  const STORE = 'acodyslex-v03-session';
  let LIMIT = Math.max(1, Math.min(20, Number(window.ACODYSLEX_WORD_LIMIT_SECONDS || 10)));
  const ANALYSIS_TIMEOUT_MS = Math.max(100, Number(window.ACODYSLEX_ANALYSIS_TIMEOUT_MS || 90000));
  const SILENCE_MS = 2000, SPEECH_CONFIRM_MS = 150, SPEECH_RMS = 0.02, SPEECH_PEAK = 0.06, WORD_REVEAL_DELAY_MS = 250;
  const LABELS = {omission:'Omission',insertion:'Insertion',inversion:'Inversion',consonant_substitution:'Substitution de consonne',short_vowel_confusion:'Voyelle brève',long_vowel_confusion:'Voyelle longue'};
  const state = {phase:'home',child:null,sessionId:null,words:[],index:0,results:[],globalSummary:null,exercises:[],attempts:[],exerciseIndex:0,exerciseDrafts:{},activities:{},activeActivityId:null,remediationPaused:false,analysisId:null,recordingMeta:{},readingMode:'mixed',reportReadOnly:false};
  const recordings = new Map();
  let previewUrl=null, timer=null, wordRevealTimer=null, activeMs=0, activeSince=0, returnToReady=false,sequenceStarted=false,captureState='idle',waveform=null,speechDetected=false,speechAccumulatedMs=0,silenceSince=0,signalCheckedAt=0,analysisStage='ready',analysisLastStep=0,analysisTimer=null,analysisTimeout=null,analysisInFlight=false,analysisController=null,analysisModal=null,analysisRun=0,analysisDetached=false;

  function apiError(detail,status){
    if(typeof detail==='string'&&detail.trim())return window.acodyslexI18n?.translate?.(detail)||detail;
    if(Array.isArray(detail))return detail.map(item=>{const path=Array.isArray(item?.loc)?item.loc.filter(part=>part!=='body').join('.'):'',message=item?.msg||JSON.stringify(item);return path?`${path} : ${message}`:message;}).join(' ; ');
    if(detail&&typeof detail==='object')return detail.message||detail.msg||JSON.stringify(detail);
    return `HTTP ${status}`;
  }
  async function api(url,options){const response=await fetch(url,options),body=await response.json().catch(()=>({}));if(!response.ok){const error=new Error(apiError(body.detail??body,response.status));error.status=response.status;throw error;}return body;}
  let acousticModelInfo=null,acousticModelRequest=null;
  function modelText(id,value,fallback='Non renseigné'){const node=$(id);if(node)node.textContent=value||fallback;}
  function modelLink(id,url){const node=$(id);if(!node)return;node.hidden=!url;if(url)node.href=url;else node.removeAttribute('href');}
  function renderAcousticModelInfo(info){
    configurePhonemePresentation(info?.phoneme_presentation);
    const model=info.model||{},infrastructure=info.infrastructure||{},verified=info.metadata_verified===true;
    const status=$('model-config-status');status.className=`model-config-status ${verified?'verified':'unverified'}`;status.textContent=verified?'Configuration Modal confirmée':'Modèle déployé non documenté';
    const developer=$('model-developer-card');developer.hidden=!(verified&&model.base_developer_confirmed===true);
    modelText('model-base-developer',model.base_developer);modelText('model-base-id',model.base_model);modelLink('model-base-link',model.base_model_url);
    modelText('acoustic-model-name',model.display_name||info.model_id);modelText('acoustic-model-id',info.model_id);modelLink('model-metadata-link',model.metadata_url);
    modelText('acoustic-model-version',model.release,'Non exposée');modelText('acoustic-model-revision',info.runtime_revision,'Non exposée par Modal');modelText('acoustic-model-publisher',model.publisher,'Non confirmée');
    modelText('acoustic-infrastructure',infrastructure.provider,'Modal');modelText('acoustic-deployment',infrastructure.deployment);modelText('acoustic-api-version',infrastructure.api_version);modelText('acoustic-arabic-capability',model.arabic_capability,'Non confirmée pour ce déploiement');
    $('model-rigor-note').textContent=verified?'MostafaMaroof publie l’adaptation arabe. Meta (Facebook AI) est le développeur du modèle de base XLS-R. Modal fournit l’infrastructure d’exécution. La révision exacte des poids n’est pas exposée par le service actif.':'L’identifiant vient du déploiement Modal actif, mais ses métadonnées éditoriales ne sont pas dans la liste vérifiée. Le logo et le nom d’un développeur ne sont donc pas attribués.';
  }
  async function loadAcousticModelInfo(){
    if(acousticModelInfo)return renderAcousticModelInfo(acousticModelInfo);
    if(!acousticModelRequest)acousticModelRequest=api('/api/acoustic-model').then(info=>(acousticModelInfo=info)).finally(()=>{acousticModelRequest=null;});
    try{renderAcousticModelInfo(await acousticModelRequest);}catch(error){const status=$('model-config-status');status.className='model-config-status error';status.textContent='Configuration indisponible';$('model-developer-card').hidden=true;modelText('acoustic-model-name','Métadonnées indisponibles');modelText('acoustic-model-id','Le service Modal n’a pas pu être interrogé');modelText('acoustic-model-version','—');modelText('acoustic-model-revision','—');modelText('acoustic-model-publisher','—');modelText('acoustic-deployment','Non renseigné');modelText('acoustic-api-version','—');modelText('acoustic-arabic-capability','Impossible de confirmer cette capacité actuellement.');$('model-rigor-note').textContent=error.message;}
  }
  const json=(method,body)=>({method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const makeId=prefix=>`${prefix}_${crypto.randomUUID().replaceAll('-','').slice(0,24)}`;
  function persist(){localStorage.setItem(STORE,JSON.stringify(state));}
  function restore(){try{Object.assign(state,JSON.parse(localStorage.getItem(STORE)||'{}'));}catch{localStorage.removeItem(STORE);}state.recordingMeta||={};state.exerciseDrafts||={};state.activities||={};state.activeActivityId??=null;state.remediationPaused=!!state.remediationPaused;state.exerciseIndex=Number.isInteger(state.exerciseIndex)?state.exerciseIndex:0;}
  function message(text,kind=''){ $('reading-message').textContent=text;$('reading-message').className=`v3-message ${kind}`; }
  function batchMessage(text,kind=''){ $('batch-message').textContent=text;$('batch-message').className=`v3-message ${kind}`; }
  function show(phase){state.phase=phase;document.body.dataset.sessionPhase=phase;for(const name of ['home','reading','ready','review','remediation','completed'])$(`v3-${name}`).hidden=name!==phase;document.querySelectorAll('.journey [data-phase]').forEach(n=>n.classList.toggle('active',n.dataset.phase===(phase==='ready'?'reading':phase)));persist();}
  let preserveAnalysisPhase=false;
  async function backendPhase(phase){if(state.sessionId&&state.child&&!(preserveAnalysisPhase&&phase==='ready_to_analyze'))await api(`/v1/progress/sessions/${state.sessionId}/state`,json('PATCH',{child_id:state.child.child_id,state:phase}));}

  function clearColors(){if(window.CSS?.highlights)for(let i=0;i<6;i++)CSS.highlights.delete(`aco-letter-${i}`);}
  function colorArabic(text,enabled=true){
    const node=$('reading-word');clearColors();node.classList.toggle('colored',enabled);
    if(!enabled||!window.CSS?.highlights||typeof Highlight!=='function'||!node.firstChild)return false;
    const groups=Array.from({length:6},()=>[]),segments=typeof Intl.Segmenter==='function'?[...new Intl.Segmenter('ar',{granularity:'grapheme'}).segment(text)]:[...text].map((segment,index)=>({segment,index}));
    for(const part of segments){const base=[...part.segment.normalize('NFD')].find(c=>!/\p{Mark}/u.test(c));if(!base||!/\p{Script=Arabic}/u.test(base))continue;const range=new Range();range.setStart(node.firstChild,part.index);range.setEnd(node.firstChild,part.index+part.segment.length);groups[(base.codePointAt(0)*17)%6].push(range);}
    groups.forEach((ranges,i)=>{if(ranges.length)CSS.highlights.set(`aco-letter-${i}`,new Highlight(...ranges));});return true;
  }
  window.acodyslexArabicColoring={apply:colorArabic,clear:clearColors};

  async function loadProfiles(){
    const parent=$('profile-list');parent.replaceChildren();
    try{const data=await api('/v1/progress/children');$('profile-empty').hidden=!!data.children.length;$('app-reset-zone').hidden=!data.children.length;
      for(const child of data.children){let history={sessions:[],total:0};try{history=await api(`/v1/progress/children/${child.child_id}/history?limit=100`);history.sessions=(history.sessions||[]).slice(-8).reverse();}catch{}
        const card=document.createElement('article');card.className='profile-card';
        const avatar=document.createElement('span');avatar.className='profile-avatar';const avatarImage=document.createElement('img');avatarImage.src=`/static/avatars/${avatarId(child.avatar_id)}.svg`;avatarImage.alt=t('profile.avatarAlt','Child avatar',{name:child.display_name||child.child_id});avatar.append(avatarImage);
        const identity=document.createElement('div');identity.className='profile-identity';
        const title=document.createElement('h3');title.textContent=child.display_name||child.child_id;
        const meta=document.createElement('p');meta.className='profile-meta';meta.textContent=pt('profile.meta','{age} ans · {count} séance(s)',{age:child.age?formatNumber(child.age):'—',count:formatNumber(history.total)});
        const stats=document.createElement('p');stats.className='profile-stats';stats.textContent=child.skills?.length?pt('profile.skills','{count} compétence(s) suivie(s)',{count:formatNumber(child.skills.length)}):t('profile.newPath','Nouveau parcours');
        identity.append(title,meta,stats);
        const actions=document.createElement('div');actions.className='profile-actions';
        const start=document.createElement('button');start.className='primary';start.textContent=t('profile.start','Commencer');start.onclick=()=>startSession(child,history);
        const progress=document.createElement('button');progress.className='secondary';progress.textContent=t('profile.progress','Progrès');progress.onclick=()=>profileProgress(child,history);
        const edit=document.createElement('button');edit.className='secondary';edit.textContent=t('profile.edit','Modifier');edit.onclick=()=>editProfile(child);
        const remove=document.createElement('button');remove.className='text-button danger';remove.textContent=t('profile.delete','Supprimer');remove.onclick=async()=>{if(confirm(t('profile.deleteConfirm','Supprimer ce profil et son historique pédagogique local ?'))){await api(`/v1/progress/children/${child.child_id}`,{method:'DELETE'});await loadProfiles();}};
        actions.append(start,progress,edit,remove);card.append(avatar,identity,actions);
        const readySession=history.sessions.find(isGuideReady);
        if(readySession){
          const guideReady=document.createElement('button');guideReady.type='button';guideReady.className='profile-guide-ready';guideReady.title=learningGuideLabel();guideReady.onclick=()=>downloadLearningGuide(readySession.session_id);
          const guideImage=document.createElement('img');guideImage.src='/guideres/Maquette3D.png';guideImage.alt=t('profile.guideReadyImage','Personalized learning guide');
          const guideCopy=document.createElement('span');const guideTitle=document.createElement('strong');guideTitle.textContent=t('profile.guideReady','Le guide est prêt');const guideHint=document.createElement('small');guideHint.textContent=t('profile.guideReadyHint','Télécharger ou ouvrir le guide PDF');guideCopy.append(guideTitle,guideHint);guideReady.append(guideImage,guideCopy);card.append(guideReady);
        }
        if(history.sessions.length){
          const saved=document.createElement('section');saved.className='profile-saved-sessions';
          const savedTitle=document.createElement('h4');savedTitle.textContent=t('profile.savedSessions','Séances enregistrées');saved.append(savedTitle);
          for(const session of history.sessions){
            const row=document.createElement('div');row.className='profile-saved-session';
            const detail=document.createElement('div');const name=document.createElement('strong');name.textContent=historicSessionTitle(session);const status=document.createElement('span');status.textContent=historicSessionStatus(session);detail.append(name,status);
            const sessionActions=document.createElement('div');sessionActions.className='profile-saved-actions';
            const primary=document.createElement('button');primary.type='button';primary.className='secondary';primary.textContent=historicSessionAction(session);primary.onclick=()=>void resumeHistoricSession(child,session,historicSessionDestination(session));sessionActions.append(primary);const guide=document.createElement('button');guide.type='button';guide.className='text-button learning-guide-link';guide.textContent=learningGuideLabel();guide.onclick=()=>downloadLearningGuide(session.session_id);sessionActions.append(guide);
            if(hasHistoricReport(session)&&historicSessionDestination(session)!=='report'){
              const report=document.createElement('button');report.type='button';report.className='text-button';report.textContent=t('profile.viewReport','Consulter le bilan');report.onclick=()=>void resumeHistoricSession(child,session,'report');sessionActions.append(report);
            }
            row.append(detail,sessionActions);saved.append(row);
          }
          card.append(saved);
        }
        parent.append(card);
      }
    }catch(error){parent.textContent=`Backend indisponible : ${error.message}`;$('profile-empty').hidden=true;$('app-reset-zone').hidden=true;}
  }
  const historicSessionTitle=session=>{
    const date=new Date(session.started_at),language=i18n()?.getLanguage?.()||'en';
    if(Number.isNaN(date.valueOf()))return t('profile.sessionSaved','Séance enregistrée');
    const when=new Intl.DateTimeFormat(language==='ar'?'ar-MA-u-nu-latn':'en-US',{day:'numeric',month:'short',year:'numeric'}).format(date);
    return pt('profile.sessionOn','Séance du {date}',{date:when});
  };
  const historicSessionStatus=session=>pt(`profile.status.${session.state}`,({recording:'Lecture à reprendre',paused:'Lecture en pause',interrupted:'Lecture interrompue',ready_to_analyze:'Analyse à reprendre',analyzing_batch:'Analyse en cours',batch_failed:'Analyse à relancer',partial_results:'Résultats partiels',review:'Analyse à consulter',remediation:'Exercices disponibles',completed:'Parcours terminé',abandoned:'Parcours arrêté'})[session.state]||'Séance enregistrée');
  const hasHistoricReport=session=>(session.reading_words||[]).some(word=>word.analysis_status&&word.analysis_status!=='pending');
  const isGuideReady=session=>['review','remediation','completed','abandoned'].includes(session.state);
  const historicSessionDestination=session=>{
    if(['remediation','abandoned'].includes(session.state))return 'remediation';
    if(['review','completed'].includes(session.state)||hasHistoricReport(session))return 'report';
    return ['ready_to_analyze','batch_failed','partial_results','analyzing_batch'].includes(session.state)?'analysis':'reading';
  };
  const historicSessionAction=session=>pt(`profile.action.${session.state}`,({remediation:'Reprendre les exercices',review:'Consulter l’analyse',completed:'Consulter le bilan',ready_to_analyze:'Reprendre l’analyse',batch_failed:'Relancer l’analyse',partial_results:'Consulter les résultats',analyzing_batch:'Reprendre l’analyse',recording:'Reprendre la lecture',paused:'Reprendre la lecture',interrupted:'Reprendre la lecture',abandoned:'Consulter les activités'})[session.state]||t('profile.openSession','Ouvrir la séance'));
  function restoreHistoricActivities(session,exercises){
    state.activities=window.acodyslexActivityLibrary.createPlan(exercises,session.session_id);state.attempts=[...(session.attempts||[])];
    const latestRuns=new Map();
    for(const attempt of state.attempts){const match=/^v05_([a-z_]+)_r(\d+)_t(\d+)$/.exec(String(attempt.item_set_id||'')),id=attempt.activity_id||match?.[1],run=Number(match?.[2]||1);if(id)latestRuns.set(id,Math.max(latestRuns.get(id)||0,run));}
    for(const [id,activity] of Object.entries(state.activities)){
      const run=latestRuns.get(id)||1;activity.run=run;activity.completed={};activity.current=0;
      for(const attempt of state.attempts){const match=/^v05_([a-z_]+)_r(\d+)_t(\d+)$/.exec(String(attempt.item_set_id||'')),attemptId=attempt.activity_id||match?.[1],attemptRun=Number(match?.[2]||1),position=Number(match?.[3]);if(attemptId===id&&attemptRun===run&&Number.isInteger(position)&&position>=0&&position<activity.tasks.length){activity.completed[`${run}:${position}`]=attempt;activity.current=Math.max(activity.current,position+1);}}
      activity.status=activity.current>=activity.tasks.length?'completed':activity.current?'in_progress':'available';
    }
  }
  function historicResults(session){
    const verified=new Set((session.observations||[]).filter(item=>item.verification_status==='human_verified').map(item=>item.error_type));
    return (session.reading_words||[]).filter(word=>word.analysis_status&&word.analysis_status!=='pending').map(word=>({word_id:word.word_id,unit_id:word.unit_id||word.word_id,word_order:word.order,text:word.text,unit_type:word.unit_type||'word',expected:word.expected_phonemes||[],expectedPhonemesArabic:word.expected_phonemes_ar||[],phonemesByWord:word.phonemes_by_word||[],observed:Array.isArray(word.predicted_phonemes)?word.predicted_phonemes:[],recognizedText:word.observed_text||null,analysis_status:word.analysis_status,candidates:(word.candidate_errors||[]).map(candidate=>({...candidate,reviewStatus:verified.has(candidate.error_type||candidate.type)?'confirmed':'rejected'})),reviewedByCompanion:true}));
  }
  async function resumeHistoricSession(child,session,destination){
    try{
      const words=(session.reading_words||[]).map(word=>({...word,target_error_type:'omission',expected_phonemes:word.expected_phonemes||[]}));
      const savedActivities=state.sessionId===session.session_id&&Object.keys(state.activities||{}).length?state.activities:null;
      const savedActiveActivity=state.sessionId===session.session_id?state.activeActivityId:null;
      Object.assign(state,{child,sessionId:session.session_id,words,index:Math.max(0,words.findIndex(word=>!word.recording_id)),results:historicResults(session),globalSummary:null,exercises:[],attempts:[...(session.attempts||[])],exerciseIndex:0,exerciseDrafts:{},activities:savedActivities||{},activeActivityId:savedActivities?savedActiveActivity:null,remediationPaused:false,analysisId:null,recordingMeta:{},reportReadOnly:destination==='report'&&['remediation','completed'].includes(session.state)});
      if(state.index<0)state.index=0;
      await restoreAudios();
      if(destination==='reading'){const nextMissing=words.findIndex(word=>!recordings.has(word.word_id));state.index=nextMissing<0?0:nextMissing;}
      if(destination==='remediation'){
        if(session.state==='abandoned')await backendPhase('remediation');
        const response=await api(`/v1/progress/children/${child.child_id}/recommendations?session_id=${encodeURIComponent(session.session_id)}`);state.exercises=(response.recommended_exercises||[]).slice(0,7);if(state.exercises.length!==7)throw new Error('Les exercices personnalisés ne sont pas disponibles pour cette séance.');if(!savedActivities)restoreHistoricActivities(session,state.exercises);renderExercises();show('remediation');return;
      }
      if(destination==='report'){
        if(!state.results.length)throw new Error('Cette séance ne contient pas encore de résultat d’analyse consultable.');
        state.globalSummary={total_words:words.length,analyzed_words:state.results.filter(item=>item.analysis_status==='ok').length,words_with_candidates:state.results.filter(item=>item.candidates.length).length,candidate_error_count:state.results.reduce((total,item)=>total+item.candidates.length,0)};activeReportIndex=0;await renderReport();return;
      }
      if(destination==='analysis'){preserveAnalysisPhase=session.state==='analyzing_batch';try{await renderReady();}finally{preserveAnalysisPhase=false;}return;}
      renderReading();show('reading');
    }catch(error){alert(`Impossible d’ouvrir cette séance : ${error.message}`);}
  }
  function editProfile(child){$('profile-form').hidden=false;$('profile-form').dataset.childId=child.child_id;$('profile-name').value=child.display_name||'';$('profile-age').value=child.age||8;$('profile-sex').value=child.sex||'unspecified';const avatar=document.querySelector(`input[name="avatar_id"][value="${avatarId(child.avatar_id)}"]`);if(avatar)avatar.checked=true;$('profile-name').focus();}
  function profileProgress(child,history){state.child=child;$('completed-title').textContent=`Progrès de ${child.display_name||child.child_id}`;$('completion-text').textContent=`${formatNumber(history.total)} séance(s) enregistrée(s).`;renderSkills(child.skills);show('completed');}
  function renderSkills(skills){const parent=$('progress-skills');parent.replaceChildren();if(!skills?.length){parent.textContent=t('results.progress.empty','Progress will appear after the first exercises.');return;}for(const skill of skills){const row=document.createElement('div');row.className='skill-line';const label=document.createElement('span');label.textContent=`${skill.skill.replaceAll('_',' ')} · ${formatPercent(skill.mastery_estimate)}`;const description=document.createElement('p');description.className='skill-description';description.textContent=t('results.progress.description','Estimated mastery based on completed activities.');const track=document.createElement('div'),fill=document.createElement('i');fill.style.width=`${Math.max(0,Math.min(100,skill.mastery_estimate*100))}%`;track.append(fill);row.append(label,description,track);parent.append(row);}}
  const FALLBACK_SHORT_SENTENCES=[
    {id:'s01',type:'short_sentence',text:'\u0647\u064e\u0630\u064e\u0627 \u0643\u0650\u062a\u064e\u0627\u0628\u064c',word_count:2,difficulty_level:1,target_skills:['controlled_decoding'],language_variety:'ar-MSA',max_recording_seconds:15,category:'sentence_decoding',target_error_type:'substitution',phonemes:[]},
    {id:'s02',type:'short_sentence',text:'\u0642\u064e\u0631\u064e\u0623\u064e \u0627\u0644\u0648\u064e\u0644\u064e\u062f\u064f',word_count:2,difficulty_level:1,target_skills:['controlled_decoding'],language_variety:'ar-MSA',max_recording_seconds:15,category:'sentence_reading',target_error_type:'omission',phonemes:[]},
    {id:'s03',type:'short_sentence',text:'\u0634\u064e\u0631\u0650\u0628\u064e \u0627\u0644\u0648\u064e\u0644\u064e\u062f\u064f \u062d\u064e\u0644\u0650\u064a\u0628\u064b\u0627',word_count:3,difficulty_level:2,target_skills:['controlled_decoding','short_vowel_reading'],language_variety:'ar-MSA',max_recording_seconds:15,category:'sentence_reading',target_error_type:'short_vowel_confusion',phonemes:[]},
    {id:'s04',type:'short_sentence',text:'\u0630\u064e\u0647\u064e\u0628\u064e \u0627\u0644\u0648\u064e\u0644\u064e\u062f\u064f \u0644\u0650\u0644\u0633\u0651\u064f\u0648\u0642\u0650',word_count:3,difficulty_level:2,target_skills:['controlled_decoding','auditory_sequencing'],language_variety:'ar-MSA',max_recording_seconds:15,category:'sentence_sequencing',target_error_type:'inversion',phonemes:[]},
    {id:'s05',type:'short_sentence',text:'\u0644\u064e\u0639\u0650\u0628\u064e \u0648\u064e\u0644\u064e\u062f\u064c \u0628\u0650\u0627\u0644\u0652\u0643\u064f\u0631\u064e\u0629\u0650',word_count:3,difficulty_level:2,target_skills:['controlled_decoding','phoneme_discrimination'],language_variety:'ar-MSA',max_recording_seconds:15,category:'sentence_reading',target_error_type:'insertion',phonemes:[]},
    {id:'s06',type:'short_sentence',text:'\u0627\u0644\u0634\u0651\u064e\u0645\u0652\u0633\u064f \u0641\u064e\u0648\u0652\u0642\u064e \u0627\u0644\u0628\u064e\u064a\u0652\u062a\u0650',word_count:3,difficulty_level:2,target_skills:['controlled_decoding','long_vowel_reading'],language_variety:'ar-MSA',max_recording_seconds:15,category:'sentence_reading',target_error_type:'substitution',phonemes:[]},
    {id:'s07',type:'short_sentence',text:'\u0647\u064e\u0630\u0650\u0647\u0650 \u0648\u064e\u0631\u0652\u062f\u064e\u0629\u064c \u062c\u064e\u0645\u0650\u064a\u0644\u064e\u0629\u064c',word_count:3,difficulty_level:2,target_skills:['controlled_decoding','phoneme_grapheme_mapping'],language_variety:'ar-MSA',max_recording_seconds:15,category:'sentence_reading',target_error_type:'substitution',phonemes:[]},
  ];
  function readingUnit(raw,defaultType='word'){
    const unitType=raw.type==='short_sentence'?'short_sentence':defaultType;
    const wordCount=Number(raw.word_count||(unitType==='short_sentence'?String(raw.text||'').trim().split(/\s+/u).filter(Boolean).length:1));
    return {word_id:raw.id,unit_id:raw.id,unit_type:unitType,text:raw.text,category:raw.category||'decoding',expected_phonemes:raw.phonemes||[],expected_phonemes_ar:Array.isArray(raw.phonemes_ar)?raw.phonemes_ar:[],phonemes_by_word:Array.isArray(raw.phonemes_by_word)?raw.phonemes_by_word:[],phoneme_reference_status:raw.phoneme_reference_status||'missing',requires_linguistic_review:raw.requires_linguistic_review===true,reference_warnings:Array.isArray(raw.reference_warnings)?raw.reference_warnings:[],target_error_type:raw.target_error_type||'omission',word_count:wordCount,difficulty_level:Number(raw.difficulty_level)||1,target_skills:Array.isArray(raw.target_skills)&&raw.target_skills.length?raw.target_skills:[raw.category||'decoding'],language_variety:raw.language_variety||'ar-MSA',max_recording_seconds:Number(raw.max_recording_seconds)||(unitType==='short_sentence'?15:10)};
  }
  function selectUnits(units,count,recent,offset,adaptive){
    if(!units.length||count<1)return [];
    const rotated=[...units.slice(offset%units.length),...units.slice(0,offset%units.length)];
    const mastery=new Map((state.child?.skills||[]).map(skill=>[skill.skill,Number(skill.mastery_estimate)]));
    const need=unit=>Math.min(...(unit.target_skills||[]).map(skill=>mastery.get(skill)??.5));
    return rotated.sort((left,right)=>{
      const recentDifference=Number(recent.has(left.unit_id))-Number(recent.has(right.unit_id));
      if(recentDifference)return recentDifference;
      if(!adaptive)return 0;
      return need(left)-need(right)||right.difficulty_level-left.difficulty_level;
    }).slice(0,count);
  }
  function shuffleUnits(units){for(let index=units.length-1;index>0;index--){const other=Math.floor(Math.random()*(index+1));[units[index],units[other]]=[units[other],units[index]];}return units;}
  async function selectWords(history){
    const bank=await api('/static/reading_words.json?v=0.4.2');
    const recent=new Set(history.sessions.slice(0,2).flatMap(session=>(session.reading_words||[]).map(unit=>unit.unit_id||unit.word_id)));
    const words=(bank.words||[]).map(unit=>readingUnit(unit));
    const bankSentences=(bank.short_sentences||[]).map(unit=>readingUnit(unit,'short_sentence')).filter(unit=>unit.word_count>=2&&unit.word_count<=3&&unit.text.trim().split(/\s+/u).length===unit.word_count);
    const sentences=bankSentences.length>=7?bankSentences:FALLBACK_SHORT_SENTENCES.map(unit=>readingUnit(unit,'short_sentence'));
    const mode=['word_only','mixed','adaptive'].includes(state.readingMode)?state.readingMode:'mixed';
    const mixedBankAvailable=sentences.length>=7;
    const wordCount=mode==='word_only'||!mixedBankAvailable?15:8, sentenceCount=mode==='word_only'||!mixedBankAvailable?0:7, offset=history.total*7;
    const selected=shuffleUnits([...selectUnits(words,wordCount,recent,offset,mode==='adaptive'),...selectUnits(sentences,sentenceCount,recent,offset,mode==='adaptive')]);
    const completed=selected.length===15?selected:[...selected,...selectUnits(words,15-selected.length,recent,offset+selected.length,mode==='adaptive')];
    return completed.slice(0,15).map((unit,index)=>({...unit,order:index+1,role:index<6?'revision':index<12?'consolidation':'transfer'}));
  }
  async function startSession(child,history){try{sequenceStarted=false;Object.assign(state,{child,words:await selectWords(history),index:0,results:[],globalSummary:null,exercises:[],attempts:[],exerciseIndex:0,exerciseDrafts:{},sessionId:makeId('session'),analysisId:null,recordingMeta:{},reportReadOnly:false});recordings.clear();await api('/v1/progress/sessions',json('POST',{session_id:state.sessionId,child_id:child.child_id,started_at:new Date().toISOString(),recommendation_engine_version:'0.4.0',observations:[],recommended_exercise_ids:[],reading_words:state.words.map(({target_error_type,...word})=>word)}));await backendPhase('recording');renderReading();show('reading');}catch(error){alert(`Impossible de démarrer la séance : ${error.message}`);}}

  function setPreview(record){if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=null;if(!record?.blob){$('session-preview').hidden=true;$('session-preview').removeAttribute('src');return;}previewUrl=URL.createObjectURL(record.blob);$('session-preview').src=previewUrl;$('session-preview').hidden=false;}
  function setCaptureState(next){captureState=next;const start=$('session-start'),indicator=$('recording-indicator'),labels={idle:'Prêt',recording:'Enregistrement en cours',paused:'En pause',finalizing:'Finalisation',transitioning:'Mot suivant',ready_to_analyze:'Terminé',recording_error:'Microphone à relancer'},buttonLabels={recording:'Enregistrement',paused:'En pause',finalizing:'Sauvegarde',transitioning:'Mot suivant',ready_to_analyze:'Terminé',recording_error:'Reprendre l’enregistrement'};indicator.textContent=labels[next]||next;indicator.className=`recording-indicator ${next==='recording'?'active':next}`;start.className=`record-primary ${next}`;start.disabled=!['idle','recording_error'].includes(next);$('session-start-label').textContent=buttonLabels[next]||(sequenceStarted?'Reprendre la lecture':'Commencer la lecture');$('reading-stage').dataset.captureState=next;$('session-stop').disabled=!['recording','paused'].includes(next);$('session-pause').disabled=!['recording','paused'].includes(next);$('session-pause').textContent=next==='paused'?'Reprendre':'Pause';$('session-cancel').disabled=!['recording','paused'].includes(next);$('retry-word').disabled=['finalizing','transitioning'].includes(next);const waveState=next==='recording'?'recording':next==='paused'?'paused':'idle';waveform?.setState(waveState);$('waveform-label').textContent=next==='recording'?'Voix en direct':next==='paused'?'Visualisation en pause':'Microphone inactif';}
  function hideReadingWord(){clearTimeout(wordRevealTimer);wordRevealTimer=null;clearColors();const node=$('reading-word');node.textContent='';node.classList.add('awaiting-word');node.setAttribute('aria-hidden','true');}
  function revealReadingWord(){const word=state.words[state.index];if(!word)return;const node=$('reading-word');node.textContent=word.text;node.classList.remove('awaiting-word');node.removeAttribute('aria-hidden');colorArabic(word.text,$('colored-letters').checked);}
  function beginWordRevealCountdown(){if(state.index===0&&!$('reading-word').classList.contains('awaiting-word'))return;hideReadingWord();wordRevealTimer=setTimeout(()=>{wordRevealTimer=null;if(captureState!=='recording')return;revealReadingWord();message('Lis le mot clairement, près du microphone. Les voix trop faibles ou trop éloignées seront refusées.','success');},WORD_REVEAL_DELAY_MS);}
  function resetSilenceDetection(){speechDetected=false;speechAccumulatedMs=0;silenceSince=0;signalCheckedAt=0;if(activeSince&&captureState==='transitioning')beginWordRevealCountdown();}
  function resetRecorder(){const unit=state.words[state.index];if(unit&&Number(unit.max_recording_seconds)>=1)LIMIT=Math.min(20,Number(unit.max_recording_seconds));hideReadingWord();clearInterval(timer);timer=null;activeMs=0;activeSince=0;resetSilenceDetection();$('session-timer').textContent='00:00';$('time-remaining').style.width='100%';setCaptureState('idle');}
  function renderReading(){const word=state.words[state.index];if(!word)return void renderReady();const total=state.words.length;$('reading-child').textContent=state.child.display_name||state.child.child_id;$('reading-progress').textContent=`Mot ${formatNumber(state.index+1)} sur ${formatNumber(total)}`;$('word-progress-fill').style.width=`${(state.index+1)/total*100}%`;$('word-role').textContent=({revision:'Révision ciblée',consolidation:'Consolidation',transfer:'Nouveau transfert'})[word.role];$('reading-word').textContent=word.text;colorArabic(word.text,$('colored-letters').checked);resetRecorder();if(state.index===0&&!sequenceStarted)revealReadingWord();setPreview(recordings.get(word.word_id));message(recordings.has(word.word_id)?'Une lecture existe déjà pour cette unité. Un nouvel enregistrement la remplacera seulement après sa sauvegarde.':sequenceStarted?'La nouvelle unité est prête.':'Le premier élément est affiché. Appuyez sur le bouton rouge pour commencer les 15 unités.');persist();}
  function clock(){const running=captureState==='recording',now=Date.now(),elapsed=activeMs+(running&&activeSince?now-activeSince:0),seconds=Math.min(LIMIT,elapsed/1000);$('session-timer').textContent=`00:${String(Math.floor(seconds)).padStart(2,'0')}`;$('time-remaining').style.width=`${Math.max(0,100-seconds/LIMIT*100)}%`;if(!running){signalCheckedAt=0;return;}const signal=window.acodyslexLegacyAudio.getLiveSignal?.(),voice=!!signal&&(signal.rms>=SPEECH_RMS||signal.peak>=SPEECH_PEAK),delta=signalCheckedAt?Math.min(250,now-signalCheckedAt):0;signalCheckedAt=now;if(voice){speechAccumulatedMs+=delta;if(speechAccumulatedMs>=SPEECH_CONFIRM_MS)speechDetected=true;silenceSince=0;}else if(!speechDetected){speechAccumulatedMs=0;}else{silenceSince||=now;if(now-silenceSince>=SILENCE_MS)return void finishCapture('silence');}if(seconds>=LIMIT)void finishCapture('limit');}
  async function startCapture({automatic=false}={}){if(!['idle','recording_error','transitioning'].includes(captureState)||window.acodyslexLegacyAudio.isRecording())return false;setCaptureState('transitioning');try{window.acodyslexCaptureLimitSeconds=3600;$('learner').value=state.child.child_id;$('target').value=state.words[state.index].text;$('phonemes').value=state.words[state.index].expected_phonemes.join(' ');await window.acodyslexLegacyAudio.start({keepStream:true});if(!window.acodyslexLegacyAudio.isRecording())throw new Error('La capture n’a pas démarré.');sequenceStarted=true;activeMs=0;activeSince=Date.now();resetSilenceDetection();setCaptureState('recording');timer=setInterval(clock,100);clock();await backendPhase('recording').catch(()=>{});message(automatic?'Nouveau mot : l’enregistrement a démarré automatiquement.':'J’écoute… tu peux lire le mot. Deux secondes de silence après la lecture termineront automatiquement le mot.','success');return true;}catch(error){window.acodyslexCaptureLimitSeconds=19.5;setCaptureState('recording_error');message(`Le microphone n’a pas redémarré : ${error.message}. Appuyez sur « Reprendre l’enregistrement ».`,'error');return false;}}
  async function togglePause(){if(!window.acodyslexLegacyAudio.isRecording()||!['recording','paused'].includes(captureState))return;if(captureState==='recording'){activeMs+=Date.now()-activeSince;activeSince=0;silenceSince=0;signalCheckedAt=0;await window.acodyslexLegacyAudio.pause();setCaptureState('paused');await backendPhase('paused');message('Pause. Le temps et les échantillons sont suspendus.');}else{await window.acodyslexLegacyAudio.resume();activeSince=Date.now();silenceSince=0;signalCheckedAt=0;setCaptureState('recording');await backendPhase('recording');message('L’enregistrement reprend sur le même mot.','success');}}
  async function durationMs(blob){const view=new DataView(await blob.arrayBuffer());if(view.byteLength<44)return 0;const rate=view.getUint32(28,true),bytes=view.getUint32(40,true);return rate?Math.round(bytes/rate*1000):0;}
  async function storeBlob(blob,word=state.words[state.index]){const inspected=await window.acodyslexLegacyAudio.useFile(blob);if(!inspected.usable)throw new Error(`${inspected.reason||'La voix est trop faible ou trop éloignée du microphone.'} Rapprochez-vous puis recommencez ce mot.`);const duration=await durationMs(blob);if(duration<150||duration>LIMIT*1000+100)throw new Error(`Durée WAV invalide (${duration} ms).`);const record=await window.acodyslexAudioStore.put({child_id:state.child.child_id,session_id:state.sessionId,word_id:word.word_id,word_order:word.order,reference_text:word.text,expected_phonemes:word.expected_phonemes,audio_duration_ms:duration,audio_format:'audio/wav;codecs=pcm_s16le',recording_status:'ready',blob});recordings.set(word.word_id,record);state.recordingMeta[word.word_id]={...record,blob:undefined};state.analysisId=null;persist();return record;}
  const transitionDelay=()=>new Promise(resolve=>setTimeout(resolve,matchMedia('(prefers-reduced-motion: reduce)').matches?0:180));
  async function advance({automatic=sequenceStarted}={}){if(returnToReady){returnToReady=false;await window.acodyslexLegacyAudio.release?.();await renderReady();return;}if(state.index>=14){await window.acodyslexLegacyAudio.release?.();setCaptureState('ready_to_analyze');await renderReady();return;}setCaptureState('transitioning');$('reading-stage').classList.add('word-transition');await transitionDelay();state.index++;renderReading();show('reading');await transitionDelay();$('reading-stage').classList.remove('word-transition');if(automatic)await startCapture({automatic:true});}
  async function finishCapture(reason='manual'){if(!['recording','paused'].includes(captureState)||!window.acodyslexLegacyAudio.isRecording())return;const word=state.words[state.index],last=state.index>=14||returnToReady;clearInterval(timer);timer=null;if(captureState==='recording'&&activeSince)activeMs+=Date.now()-activeSince;setCaptureState('finalizing');message(reason==='silence'?'Deux secondes de silence détectées. Sauvegarde du mot…':reason==='limit'?'Durée maximale atteinte. Sauvegarde du mot…':'Finalisation et sauvegarde locale du WAV…');try{const blob=await window.acodyslexLegacyAudio.stopAndGetBlob({keepStream:!last});window.acodyslexCaptureLimitSeconds=19.5;if(!blob)throw new Error('Aucun WAV finalisé.');const record=await storeBlob(blob,word);setPreview(record);message('Mot enregistré localement. Passage au mot suivant…','success');await advance({automatic:true});}catch(error){setCaptureState('recording_error');message(`Sauvegarde impossible : ${error.message}. L’enregistrement précédent est conservé ; recommencez ce mot.`,'error');}}
  async function cancelCapture(){if(!['recording','paused'].includes(captureState)||!window.acodyslexLegacyAudio.isRecording())return;clearInterval(timer);timer=null;setCaptureState('finalizing');message('Annulation de l’enregistrement en cours…');try{await window.acodyslexLegacyAudio.stopAndGetBlob({keepStream:true});window.acodyslexCaptureLimitSeconds=19.5;activeMs=0;activeSince=0;resetSilenceDetection();revealReadingWord();setCaptureState('idle');message('Enregistrement annulé. Le fichier en cours n’a été ni sauvegardé ni envoyé. Vous pouvez recommencer ce mot.','success');}catch(error){setCaptureState('recording_error');message(`Annulation impossible : ${error.message}. Réessayez ou relancez le microphone.`,'error');}}
  async function importFile(file){const word=state.words[state.index];try{const record=await storeBlob(file,word);setPreview(record);message('WAV enregistré localement.','success');await advance({automatic:sequenceStarted});}catch(error){setCaptureState('recording_error');message(error.message,'error');}finally{$('session-file').value='';}}
  async function retry(){if(['finalizing','transitioning'].includes(captureState))return;clearInterval(timer);timer=null;if(window.acodyslexLegacyAudio.isRecording())await window.acodyslexLegacyAudio.stopAndGetBlob({keepStream:true});activeMs=0;activeSince=0;setCaptureState('idle');message('Le mot va être réenregistré. L’ancien WAV reste conservé jusqu’à la nouvelle sauvegarde.');await startCapture();}

  const ANALYSIS_STAGE={incomplete:{step:0,kicker:'Lot incomplet',title:'Des lectures doivent être reprises',text:'Complétez les 15 enregistrements avant de lancer l’analyse.'},ready:{step:0,kicker:'Lot audio prêt',title:'Les 15 lectures sont prêtes',text:'Vérifiez l’autorisation, puis lancez l’analyse pour préparer le bilan pédagogique.'},checking:{step:0,kicker:'Préparation',title:'Vérification des 15 audios…',text:'Le système vérifie que chaque mot possède un enregistrement exploitable.'},sending:{step:1,kicker:'Envoi sécurisé',title:'Envoi groupé vers FastAPI…',text:'Les 15 lectures sont transmises ensemble dans un seul lot sécurisé.'},analyzing:{step:2,kicker:'Traitement Modal',title:'Analyse Acoustique AI en cours…',text:'Modal Acoustic AI étudie la prononciation et les difficultés de lecture mot par mot.'},receiving:{step:3,kicker:'Réception',title:'Réception des résultats…',text:'La réponse du service est reçue et vérifiée.'},preparing:{step:3,kicker:'Préparation du bilan',title:'Génération du bilan pédagogique…',text:'Les résultats reçus sont organisés pour préparer le bilan et les exercices adaptés.'},success:{step:4,kicker:'Analyse terminée',title:'Le bilan de lecture est prêt',text:'Les résultats ont été reçus. Ouverture du bilan…'},error:{step:0,kicker:'Analyse interrompue',title:'Le lot n’a pas pu être analysé',text:'Le lot local est conservé. Vous pouvez réessayer sans refaire les lectures.'}};
  const MODAL_STAGES=['checking','sending','analyzing','receiving','preparing'];
  function modalCopy(){const english=document.documentElement.lang==='en',model=acousticModelInfo?.model||{},metaVerified=acousticModelInfo?.metadata_verified===true&&model.base_developer_confirmed===true;const technologies=[{id:'modal',name:'Modal',logo:'/static/modal-mark.svg',role:english?'Execution infrastructure':'بنية التنفيذ'}];if(metaVerified)technologies.push({id:'meta',name:'Meta',logo:'/static/meta-platforms-logo.svg',role:english?'XLS-R base model':'نموذج XLS-R الأساسي'});return {title:t('aiModal.title','AI Acoustic Analysis'),eyebrow:t('aiModal.eyebrow','Secure grouped analysis'),visualNote:t('aiModal.visualNote',"Decorative waiting animation. It does not display the child's audio signal."),technologies,steps:MODAL_STAGES.map(id=>({id,label:t(`aiModal.steps.${id}.label`,id),message:t(`aiModal.steps.${id}.message`,'Processing…')})),success:{title:t('aiModal.success.title','Analysis completed'),message:t('aiModal.success.message','The results were received. The educational review is opening.')},error:{title:t('aiModal.error.title','The analysis could not be completed'),message:t('aiModal.error.message','The 15 local recordings are preserved. You can retry without recording them again.')},timeout:{title:t('aiModal.timeout.title','The browser stopped waiting'),message:t('aiModal.timeout.message','No response was received within the waiting period. Remote processing may still continue; the local recordings remain preserved.')},retry:t('aiModal.retry','Retry analysis'),close:t('aiModal.close','Return to the analysis page')}};
  function ensureAnalysisModal(){analysisModal||=new window.AIProcessingModal();return analysisModal;}
  function openAnalysisModal(stage,trigger){const copy=modalCopy();ensureAnalysisModal().open({...copy,stage,trigger});}
  function setAnalysisStage(stage,detail=''){
    analysisStage=stage;const config=ANALYSIS_STAGE[stage]||ANALYSIS_STAGE.ready,node=$('analysis-state'),flow=[...document.querySelectorAll('#analysis-flow [data-analysis-step]')],progress=$('analysis-progress'),busy=MODAL_STAGES.includes(stage);
    if(stage!=='error')analysisLastStep=Math.min(config.step,3);node.dataset.state=stage;node.querySelector('.analysis-state-kicker').textContent=config.kicker;$('analysis-status-title').textContent=config.title;$('batch-message').textContent=detail||config.text;$('batch-message').className=stage==='error'?'v3-message error':'v3-message';
    const completed=stage==='success'?4:Math.min(config.step,3);flow.forEach((item,index)=>{item.classList.toggle('done',stage==='success'||index<completed);item.classList.toggle('active',stage!=='success'&&stage!=='error'&&index===config.step);item.classList.toggle('error',stage==='error'&&index===analysisLastStep);});
    progress.setAttribute('aria-valuetext',config.title);progress.toggleAttribute('data-indeterminate',busy);if(busy)progress.removeAttribute('aria-valuenow');else progress.setAttribute('aria-valuenow',stage==='success'?'4':'0');progress.querySelector('i').style.width=busy?'36%':stage==='success'?'100%':'0';
    if(analysisModal?.isOpen&&busy){const copy=modalCopy();analysisModal.configure(copy);analysisModal.setStage(stage,copy.steps.find(item=>item.id===stage)?.message);}
  }
  async function discardStoredRecording(word){const record=recordings.get(word.word_id);if(!record)return;if(!confirm(`Annuler l’enregistrement de « ${word.text} » ? Il sera supprimé de cette séance et ne sera pas analysé.`))return;await window.acodyslexAudioStore.deleteWord(state.child.child_id,state.sessionId,word.word_id);recordings.delete(word.word_id);delete state.recordingMeta[word.word_id];state.analysisId=null;persist();await renderReady();}
  async function renderReady(){setCaptureState('ready_to_analyze');try{await backendPhase('ready_to_analyze');}catch{}const parent=$('recording-summary');parent.replaceChildren();for(const word of state.words){const record=recordings.get(word.word_id),row=document.createElement('div');row.className=`recording-row ${record?'':'missing'}`;const order=document.createElement('strong');order.textContent=formatNumber(word.order);const text=document.createElement('span');text.className='arabic-mini';text.dir='rtl';text.lang='ar';text.textContent=word.text;const status=document.createElement('span');status.textContent=record?`${formatNumber(record.audio_duration_ms/1000,{minimumFractionDigits:1,maximumFractionDigits:1})} s · prêt`:'Audio manquant';const actions=document.createElement('span');if(record){const play=document.createElement('button');play.className='secondary';play.textContent='Écouter';play.onclick=()=>{const url=URL.createObjectURL(record.blob),audio=new Audio(url);audio.onended=()=>URL.revokeObjectURL(url);void audio.play();};const discard=document.createElement('button');discard.className='secondary recording-discard';discard.textContent='Annuler';discard.setAttribute('aria-label',`Annuler l’enregistrement de ${word.text}`);discard.onclick=()=>discardStoredRecording(word).catch(error=>batchMessage(`Suppression impossible : ${error.message}`,'error'));actions.append(play,discard);}const redo=document.createElement('button');redo.className='secondary';redo.textContent='Recommencer';redo.onclick=async()=>{state.index=word.order-1;returnToReady=true;renderReading();show('reading');await retry();};actions.append(redo);row.append(order,text,status,actions);parent.append(row);}const count=recordings.size;$('ready-count').textContent=`${formatNumber(count)} / ${formatNumber(15)}`;$('analysis-child').textContent=state.child?.display_name||state.child?.child_id||'—';const button=$('analyze-batch');button.textContent='Lancer l’Analyse Acoustique AI';button.disabled=count!==15||!$('session-transfer').checked;setAnalysisStage(count===15?'ready':'incomplete');show('ready');void loadAcousticModelInfo();}
  async function analyzeBatch(){
    if(analysisInFlight||recordings.size!==15||!$('session-transfer').checked)return;
    analysisDetached=false;
    const button=$('analyze-batch'),copy=modalCopy();analysisInFlight=true;button.disabled=true;button.textContent='Analyse Acoustique AI en cours…';openAnalysisModal('checking',button);setAnalysisStage('checking');
    analysisController=new AbortController();analysisTimeout=setTimeout(()=>analysisController.abort('browser_timeout'),ANALYSIS_TIMEOUT_MS);
    try{
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      state.analysisId||=makeId('batch');persist();
      const manifest={analysis_id:state.analysisId,child_id:state.child.child_id,session_id:state.sessionId,words:state.words.map(w=>({word_id:w.word_id,unit_id:w.unit_id||w.word_id,unit_type:w.unit_type||'word',word_order:w.order,reference_text:w.text,expected_phonemes:w.expected_phonemes,phonemes_by_word:w.phonemes_by_word||[],word_count:w.word_count||1,max_recording_seconds:w.max_recording_seconds||10}))},form=new FormData();form.append('manifest_json',JSON.stringify(manifest));form.append('transfer_consent','true');for(const word of state.words)form.append('files',recordings.get(word.word_id).blob,`unit_${String(word.order).padStart(2,'0')}.wav`);
      setAnalysisStage('sending');analysisTimer=setTimeout(()=>analysisInFlight&&setAnalysisStage('analyzing'),450);
      const response=await api('/v1/reading/analyze-batch',{method:'POST',body:form,signal:analysisController.signal});
      if(analysisDetached)return;
      clearTimeout(analysisTimer);analysisTimer=null;clearTimeout(analysisTimeout);analysisTimeout=null;setAnalysisStage('receiving');
      await new Promise(resolve=>setTimeout(resolve,matchMedia('(prefers-reduced-motion: reduce)').matches?0:180));
      setAnalysisStage('preparing');state.globalSummary=response.global_summary;state.results=response.word_results.map((item,index)=>({word_id:item.word_id,unit_id:item.unit_id||item.word_id,unit_type:item.unit_type||state.words[index]?.unit_type||'word',text:item.reference_text,expected:item.expected_phonemes||[],expectedPhonemesArabic:state.words[index]?.expected_phonemes_ar||[],phonemesByWord:item.phonemes_by_word||state.words[index]?.phonemes_by_word||[],observed:item.predicted_phonemes||[],analysis_status:item.analysis_status,recognizedText:item.recognized_text||null,candidates:item.candidate_errors||[],lexicalCandidates:item.lexical_candidates||[],wordAlignment:item.word_alignment||[],acousticIndicators:item.acoustic_indicators||{},uncertainty:item.uncertainty||null}));activeReportIndex=0;persist();
      setAnalysisStage('success');analysisModal.showSuccess(copy.success);await new Promise(resolve=>setTimeout(resolve,matchMedia('(prefers-reduced-motion: reduce)').matches?0:420));analysisModal.close({restoreFocus:false});analysisInFlight=false;analysisController=null;await renderReport();$('report-title').setAttribute('tabindex','-1');$('report-title').focus({preventScroll:true});
    }catch(error){
      if(analysisDetached)return;
      const timedOut=analysisController?.signal.aborted===true;clearTimeout(analysisTimer);analysisTimer=null;clearTimeout(analysisTimeout);analysisTimeout=null;analysisInFlight=false;analysisController=null;const failure=timedOut?copy.timeout:copy.error;setAnalysisStage('error',failure.message);button.disabled=false;button.textContent='Réessayer l’Analyse Acoustique AI';analysisModal.showError({...failure,retryLabel:copy.retry,closeLabel:copy.close,kind:timedOut?'timeout':'error',onRetry:()=>void analyzeBatch(),onClose:()=>analysisModal.close()});
    }
  }

  const normalized=type=>type==='substitution'?'consonant_substitution':Object.hasOwn(LABELS,type)?type:null;
  const positiveInteger=value=>{const parsed=Number(value);return Number.isSafeInteger(parsed)&&parsed>0?Math.min(parsed,10000):1;};
  const reportPhrase=(ar,en)=>reportLang()==='en'?en:ar;
  // Both sequences use the active model's vocabulary. CTC/control markers never
  // occupy an analysis position or a visible phoneme cell.
  const technicalPhonemeTokens=new Set(['|','sil','[UNK]','[PAD]']);
  const phonemeTokens=value=>Array.isArray(value)?value.map(token=>String(token).trim()).filter(token=>token&&!technicalPhonemeTokens.has(token)):[];
  // Presentation-only map supplied by the verified active model. Raw tokens stay untouched.
  let arabicPhonemePresentation=Object.freeze({});
  function configurePhonemePresentation(entries){
    const presentation={};
    if(entries&&typeof entries==='object')for(const [token,entry] of Object.entries(entries)){
      if(typeof token!=='string'||!entry||typeof entry!=='object'||typeof entry.arabic!=='string'||!entry.arabic||typeof entry.name_ar!=='string'||!entry.name_ar)continue;
      presentation[token]={symbol:entry.arabic,name:entry.name_ar};
    }
    arabicPhonemePresentation=Object.freeze(presentation);
  }
  function bankPhonemePresentation(entries){
    const presentation={};
    if(Array.isArray(entries))for(const entry of entries){
      if(!entry||entry.mapping_status!=='documente_dans_recapitulatif'||typeof entry.symbol!=='string'||typeof entry.arabic!=='string'||!entry.arabic||typeof entry.name_ar!=='string'||!entry.name_ar)continue;
      presentation[entry.symbol]={symbol:entry.arabic,name:entry.name_ar};
    }
    return presentation;
  }
  const showArabicPhonemes=()=>$('phoneme-display-arabic')?.checked!==false;
  const arabicPhonemeInfo=token=>arabicPhonemePresentation[String(token)]||null;
  function phonemeDisplay(token,presentation=arabicPhonemePresentation){const raw=String(token);return showArabicPhonemes()?(presentation[raw]?.symbol||arabicPhonemeInfo(raw)?.symbol||raw):raw;}
  function phonemeForNote(token){const raw=String(token),info=arabicPhonemeInfo(raw);if(!showArabicPhonemes())return markedPhoneme(raw);if(info)return `صوت ${info.name} (${info.symbol})`;return `الفونيم ${markedPhoneme(raw)} غير معرّف في جدول العرض`;}
  function unifiedPhonemeTable(value,fallback='?',fallbackDirection='ltr',bankPresentation=[]){
    const tokens=phonemeTokens(value),table=document.createElement('div'),presentation=bankPhonemePresentation(bankPresentation);table.className='report-phoneme-table';table.dataset.phonemeSource=Object.keys(presentation).length?'reading-bank':'active-model';table.dir='rtl';
    if(!tokens.length){const empty=document.createElement('span');empty.className='report-phonemes report-phonemes-empty';empty.dir=fallbackDirection;empty.lang=fallbackDirection==='rtl'?'ar':'und';empty.textContent=fallback;table.append(empty);return table;}
    table.style.setProperty('--phoneme-count',String(tokens.length));
    const indexes=document.createElement('div');indexes.className='report-phoneme-index-row';indexes.setAttribute('aria-label',reportPhrase('فهرس الفونيمات','Phoneme indexes'));
    const phonemes=document.createElement('div');phonemes.className='report-phonemes';phonemes.setAttribute('aria-label',tokens.join(' '));
    tokens.forEach((token,index)=>{const indexCell=document.createElement('span');indexCell.className='report-phoneme-index';indexCell.textContent=String(index+1);indexes.append(indexCell);const phonemeCell=document.createElement('span');phonemeCell.className='report-phoneme-token';phonemeCell.dataset.rawPhoneme=token;phonemeCell.title=phonemeForNote(token);phonemeCell.textContent=phonemeDisplay(token,presentation);phonemes.append(phonemeCell);});
    table.append(indexes,phonemes);return table;
  }
  const markedPhoneme=value=>`/${value}/`;
  function phonemePosition(index,length){
    if(index===0)return reportPhrase('\u0641\u064a \u0628\u062f\u0627\u064a\u0629 \u0627\u0644\u062a\u0633\u0644\u0633\u0644','at the start of the sequence');
    if(index>=length-1)return reportPhrase('\u0641\u064a \u0646\u0647\u0627\u064a\u0629 \u0627\u0644\u062a\u0633\u0644\u0633\u0644','at the end of the sequence');
    return reportPhrase(`\u0641\u064a \u0627\u0644\u0645\u0648\u0636\u0639 ${formatNumber(index+1)}`,`at position ${index+1}`);
  }
  function comparePhonemes(expectedValue,observedValue){
    const expected=phonemeTokens(expectedValue),observed=phonemeTokens(observedValue);
    if(!expected.length||!observed.length)return {kind:'insufficient',messages:[reportPhrase('\u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u0641\u0648\u0646\u064a\u0645\u064a\u0629 \u063a\u064a\u0631 \u0643\u0627\u0641\u064a\u0629 \u0644\u0644\u0645\u0642\u0627\u0631\u0646\u0629.','Insufficient phoneme data for comparison.')]};
    const rows=Array.from({length:expected.length+1},()=>Array(observed.length+1));
    for(let i=expected.length;i>=0;i--)for(let j=observed.length;j>=0;j--){
      if(i===expected.length&&j===observed.length){rows[i][j]={cost:0,ops:[]};continue;}
      const choices=[];
      if(i<expected.length&&j<observed.length&&expected[i]===observed[j]){const next=rows[i+1][j+1];choices.push({cost:next.cost,ops:next.ops});}
      if(i<expected.length&&j<observed.length){const next=rows[i+1][j+1];choices.push({cost:next.cost+1,ops:[{type:'substitution',index:i,expected:expected[i],observed:observed[j]},...next.ops]});}
      if(i<expected.length){const next=rows[i+1][j];choices.push({cost:next.cost+1,ops:[{type:'omission',index:i,expected:expected[i]},...next.ops]});}
      if(j<observed.length){const next=rows[i][j+1];choices.push({cost:next.cost+1,ops:[{type:'insertion',index:i,observed:observed[j]},...next.ops]});}
      if(i+1<expected.length&&j+1<observed.length&&expected[i]===observed[j+1]&&expected[i+1]===observed[j]){const next=rows[i+2][j+2];choices.push({cost:next.cost+1,ops:[{type:'inversion',index:i,expected:[expected[i],expected[i+1]],observed:[observed[j],observed[j+1]]},...next.ops]});}
      rows[i][j]=choices.reduce((best,current)=>current.cost<best.cost?current:best);
    }
    const ops=rows[0][0].ops;
    if(!ops.length)return {kind:'match',messages:[reportPhrase('\u0644\u0627 \u064a\u0648\u062c\u062f \u0641\u0631\u0642 \u0635\u0648\u062a\u064a \u0645\u0644\u062d\u0648\u0638.','No notable phonemic difference.')]};
    return {kind:'difference',messages:ops.map(operation=>{
      const position=phonemePosition(operation.index,expected.length);
      if(operation.type==='substitution')return reportPhrase(`\u0627\u0633\u062a\u0628\u062f\u0627\u0644 ${phonemeForNote(operation.expected)} \u0628\u0640 ${phonemeForNote(operation.observed)} ${position}`,`Substitution of ${phonemeForNote(operation.expected)} with ${phonemeForNote(operation.observed)} ${position}`);
      if(operation.type==='omission')return reportPhrase(`\u062d\u0630\u0641 ${phonemeForNote(operation.expected)} ${position}`,`Omission of ${phonemeForNote(operation.expected)} ${position}`);
      if(operation.type==='inversion')return reportPhrase(`\u0642\u0644\u0628 \u062a\u0631\u062a\u064a\u0628 ${phonemeForNote(operation.expected[0])} \u0648 ${phonemeForNote(operation.expected[1])} ${position}`,`Inversion of ${phonemeForNote(operation.expected[0])} and ${phonemeForNote(operation.expected[1])} ${position}`);
      const before=expected[operation.index-1],after=expected[operation.index];
      const context=before&&after?reportPhrase(`\u0628\u064a\u0646 ${markedPhoneme(before)} \u0648 ${markedPhoneme(after)}`,`between ${markedPhoneme(before)} and ${markedPhoneme(after)}`):position;
      return reportPhrase(`\u0625\u0636\u0627\u0641\u0629 ${phonemeForNote(operation.observed)} ${context}`,`Insertion of ${phonemeForNote(operation.observed)} ${context}`);
    })};
  }
  const reportCopy={
    en:{eyebrow:'Reading report',title:'Reading Report',intro:'Review each word and its recording. AI suggestions remain unverified until a companion reviews them.',session:'Session',words:'words',wordAnalysis:'Word analysis',filterHint:'Choose which words to review',filter:'Filter',all:'All words',candidateFilter:'AI candidates',confirmedFilter:'Confirmed observations',total:'Words in session',usable:'Usable analyses',ai:'AI observations',confirmed:'Confirmed observations',totalDesc:'Number of recorded words in this session.',usableDesc:'Recordings with an acoustic analysis available for review.',aiDesc:'Candidate observations from the model that need human review.',confirmedDesc:'Observations explicitly reviewed and confirmed by a companion.',explanation:'Model output is an acoustic suggestion, not ground truth. Listen to the recording and compare the sounds before deciding.',reference:'Reference word',sentenceReference:'Reference sentence',model:'Model output',comparison:'Phoneme comparison',targetPhoneme:'Target',modelPhoneme:'Model',progress:'Recording progress',candidates:'Candidate observations',play:'Play recording',pause:'Pause recording',missingAudio:'Recording unavailable for this session.',noCandidates:'The model suggested no acoustic difference for this word.',noPhonemes:'No phonemes are available for comparison.',pending:'AI candidate ? awaiting review',verified:'Confirmed by companion',rejected:'Rejected by companion',reviewed:'Word reviewed',verify:'Verify Analysis',edit:'Edit',reject:'Reject',choose:'Observation type',deleteCandidate:'Delete note',deleteCandidateConfirm:'Delete this candidate observation? This cannot be undone for this local review.',continue:'Continue to seven activities',continueBusy:'Preparing activities?',pendingWork:'Review every word and confirm or reject each candidate before continuing.',audioTime:'Recording length',clear:'No candidate observations'}
  };
  const reportLang=()=>document.documentElement.lang==='en'?'en':'ar';
  const reportExitText=()=>reportLang()==='en'?'Leave review':'\u0625\u0646\u0647\u0627\u0621 \u0627\u0644\u0645\u0631\u0627\u062c\u0639\u0629';
  const reportExitConfirm=()=>reportLang()==='en'?'Leave this review and return to profiles? The unfinished session will be ended.':'\u0647\u0644 \u062a\u0631\u064a\u062f \u0625\u0646\u0647\u0627\u0621 \u0627\u0644\u0645\u0631\u0627\u062c\u0639\u0629 \u0648\u0627\u0644\u0639\u0648\u062f\u0629 \u0625\u0644\u0649 \u0627\u0644\u0645\u0644\u0641\u0627\u062a\u061f \u0633\u064a\u062a\u0645 \u0625\u0646\u0647\u0627\u0621 \u0627\u0644\u062c\u0644\u0633\u0629 \u063a\u064a\u0631 \u0627\u0644\u0645\u0643\u062a\u0645\u0644\u0629.';
  const rt=key=>key==='exit'?reportExitText():reportLang()==='en'?(reportCopy.en[key]||key):t(`report.${key}`,reportCopy.en[key]||key);
  const learningGuideLabel=()=>document.documentElement.lang==='en'?'Download Learning Guide (PDF)':'تحميل الدليل التربوي PDF';
  function downloadLearningGuide(sessionId=state.sessionId){if(!sessionId)return;const lang=document.documentElement.lang==='en'?'en':'ar';window.open(`/v1/reports/sessions/${encodeURIComponent(sessionId)}/pdf?lang=${lang}`,'_blank','noopener');}
  const candidateStatus=c=>!c.length?'clear':c.some(x=>x.reviewStatus==='pending')?'pending':c.every(x=>x.reviewStatus==='rejected')?'rejected':c.every(x=>x.reviewStatus==='confirmed')?'human':'mixed';
  let activeReportIndex=0;
  function dedupeCandidates(candidates=[]){
    const unique=new Map();
    for(const candidate of candidates){
      const type=normalized(candidate.error_type||candidate.type)||(candidate.error_type||candidate.type||'unknown');
      const key=String(type);
      if(!unique.has(key)){unique.set(key,{...candidate,error_type:type,type,reviewStatus:candidate.reviewStatus||'pending'});continue;}
      const current=unique.get(key),statuses=[current.reviewStatus,candidate.reviewStatus||'pending'];
      current.count=positiveInteger(current.count)+positiveInteger(candidate.count);
      current.reviewStatus=statuses.every(status=>status==='confirmed')?'confirmed':statuses.every(status=>status==='rejected')?'rejected':'pending';
      current.reviewPayload=current.reviewStatus==='confirmed'?(current.reviewPayload||candidate.reviewPayload||null):null;
    }
    return [...unique.values()];
  }
  const visibleReportIndexes=filter=>state.results.map((item,index)=>({item,index})).filter(({item})=>filter==='candidates'?(item.candidates||[]).length:filter==='confirmed'?['human','mixed'].includes(item.reviewStatus):true).map(({index})=>index);
  function moveToNextReportWord(index){const visible=visibleReportIndexes($('report-filter').value),position=visible.indexOf(index);if(position>=0&&position<visible.length-1)activeReportIndex=visible[position+1];}
  const updateReportContinue=()=>{const pending=state.results.some(i=>{const candidates=i.candidates||[];return candidates.length?candidates.some(c=>!['confirmed','rejected'].includes(c.reviewStatus)):!i.reviewedByCompanion;});$('verify-report').disabled=pending;$('verify-report').title=pending?rt('pendingWork'):'';};
  const observationBase=c=>({error_type:normalized(c.error_type||c.type),target:null,observed:null,count:positiveInteger(c.count),opportunities:Math.max(15,positiveInteger(c.count)),distinct_items:1,meaning_changed:false,provenance:'v032_batch_accompanist_review',language_variety:'ar',dialect_context:null});
  function reportMetric(parent,title,value,description,kind){const card=document.createElement('article');card.className=`report-metric ${kind}`;const label=document.createElement('span');label.textContent=title;const n=document.createElement('strong');n.className='localized-number';n.textContent=value;const note=document.createElement('p');note.textContent=description;card.append(label,n,note);parent.append(card);}
  function sentenceEvidence(item){
    if(item.unit_type!=='short_sentence')return null;
    const section=document.createElement('section');section.className='sentence-evidence report-output';
    const title=document.createElement('span');title.className='report-label';title.textContent=reportLang()==='en'?'Sentence evidence':'\u0645\u0624\u0634\u0631\u0627\u062a \u0627\u0644\u062c\u0645\u0644\u0629';section.append(title);
    const rows=[];
    if(item.lexicalCandidates?.length)rows.push(`${reportLang()==='en'?'Candidates':'\u0645\u0642\u062a\u0631\u062d\u0627\u062a'}: ${item.lexicalCandidates.map(candidate=>candidate.text||candidate.transcript||candidate.value).filter(Boolean).join(' · ')}`);
    if(item.wordAlignment?.length)rows.push(`${reportLang()==='en'?'Alignment':'\u0627\u0644\u0645\u0648\u0627\u0632\u0627\u0629'}: ${item.wordAlignment.map(pair=>`${pair.reference||pair.expected||'?'} → ${pair.observed||pair.actual||'?'}`).join(' · ')}`);
    const indicators=Object.entries(item.acousticIndicators||{}).filter(([,value])=>['string','number','boolean'].includes(typeof value));
    if(indicators.length)rows.push(`${reportLang()==='en'?'Acoustic indicators':'\u0645\u0624\u0634\u0631\u0627\u062a \u0635\u0648\u062a\u064a\u0629'}: ${indicators.map(([key,value])=>`${key}: ${value}`).join(' · ')}`);
    const detail=document.createElement('p');detail.textContent=rows.length?rows.join('\n'):(reportLang()==='en'?'No sentence-specific evidence returned.':'\u0644\u0645 \u064a\u064f\u0631\u062c\u0650\u0639 \u0627\u0644\u0646\u0645\u0648\u0630\u062c \u062f\u0644\u064a\u0644\u064b\u0627 \u062e\u0627\u0635\u064b\u0627 \u0628\u0627\u0644\u062c\u0645\u0644\u0629.');detail.style.whiteSpace='pre-line';section.append(detail);return section;
  }
  function renderReportCards(){
    const report=$('child-report'),nav=$('report-word-nav'),filter=$('report-filter').value;report.querySelectorAll('audio').forEach(audio=>{audio.pause();if(audio.src.startsWith('blob:'))URL.revokeObjectURL(audio.src);});report.replaceChildren();nav.replaceChildren();
    state.results.forEach(item=>{item.candidates=dedupeCandidates(item.candidates||[]);item.reviewStatus=!item.candidates.length&&item.reviewedByCompanion?'reviewed':candidateStatus(item.candidates);});
    const visible=visibleReportIndexes(filter);if(!visible.includes(activeReportIndex))activeReportIndex=visible[0]??0;
    for(const index of visible){const item=state.results[index],status=item.reviewStatus,button=document.createElement('button');button.type='button';button.textContent=formatNumber(item.word_order||index+1);button.setAttribute('aria-label',`${rt('reference')} ${formatNumber(item.word_order||index+1)}`);if(index===activeReportIndex)button.setAttribute('aria-current','step');button.classList.toggle('reviewed',['human','reviewed','mixed'].includes(status));button.classList.toggle('rejected',status==='rejected');button.onclick=()=>{activeReportIndex=index;renderReportCards();const current=report.querySelector('.word-card');current?.setAttribute('tabindex','-1');current?.focus({preventScroll:true});};nav.append(button);}
    state.results.forEach((item,index)=>{
      item.candidates=(item.candidates||[]).map(c=>({...c,reviewStatus:c.reviewStatus||'pending'}));const status=!item.candidates.length&&item.reviewedByCompanion?'reviewed':candidateStatus(item.candidates);item.reviewStatus=status;
      if(filter==='candidates'&&!item.candidates.length||filter==='confirmed'&&!['human','mixed'].includes(status))return;
      if(index!==activeReportIndex)return;
      const card=document.createElement('article');card.className='word-card';card.dataset.reviewStatus=status;card.dataset.wordId=item.word_id;
      const head=document.createElement('div');head.className='word-card-head';const number=document.createElement('span');number.className='word-number localized-number';number.textContent=formatNumber(item.word_order||index+1);const badge=document.createElement('span');badge.className=`report-status ${status}`;badge.textContent=status==='human'?rt('verified'):status==='rejected'?rt('rejected'):status==='reviewed'||status==='mixed'?rt('reviewed'):item.candidates.length?rt('pending'):rt('clear');head.append(number,badge);card.append(head);
      const ref=document.createElement('section');ref.className='report-output report-reference-output';const refLabel=document.createElement('span');refLabel.className='report-label';refLabel.textContent=item.unit_type==='short_sentence'?rt('sentenceReference'):rt('reference');const word=document.createElement('span');word.className='report-arabic-word';word.lang='ar';word.dir='rtl';word.textContent=item.text||'?';ref.append(refLabel,word);
      const grid=document.createElement('section');grid.className='report-output-grid report-analysis-layout';const model=document.createElement('section');model.className='report-output report-phoneme-row';const ml=document.createElement('span');ml.className='report-label';ml.textContent=rt('model');const hasPredictedPhonemes=phonemeTokens(item.observed).length>0;const modelFallback=item.recognizedText||rt('noPhonemes');const modelDirection=!hasPredictedPhonemes&&/[\u0600-\u06ff]/.test(modelFallback)?'rtl':'ltr';const modelTable=unifiedPhonemeTable(item.observed,modelFallback,modelDirection);modelTable.classList.add('report-model-phonemes');model.append(ml,modelTable);
      const target=document.createElement('section');target.className='report-output report-phoneme-row';const targetLabel=document.createElement('span');targetLabel.className='report-label';targetLabel.textContent=rt('targetPhoneme');const targetTable=unifiedPhonemeTable(item.expected,'?','ltr',item.expectedPhonemesArabic);targetTable.classList.add('report-target-phonemes');target.append(targetLabel,targetTable);
      const observation=document.createElement('section');observation.className='report-output report-observation';const observationLabel=document.createElement('span');observationLabel.className='report-label';observationLabel.textContent=reportPhrase('\u0645\u0644\u0627\u062d\u0638\u0629','Observation');const phonemeNote=comparePhonemes(item.expected,item.observed);const noteList=document.createElement('div');noteList.className=`report-phoneme-note ${phonemeNote.kind}`;phonemeNote.messages.forEach(message=>{const line=document.createElement('p');line.textContent=message;noteList.append(line);});observation.append(observationLabel,noteList);
      const audioRecord=recordings.get(item.word_id),audioSection=document.createElement('section');audioSection.className='report-output report-audio';const audioTitle=document.createElement('span');audioTitle.className='report-label';audioTitle.textContent=reportPhrase('\u0627\u0644\u0635\u0648\u062a \u0627\u0644\u0645\u0633\u062c\u0644','Recorded sound');audioSection.append(audioTitle);
      if(audioRecord?.blob){const player=document.createElement('div');player.className='report-audio-player';player.dir='ltr';const audio=document.createElement('audio');audio.preload='metadata';audio.src=URL.createObjectURL(audioRecord.blob);const play=document.createElement('button');play.type='button';play.className='audio-play';play.setAttribute('aria-label',rt('play'));const range=document.createElement('input');range.type='range';range.min='0';range.max='1000';range.value='0';range.className='audio-progress';range.setAttribute('aria-label',rt('progress'));const clock=document.createElement('output');clock.className='audio-clock';const fmt=s=>`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;const sync=()=>{const d=audio.duration||Number(audioRecord.audio_duration_ms||0)/1000;range.value=d?String(Math.round(audio.currentTime/d*1000)):'0';clock.value=`${fmt(audio.currentTime||0)} / ${fmt(d||0)}`;play.setAttribute('aria-label',audio.paused?rt('play'):rt('pause'));play.classList.toggle('playing',!audio.paused);};play.onclick=()=>audio.paused?audio.play().catch(()=>{}):audio.pause();range.oninput=()=>{if(audio.duration)audio.currentTime=audio.duration*Number(range.value)/1000;};['loadedmetadata','timeupdate','durationchange','play','pause','ended'].forEach(e=>audio.addEventListener(e,sync));player.append(audio,play,range,clock);audioSection.append(player);sync();}else{const missing=document.createElement('p');missing.className='audio-missing';missing.textContent=rt('missingAudio');audioSection.append(missing);}const header=document.createElement('div');header.className='report-analysis-header';header.append(ref,audioSection);const phonemeRows=document.createElement('div');phonemeRows.className='report-phoneme-rows';phonemeRows.append(model,target);grid.append(header,phonemeRows,observation);card.append(grid);
      const actions=document.createElement('div');actions.className='word-card-actions';const verifyButton=document.createElement('button');verifyButton.type='button';verifyButton.className='report-verify-word';verifyButton.textContent=status==='human'?rt('verified'):status==='reviewed'||status==='mixed'?rt('reviewed'):rt('verify');verifyButton.disabled=status==='human'||status==='reviewed'||status==='mixed';verifyButton.onclick=()=>void verifyWord(index,verifyButton,badge);const rejectButton=document.createElement('button');rejectButton.type='button';rejectButton.className='report-reject-word';rejectButton.textContent=rt('reject');rejectButton.disabled=!item.candidates.length||status==='rejected';rejectButton.onclick=()=>{item.candidates.forEach(c=>{c.reviewStatus='rejected';c.reviewPayload=null;});persist();renderReportCards();};actions.append(verifyButton,rejectButton);card.append(actions);report.append(card);
    });
  }
  async function renderReport(){
    const phonemeDisplayLabel=$('phoneme-display-label');if(phonemeDisplayLabel)phonemeDisplayLabel.textContent=reportPhrase('عرض الفونيمات بالعربية','Show Arabic phoneme notation');
    try{await backendPhase('review');}catch{}document.querySelectorAll('#v3-review [data-report]').forEach(n=>{n.textContent=rt(n.dataset.report);});$('download-learning-guide').textContent=learningGuideLabel();$('report-session-count').textContent=formatNumber(state.words?.length||state.results.length||15);
    state.results.forEach(item=>{item.candidates=dedupeCandidates(item.candidates||[]);item.reviewStatus=!item.candidates.length&&item.reviewedByCompanion?'reviewed':candidateStatus(item.candidates);});
    const summary=state.globalSummary||{},parent=$('report-summary'),usable=summary.analyzed_words??state.results.filter(i=>i.analysis_status==='ok').length,ai=state.results.reduce((n,i)=>n+(i.candidates||[]).length,0),confirmed=state.results.reduce((n,i)=>n+(i.candidates||[]).filter(c=>c.reviewStatus==='confirmed').length,0);parent.replaceChildren();
    reportMetric(parent,rt('total'),formatNumber(state.results.length||15),rt('totalDesc'),'total');reportMetric(parent,rt('usable'),formatNumber(usable),rt('usableDesc'),'usable');reportMetric(parent,rt('ai'),formatNumber(ai),rt('aiDesc'),'ai');reportMetric(parent,rt('confirmed'),formatNumber(confirmed),rt('confirmedDesc'),'confirmed');$('result-explanation').textContent=rt('explanation');renderReportCards();updateReportContinue();$('verify-report').hidden=!!state.reportReadOnly;document.querySelectorAll('#child-report .word-card-actions,#child-report .candidate-edit,#child-report .candidate-delete').forEach(node=>node.hidden=!!state.reportReadOnly);show('review');
  }
  async function verifyWord(index,button,badge){
    const item=state.results[index];if(!item)return;button.disabled=true;button.setAttribute('aria-busy','true');
    try{for(const c of item.candidates||[]){if(c.reviewStatus==='confirmed')continue;if(c.reviewStatus==='rejected')continue;const base=observationBase(c);if(!base.error_type)throw new Error('Unsupported observation type');const receipt=await api('/v1/recommendations/observations/verify',json('POST',{...base,reviewer_id:`adult_${state.child.child_id}`.slice(0,64),human_confirmed:true}));c.reviewPayload={...base,verification_status:'human_verified',verification_provenance:'human_review',verified_by:receipt.verified_by,verification_receipt:receipt.verification_receipt};c.reviewStatus='confirmed';persist();}item.reviewedByCompanion=true;item.reviewStatus=candidateStatus(item.candidates);if(!item.candidates.length)item.reviewStatus='reviewed';persist();badge.className=`report-status ${item.reviewStatus}`;badge.textContent=item.reviewStatus==='human'?rt('verified'):rt('reviewed');$('report-summary').querySelector('.report-metric.confirmed strong').textContent=formatNumber(state.results.reduce((n,r)=>n+(r.candidates||[]).filter(c=>c.reviewStatus==='confirmed').length,0));moveToNextReportWord(index);renderReportCards();}
    catch(error){button.disabled=false;$('receipt-message').textContent=error.message;$('receipt-message').className='v3-message error';}finally{button.removeAttribute('aria-busy');updateReportContinue();}
  }
  async function verify(){
    const button=$('verify-report');if(button.disabled)return;button.disabled=true;button.setAttribute('aria-busy','true');$('receipt-message').textContent=rt('continueBusy');$('receipt-message').className='v3-message';
    try{const observations=state.results.flatMap(i=>(i.candidates||[]).filter(c=>c.reviewStatus==='confirmed'&&c.reviewPayload).map(c=>c.reviewPayload));if(observations.length)await api(`/v1/progress/sessions/${state.sessionId}/observations`,json('POST',{submission_id:makeId('review'),child_id:state.child.child_id,observations}));const recs=await api(`/v1/progress/children/${state.child.child_id}/recommendations?session_id=${encodeURIComponent(state.sessionId)}`);state.exercises=recs.recommended_exercises.slice(0,7);if(state.exercises.length!==7)throw new Error('The recommendation engine did not return seven activities.');state.exerciseIndex=0;state.exerciseDrafts={};state.attempts=[];await api(`/v1/progress/sessions/${state.sessionId}/recommendations`,json('POST',{child_id:state.child.child_id,exercise_ids:state.exercises.map(i=>i.id)}));await backendPhase('remediation');renderExercises();show('remediation');}
    catch(error){$('receipt-message').textContent=error.message;$('receipt-message').className='v3-message error';button.disabled=false;}finally{button.removeAttribute('aria-busy');}
  }
  function renderExercises(){
    const completed=state.attempts.filter(Boolean).length;
    if(completed===7){$('exercise-list').innerHTML='<div class="completion-card"><span aria-hidden="true">✓</span><h3>Bravo, les sept activités sont terminées !</h3><p>Chaque effort compte. La séance peut maintenant être enregistrée.</p></div>';updateExercise();return;}
    state.exerciseIndex=Math.max(completed,Math.min(state.exerciseIndex,6));
    const exercise=state.exercises[state.exerciseIndex];if(!exercise)return;
    window.acodyslexRemediation.render({container:$('exercise-list'),exercise,position:state.exerciseIndex+1,total:7,draft:state.exerciseDrafts[exercise.id]||{},onDraft:draft=>{state.exerciseDrafts[exercise.id]={...(state.exerciseDrafts[exercise.id]||{}),...draft};persist();},onComplete:result=>saveAttempt(state.exerciseIndex,result)});
    updateExercise();
  }
  async function saveAttempt(index,result){
    if(state.attempts[index])return;const exercise=state.exercises[index],draft=state.exerciseDrafts[exercise.id]||{};draft.attemptId||=makeId('attempt');draft.completedAt||=new Date().toISOString();state.exerciseDrafts[exercise.id]=draft;persist();
    try{
      state.attempts[index]=await api(`/v1/progress/sessions/${state.sessionId}/attempts`,json('POST',{attempt_id:draft.attemptId,child_id:state.child.child_id,exercise_id:exercise.id,skill:exercise.skill,correct_count:result.correct,total_count:1,assistance_level:result.assistance,evaluation_context:'practice',item_set_id:`${state.sessionId}_${exercise.id}`,novel_items:exercise.recommendation_kind!=='targeted',activity_family:exercise.activity_family,interaction_attempts:result.interactionAttempts,help_used:result.helpUsed,outcome:result.outcome,completed_at:draft.completedAt}));
      delete state.exerciseDrafts[exercise.id];state.exerciseIndex=Math.min(6,index+1);persist();renderExercises();
    }catch(error){alert(`Tentative non enregistrée : ${error.message}`);}
  }
  function updateExercise(){const count=state.attempts.filter(Boolean).length;$('exercise-progress').textContent=count===7?`${formatNumber(7)} activités terminées`:`Activité ${formatNumber(Math.min(count+1,7))} sur ${formatNumber(7)}`;document.querySelectorAll('#exercise-steps li').forEach((step,index)=>{step.textContent=formatNumber(index+1);step.classList.toggle('done',index<count);step.classList.toggle('current',index===count&&count<7);step.setAttribute('aria-label',index<count?`Activité ${formatNumber(index+1)} terminée`:index===count&&count<7?`Activité ${formatNumber(index+1)} en cours`:`Activité ${formatNumber(index+1)} à venir`);});$('complete-session').disabled=count!==7;$('complete-session').hidden=count!==7;$('abandon-remediation').hidden=count===7;}
  async function abandonRemediation(){
    if(!confirm('Abandonner ce parcours ? Les activités déjà terminées restent enregistrées. Les autres ne seront pas comptées comme des échecs.'))return;
    try{await backendPhase('abandoned');localStorage.removeItem(STORE);Object.assign(state,{phase:'home',child:null,sessionId:null,words:[],index:0,results:[],globalSummary:null,exercises:[],attempts:[],exerciseIndex:0,exerciseDrafts:{},analysisId:null,recordingMeta:{}});show('home');await loadProfiles();}catch(error){alert(`Abandon impossible : ${error.message}`);}
  }
  async function leaveRemediation(){
    try{await backendPhase('remediation');await window.acodyslexLegacyAudio.release?.();show('home');await loadProfiles();}catch(error){alert(`Retour aux profils impossible : ${error.message}`);}
  }
  async function leaveAnalysis(){
    analysisDetached=true;analysisController?.abort('user_left_analysis');clearTimeout(analysisTimer);analysisTimer=null;clearTimeout(analysisTimeout);analysisTimeout=null;analysisInFlight=false;analysisController=null;analysisModal?.close({restoreFocus:false});await window.acodyslexLegacyAudio.release?.();show('home');await loadProfiles();
  }
  async function complete(){try{const result=await api(`/v1/progress/sessions/${state.sessionId}/complete`,json('POST',{child_id:state.child.child_id,completed_at:new Date().toISOString()}));$('completion-text').textContent=`${state.child.display_name||state.child.child_id} a lu ${formatNumber(15)} mots et terminé ${formatNumber(7)} activités.`;renderSkills(result.profile.skills);show('completed');}catch(error){alert(`Clôture impossible : ${error.message}`);}}

  /* V0.5 overrides: eight independent activities replace the linear seven-exercise path. */
  const activityLanguage=()=>document.documentElement.lang==='en'?'en':'ar';
  const activityText=(ar,en)=>activityLanguage()==='en'?en:ar;
  const allActivityTasks=()=>Object.values(state.activities||{}).flatMap(activity=>activity.tasks||[]).length;
  const completedActivityTasks=()=>Object.values(state.activities||{}).reduce((total,activity)=>total+Object.keys(activity.completed||{}).filter(key=>key.startsWith(`${activity.run}:`)).length,0);
  function renderActivityLibrary(){
    const done=completedActivityTasks(),total=allActivityTasks();$('activity-eyebrow').textContent=activityText('الأنشطة التعليمية','Learning activities');$('exercise-title').textContent=activityText('اختر نشاطًا','Choose an activity');$('exercise-progress').textContent=`${formatNumber(done)} / ${formatNumber(total)}`;$('back-to-activities').hidden=true;$('exercise-steps').hidden=true;$('pause-remediation').hidden=true;$('complete-session').hidden=done!==total||!total;$('complete-session').disabled=done!==total||!total;$('abandon-remediation').hidden=false;$('abandon-remediation').textContent=activityText('إنهاء الأنشطة','End activities');$('v3-remediation').classList.add('activity-library');$('v3-remediation').classList.remove('activity-detail');window.acodyslexActivityLibrary.renderGrid({container:$('exercise-list'),activities:state.activities,language:activityLanguage(),onOpen:openActivity,onRestart:restartActivity});
  }
  function openActivity(activityId){const activity=state.activities?.[activityId];if(!activity)return;activity.status='in_progress';state.activeActivityId=activityId;state.remediationPaused=false;persist();renderExercises();}
  function restartActivity(activityId){const activity=state.activities?.[activityId];if(!activity)return;activity.run=(activity.run||1)+1;activity.current=0;activity.status='in_progress';activity.drafts={};activity.completed={};state.activeActivityId=activityId;state.remediationPaused=false;persist();renderExercises();}
  function renderExercises(){
    if(!Object.keys(state.activities||{}).length&&state.exercises?.length===7)state.activities=window.acodyslexActivityLibrary.createPlan(state.exercises,state.sessionId);if(!state.activeActivityId){renderActivityLibrary();return;}const activity=state.activities[state.activeActivityId];if(!activity){state.activeActivityId=null;renderActivityLibrary();return;}const total=activity.tasks.length,current=Math.min(activity.current||0,total);if(state.remediationPaused){$('exercise-list').replaceChildren();const pause=document.createElement('section');pause.className='activity-paused';const title=document.createElement('h3');title.textContent=activityText('النشاط متوقف مؤقتًا','Activity paused');const text=document.createElement('p');text.textContent=activityText('حُفظت إجابتك الحالية. يمكنك المتابعة عندما تكون مستعدًا.','Your current answer is saved. Resume when ready.');const resume=document.createElement('button');resume.type='button';resume.textContent=activityText('متابعة','Resume');resume.onclick=()=>{state.remediationPaused=false;persist();renderExercises();};pause.append(title,text,resume);$('exercise-list').append(pause);return;}if(current>=total){activity.status='completed';state.activeActivityId=null;persist();renderActivityLibrary();return;}const task=activity.tasks[current],exercise={id:task.taskId,skill:task.skill,activity_family:task.displayFamily||activity.family,activity_family_label_fr:activity.ar,title_fr:activity.ar,objective_fr:activity.descriptionAr,instruction_ar:activityText('اطلب من الطفل إكمال التمرين ثم تحقّق من إجابته.','Ask the child to complete the exercise, then check the answer.'),example_ar:'',interaction:{kind:task.kind,prompt:task.prompt,options:task.options,answer:task.answer,tokens:task.tokens,items:task.items,hint:activityText('شجّع الطفل على المحاولة بهدوء قبل تقديم المساعدة.','Encourage a calm attempt before offering help.')},audio:{status:'not_required'}};$('activity-eyebrow').textContent=activity.ar;$('exercise-title').textContent=activityText(activity.ar,activity.en);$('exercise-progress').textContent=activityText(`التمرين ${formatNumber(current+1)} من ${formatNumber(total)}`,`Exercise ${formatNumber(current+1)} of ${formatNumber(total)}`);$('back-to-activities').hidden=false;$('exercise-steps').hidden=true;$('pause-remediation').hidden=false;$('pause-remediation').textContent=activityText('إيقاف مؤقت','Pause');$('complete-session').hidden=true;$('abandon-remediation').hidden=false;$('abandon-remediation').textContent=activityText('إنهاء الأنشطة','End activities');$('v3-remediation').classList.remove('activity-library');$('v3-remediation').classList.add('activity-detail');window.acodyslexRemediation.render({container:$('exercise-list'),exercise,position:current+1,total,draft:activity.drafts?.[`${activity.run}:${task.taskId}`]||{},onDraft:draft=>{activity.drafts||={};activity.drafts[`${activity.run}:${task.taskId}`]={...(activity.drafts[`${activity.run}:${task.taskId}`]||{}),...draft};persist();},onComplete:result=>saveActivityAttempt(activity,task,result)});
  }
  async function saveActivityAttempt(activity,task,result){const key=`${activity.run}:${activity.current}`;if(activity.completed?.[key])return;const draft=activity.drafts?.[`${activity.run}:${task.taskId}`]||{},attemptId=draft.attemptId||makeId('attempt'),completedAt=draft.completedAt||new Date().toISOString();activity.drafts||={};activity.drafts[`${activity.run}:${task.taskId}`]={...draft,attemptId,completedAt};persist();try{const saved=await api(`/v1/progress/sessions/${state.sessionId}/attempts`,json('POST',{attempt_id:attemptId,child_id:state.child.child_id,activity_id:activity.id,exercise_id:task.catalogId,skill:task.skill,correct_count:result.correct,total_count:1,assistance_level:result.assistance,evaluation_context:'practice',item_set_id:`v05_${activity.id}_r${activity.run}_t${activity.current}`,novel_items:task.catalogId!==state.exercises[0]?.id,activity_family:task.activityFamily,interaction_attempts:result.interactionAttempts,help_used:result.helpUsed,outcome:result.outcome,completed_at:completedAt}));activity.completed||={};activity.completed[key]=saved;state.attempts.push(saved);activity.current+=1;if(activity.current>=activity.tasks.length)activity.status='completed';persist();renderExercises();}catch(error){alert(activityText(`تعذر حفظ التمرين: ${error.message}`,`Could not save the exercise: ${error.message}`));}}
  function pauseRemediation(){if(!state.activeActivityId)return;state.remediationPaused=!state.remediationPaused;persist();renderExercises();}
  async function verify(){const button=$('verify-report');if(button.disabled)return;button.disabled=true;button.setAttribute('aria-busy','true');$('receipt-message').textContent=rt('continueBusy');$('receipt-message').className='v3-message';try{const observations=state.results.flatMap(i=>(i.candidates||[]).filter(c=>c.reviewStatus==='confirmed'&&c.reviewPayload).map(c=>c.reviewPayload));if(observations.length)await api(`/v1/progress/sessions/${state.sessionId}/observations`,json('POST',{submission_id:makeId('review'),child_id:state.child.child_id,observations}));const recs=await api(`/v1/progress/children/${state.child.child_id}/recommendations?session_id=${encodeURIComponent(state.sessionId)}`);state.exercises=recs.recommended_exercises.slice(0,7);if(state.exercises.length!==7)throw new Error('The recommendation engine did not return the required personalized exercises.');state.activities=window.acodyslexActivityLibrary.createPlan(state.exercises,state.sessionId);state.activeActivityId=null;state.remediationPaused=false;state.exerciseDrafts={};state.attempts=[];await api(`/v1/progress/sessions/${state.sessionId}/recommendations`,json('POST',{child_id:state.child.child_id,exercise_ids:state.exercises.map(item=>item.id)}));await backendPhase('remediation');renderExercises();show('remediation');}catch(error){$('receipt-message').textContent=error.message;$('receipt-message').className='v3-message error';button.disabled=false;}finally{button.removeAttribute('aria-busy');}}
  async function abandonRemediation(){if(!confirm(activityText('إنهاء الأنشطة الآن؟ التمارين المحفوظة فقط ستبقى مسجلة، ولن تُحتسب التمارين غير المنجزة كأخطاء.','End activities now? Only saved exercises remain recorded; unfinished exercises are not counted as errors.')))return;try{await backendPhase('abandoned');localStorage.removeItem(STORE);Object.assign(state,{phase:'home',child:null,sessionId:null,words:[],index:0,results:[],globalSummary:null,exercises:[],attempts:[],exerciseIndex:0,exerciseDrafts:{},activities:{},activeActivityId:null,remediationPaused:false,analysisId:null,recordingMeta:{}});show('home');await loadProfiles();}catch(error){alert(error.message);}}
  async function complete(){try{const result=await api(`/v1/progress/sessions/${state.sessionId}/complete`,json('POST',{child_id:state.child.child_id,completed_at:new Date().toISOString()}));$('completion-text').textContent=activityText(`${state.child.display_name||state.child.child_id} أكمل ${formatNumber(completedActivityTasks())} تمرينًا.`,`${state.child.display_name||state.child.child_id} completed ${formatNumber(completedActivityTasks())} exercises.`);renderSkills(result.profile.skills);show('completed');}catch(error){alert(activityText(`تعذر إنهاء الجلسة: ${error.message}`,`Could not complete the session: ${error.message}`));}}
  async function resetApplication(){
    if(!confirm('Réinitialiser entièrement l’application ? Tous les profils, séances et enregistrements locaux seront supprimés définitivement.'))return;
    const button=$('reset-app');button.disabled=true;
    try{
      analysisController?.abort('application_reset');
      clearInterval(timer);timer=null;clearTimeout(wordRevealTimer);wordRevealTimer=null;
      if(window.acodyslexLegacyAudio.isRecording())await window.acodyslexLegacyAudio.stopAndGetBlob({keepStream:false});
      await window.acodyslexLegacyAudio.release?.();
      try{await api('/api/reset',{method:'DELETE'});}catch(error){
        if(error.status!==404)throw error;
        const [profiles,legacyRecordings]=await Promise.all([api('/v1/progress/children'),api('/api/recordings')]);
        await Promise.all((profiles.children||[]).map(profile=>api(`/v1/progress/children/${encodeURIComponent(profile.child_id)}`,{method:'DELETE'})));
        await Promise.all((legacyRecordings||[]).map(recording=>api(`/api/recordings/${encodeURIComponent(recording.id)}`,{method:'DELETE'})));
      }
      await window.acodyslexAudioStore.clearAll?.();
      recordings.clear();localStorage.clear();sessionStorage.clear();
      Object.assign(state,{phase:'home',child:null,sessionId:null,words:[],index:0,results:[],globalSummary:null,exercises:[],attempts:[],exerciseIndex:0,exerciseDrafts:{},analysisId:null,recordingMeta:{},readingMode:'mixed'});
      state.activities={};state.activeActivityId=null;state.remediationPaused=false;
      if(window.acodyslexLaboratory?.isOpen?.())await window.acodyslexLaboratory.close();
      show('home');localStorage.removeItem(STORE);await loadProfiles();alert('Application réinitialisée.');
    }catch(error){alert(`Réinitialisation impossible : ${error.message}`);}
    finally{button.disabled=false;}
  }

  async function quitReport(){
    if(!confirm(reportExitConfirm()))return;
    try{
      await backendPhase('abandoned');
      await window.acodyslexLegacyAudio.release?.();
      localStorage.removeItem(STORE);
      Object.assign(state,{phase:'home',child:null,sessionId:null,words:[],index:0,results:[],globalSummary:null,exercises:[],attempts:[],exerciseIndex:0,exerciseDrafts:{},analysisId:null,recordingMeta:{}});
      recordings.clear();
      show('home');
      await loadProfiles();
    }catch(error){alert(`Impossible de quitter le rapport : ${error.message}`);}
  }

  function bind(){
    $('new-profile-btn').onclick=()=>{$('profile-form').reset();$('profile-age').value=8;const neutral=document.querySelector('input[name="avatar_id"][value="neutral"]');if(neutral)neutral.checked=true;delete $('profile-form').dataset.childId;$('profile-form').hidden=false;$('profile-name').focus();};
    $('profile-cancel').onclick=()=>{$('profile-form').hidden=true;delete $('profile-form').dataset.childId;};
    $('profile-form').onsubmit=async event=>{event.preventDefault();try{const values={display_name:$('profile-name').value,age:Number($('profile-age').value),sex:$('profile-sex').value,avatar_id:avatarId(document.querySelector('input[name="avatar_id"]:checked')?.value)},childId=event.target.dataset.childId;if(childId)await api(`/v1/progress/children/${childId}`,json('PATCH',values));else await api('/v1/progress/children',json('POST',{child_id:makeId('child'),...values}));event.target.reset();$('profile-age').value=8;const neutral=document.querySelector('input[name="avatar_id"][value="neutral"]');if(neutral)neutral.checked=true;event.target.hidden=true;await loadProfiles();}catch(error){alert(`Profil non enregistré : ${error.message}`);}};
    $('colored-letters').onchange=()=>colorArabic($('reading-word').textContent,$('colored-letters').checked);$('word-size').oninput=()=>$('reading-word').style.fontSize=`${$('word-size').value}px`;
    $('session-start').onclick=startCapture;$('session-pause').onclick=togglePause;$('session-stop').onclick=finishCapture;$('session-cancel').onclick=cancelCapture;$('session-file').onchange=event=>event.target.files?.[0]&&importFile(event.target.files[0]);$('retry-word').onclick=retry;
    $('session-transfer').onchange=()=>$('analyze-batch').disabled=recordings.size!==15||!$('session-transfer').checked;$('analyze-batch').onclick=analyzeBatch;$('analysis-home').onclick=leaveAnalysis;$('download-learning-guide').onclick=()=>downloadLearningGuide();$('verify-report').onclick=verify;$('quit-report').onclick=quitReport;$('report-filter').onchange=renderReportCards;$('phoneme-display-arabic').onchange=renderReportCards;
    $('complete-session').onclick=complete;$('leave-remediation').onclick=leaveRemediation;$('abandon-remediation').onclick=abandonRemediation;$('reset-app').onclick=resetApplication;$('reading-home').onclick=async()=>{if(window.acodyslexLegacyAudio.isRecording()&&!confirm('Interrompre l’enregistrement courant et revenir à l’accueil ?'))return;if(window.acodyslexLegacyAudio.isRecording())await window.acodyslexLegacyAudio.stopAndGetBlob({keepStream:false});await window.acodyslexLegacyAudio.release?.();clearInterval(timer);timer=null;setCaptureState('idle');await backendPhase('interrupted').catch(()=>{});show('home');};
    $('back-profiles').onclick=async()=>{await window.acodyslexLegacyAudio.release?.();localStorage.removeItem(STORE);Object.assign(state,{phase:'home',child:null,sessionId:null,words:[],index:0,results:[],globalSummary:null,exercises:[],attempts:[],exerciseIndex:0,exerciseDrafts:{},analysisId:null,recordingMeta:{}});recordings.clear();show('home');loadProfiles();};
  }
  async function restoreAudios(){recordings.clear();if(!state.child||!state.sessionId)return;for(const record of await window.acodyslexAudioStore.getSession(state.child.child_id,state.sessionId))recordings.set(record.word_id,record);state.recordingMeta=Object.fromEntries([...recordings].map(([key,value])=>[key,{...value,blob:undefined}]));persist();}
  async function init(){await window.acodyslexI18n?.ready;waveform=window.acodyslexReadingWaveform.create($('reading-waveform'));bind();restore();try{const config=await api('/api/config');if(Number(config.word_max_seconds)>=1)LIMIT=Math.min(20,Number(config.word_max_seconds));if(['word_only','mixed','adaptive'].includes(config.reading_mode))state.readingMode=config.reading_mode;}catch{}await loadAcousticModelInfo().catch(()=>{});await window.acodyslexAudioStore.cleanupOlderThan(7).catch(()=>{});await restoreAudios().catch(()=>{});await loadProfiles();if(state.child&&state.sessionId){if(state.phase==='reading'){await backendPhase('recording').catch(()=>{});renderReading();show('reading');}else if(state.phase==='ready')await renderReady();else if(state.phase==='review')await renderReport();else if(state.phase==='remediation'){renderExercises();show('remediation');}else if(state.phase==='completed')show('completed');}}
  window.addEventListener('acodyslex:languagechange',()=>{if(state.phase==='home')void loadProfiles();else if(state.phase==='review')void renderReport();else if(state.phase==='remediation')renderExercises();else if(state.phase==='completed')renderSkills(state.child?.skills||[]);});
  window.addEventListener('beforeunload',()=>{analysisController?.abort('page_unload');waveform?.destroy();if(window.acodyslexLegacyAudio?.isRecording()&&state.sessionId&&state.child)fetch(`/v1/progress/sessions/${state.sessionId}/state`,{...json('PATCH',{child_id:state.child.child_id,state:'interrupted'}),keepalive:true}).catch(()=>{});});
  $('back-to-activities').onclick=()=>{state.activeActivityId=null;state.remediationPaused=false;persist();renderExercises();};
  $('pause-remediation').onclick=pauseRemediation;
  init();
})();
