/* Real microphone PCM capture, not a WebM decoder. Worklet and UI share these samples. */
class AcoDyslexPcmCapture extends AudioWorkletProcessor {
  constructor(){
    super();
    this.buffer=new Float32Array(2048);
    this.used=0;
    this.port.onmessage=event=>{
      if(event.data?.type==='flush'){
        this.emitPartial();
        this.port.postMessage({type:'flushed'});
      }
    };
  }
  emitPartial(){
    if(!this.used)return;
    const samples=this.buffer.slice(0,this.used);
    this.port.postMessage({type:'samples',samples:samples.buffer},[samples.buffer]);
    this.used=0;
  }
  process(inputs,outputs){
    const source=inputs[0];
    const out=outputs[0];
    if(out)for(const channel of out)channel.fill(0);
    if(source?.length){
      const frames=source[0].length;
      for(let i=0;i<frames;i++){
        let value=0;
        for(let j=0;j<source.length;j++)value+=source[j][i]/source.length;
        this.buffer[this.used++]=value;
        if(this.used===this.buffer.length)this.emitPartial();
      }
    }
    return true;
  }
}
registerProcessor('acodyslex-pcm-capture',AcoDyslexPcmCapture);
