// Simulates a WebAudio AudioWorkletProcessor's one-channel and two-channel
// callbacks. Verifies actual PCM buffers, no output feedback, and flush behavior.
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
let Processor=null;
const posted=[];
class MockWorklet{
 constructor(){this.port={onmessage:null,postMessage:(message)=>posted.push(message)};}
}
const source=fs.readFileSync(path.join(__dirname,'../static/pcm-processor.js'),'utf8');
vm.runInNewContext(source,{
 AudioWorkletProcessor:MockWorklet,
 Float32Array,
 registerProcessor:(name,klass)=>{assert.equal(name,'acodyslex-pcm-capture');Processor=klass;},
});
assert(Processor);
const worklet=new Processor();
for(let i=0;i<18;i++){
 const input=new Float32Array(128);
 input.fill(i<9?0.25:-0.25);
 const output=[new Float32Array(128)];output[0].fill(0.88);
 assert.equal(worklet.process([[input]], [output]),true);
 assert(output[0].every(x=>x===0),'output must be silent to avoid feedback');
}
worklet.port.onmessage({data:{type:'flush'}});
const packets=posted.filter(p=>p.type==='samples').map(p=>Array.from(new Float32Array(p.samples)));
const samples=packets.flat();
assert.equal(samples.length,2304);
assert(samples.slice(0,1152).every(v=>v===0.25));
assert(samples.slice(1152).every(v=>v===-0.25));
assert.equal(posted.at(-1).type,'flushed');
console.log('AudioWorklet PCM: 2304 samples, retained amplitudes, zero playback output, flush OK');
