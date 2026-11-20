// Browser smoke test without an HTTP navigation. The runner's browser policy blocks
// file:// and localhost navigation. Exercise actual WebAudio capture using setContent.
const {chromium}=require('@playwright/test');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'static/index.html'),'utf8').replace(/<script\b[^>]*><\/script>/gi,'');
const js=fs.readFileSync(path.join(root,'static/app.js'),'utf8');
(async()=>{
 const executablePath=process.env.ACODYSLEX_CHROMIUM||(process.platform==='linux'&&fs.existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined);
 const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{}),args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});
 try{
  for(const amplitude of [0.3,0.006,0,0.00005]){
   const page=await browser.newPage();
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.setContent(html);
   await page.evaluate(amplitude=>{
    const generator=new AudioContext();
    const output=generator.createMediaStreamDestination();
    const tone=generator.createOscillator();
    const gain=generator.createGain();
    gain.gain.value=amplitude;
    tone.frequency.value=450;
    tone.connect(gain);gain.connect(output);tone.start();
    window.testGenerator=generator;
    Object.defineProperty(navigator,'mediaDevices',{value:{
      getUserMedia:async()=>{await generator.resume();return output.stream;},
      enumerateDevices:async()=>[{kind:'audioinput',deviceId:'test-microphone',label:'Synthetic microphone'}],
      addEventListener:()=>{}
    },configurable:true});
   },amplitude);
   await page.addScriptTag({content:js});
   await page.evaluate(()=>window.acodyslexLaboratory.open());
   await page.locator('#start-btn').click();
   await page.waitForTimeout(1400);
   const method=await page.evaluate(()=>pcmCapture?.method||null);
   if(!method)throw new Error('PCM capture failed to start; alert='+await page.locator('#alert').textContent());
   await page.locator('#stop-btn').click();
   await page.waitForFunction(()=>pcmCapture===null);
   const result=await page.evaluate(async()=>{
     const bytes=await wavBlob.arrayBuffer(), view=new DataView(bytes);
     const out={rms:0,peak:0,samples:(bytes.byteLength-44)/2};
     for(let i=44;i<bytes.byteLength;i+=2){const n=view.getInt16(i,true)/32768;out.rms+=n*n;out.peak=Math.max(out.peak,Math.abs(n));}
     out.rms=Math.sqrt(out.rms/out.samples);
     return {...out,sourceRate:16000,channels:view.getUint16(22,true),rate:view.getUint32(24,true),
       saveAllowed:audioSaveAllowed,diagnostic:document.getElementById('mic-diagnostics-text').textContent,
       alert:document.getElementById('alert').textContent};
   });
   assert.equal(result.rate,16000);assert.equal(result.channels,1);assert(result.samples>10000);
   // Decode and play the WAV through the browser's own audio player graph.
   if(amplitude===0.3){
     const played=await page.evaluate(async()=>{
       const player=document.getElementById('preview');
       player.muted=false;player.volume=1;
       const ctx=new AudioContext();
       const src=ctx.createMediaElementSource(player),analyser=ctx.createAnalyser();
       src.connect(analyser);analyser.connect(ctx.destination);
       await ctx.resume();await player.play();
       const frame=new Float32Array(analyser.fftSize);
       let peak=0;
       for(let i=0;i<15;i++){
         await new Promise(resolve=>setTimeout(resolve,30));
         analyser.getFloatTimeDomainData(frame);
         for(const v of frame)peak=Math.max(peak,Math.abs(v));
       }
       player.pause();await ctx.close();return peak;
     });
     assert(played>0.10,`WAV should decode to audible playback; peak=${played}`);
     console.log('WAV playback peak = '+played.toFixed(5));
   }
   if(amplitude===0.3){assert(result.rms>0.15,JSON.stringify(result));assert(result.saveAllowed,JSON.stringify(result));}
   else if(amplitude===0.006){assert(result.rms>0.003,JSON.stringify(result));assert(result.saveAllowed,JSON.stringify(result));}
   else{assert(result.rms<0.0005,JSON.stringify(result));assert.equal(result.saveAllowed,false);}
   assert.equal(errors.length,0,errors.join('\n'));
   console.log(`PCM ${method} source amplitude ${amplitude} -> WAV rms=${result.rms.toFixed(6)} peak=${result.peak.toFixed(6)} saveAllowed=${result.saveAllowed}`);
   await page.close();
  }
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
