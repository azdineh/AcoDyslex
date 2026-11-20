/* Live PCM waveform for the child reading screen. It never touches the recorded signal. */
(() => {
  function create(canvas, audioSource = () => window.acodyslexLegacyAudio) {
    const context = canvas.getContext('2d');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let state = 'idle', frame = 0, framesDrawn = 0, lastAmplitude = 0;

    const size = () => {
      const ratio = Math.min(devicePixelRatio || 1, 2), rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width * ratio)), height = Math.max(1, Math.round(rect.height * ratio));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      return {width, height, ratio};
    };
    const neutral = (width, height, color = '#9db8d3') => {
      context.beginPath(); context.moveTo(0, height / 2); context.lineTo(width, height / 2);
      context.strokeStyle = color; context.lineWidth = Math.max(2, height / 45); context.stroke();
    };
    const draw = () => {
      const {width, height} = size(); context.clearRect(0, 0, width, height);
      const samples = audioSource()?.getLiveSamples?.();
      if (state !== 'recording' || !samples?.length) {
        neutral(width, height, state === 'paused' ? '#7e9fbd' : '#a8bed3'); lastAmplitude = 0;
      } else {
        context.beginPath();
        const center = height / 2, stride = Math.max(1, Math.floor(samples.length / width)); let peak = 0;
        for (let x = 0; x < width; x++) {
          const value = Math.max(-1, Math.min(1, samples[Math.min(samples.length - 1, x * stride)] || 0));
          peak = Math.max(peak, Math.abs(value)); const y = center + value * height * .43;
          if (x === 0) context.moveTo(x, y); else context.lineTo(x, y);
        }
        context.strokeStyle = '#168fa0'; context.lineWidth = Math.max(2, height / 42); context.lineJoin = 'round'; context.stroke();
        context.beginPath(); context.moveTo(0, center); context.lineTo(width, center); context.strokeStyle = 'rgba(37,111,196,.22)'; context.lineWidth = 1; context.stroke();
        lastAmplitude = peak;
      }
      framesDrawn++;
      if (state === 'recording' && !reduced.matches) frame = requestAnimationFrame(draw); else frame = 0;
    };
    const stopLoop = () => { if (frame) cancelAnimationFrame(frame); frame = 0; };
    const setState = next => { stopLoop(); state = next; canvas.dataset.state = next; draw(); };
    const destroy = () => { stopLoop(); reduced.removeEventListener?.('change', onReducedChange); state = 'destroyed'; context.clearRect(0, 0, canvas.width, canvas.height); };
    const onReducedChange = () => setState(state);
    reduced.addEventListener?.('change', onReducedChange);
    setState('idle');
    return {setState, destroy, metrics: () => ({state, framesDrawn, lastAmplitude, running: !!frame})};
  }
  window.acodyslexReadingWaveform = {create};
})();
