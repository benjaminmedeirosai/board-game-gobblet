// Records a short voice clip from the mic and draws a live waveform while
// capturing. Capture-then-send: the whole clip is built locally, optionally
// reviewed (played back to yourself), then handed back as a Blob for the caller
// to transmit — nothing is streamed in real time.

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

export function voiceSupported() {
  return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
}

function pickMime() {
  if (!window.MediaRecorder?.isTypeSupported) return '';
  return MIME_CANDIDATES.find((c) => MediaRecorder.isTypeSupported(c)) || '';
}

// canvas: the element to draw the live waveform into while recording.
export function createVoiceRecorder(canvas) {
  let stream = null;
  let recorder = null;
  let chunks = [];
  let audioCtx = null;
  let analyser = null;
  let raf = 0;
  let review = null; // HTMLAudioElement for local playback

  function stopMeter() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    const ctx = canvas?.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function drawMeter() {
    const ctx = canvas.getContext('2d');
    const buf = new Uint8Array(analyser.fftSize);
    const stroke = getComputedStyle(canvas).color || '#57d98a';
    const render = () => {
      raf = requestAnimationFrame(render);
      analyser.getByteTimeDomainData(buf);
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.lineWidth = 2;
      ctx.strokeStyle = stroke;
      ctx.beginPath();
      const step = w / buf.length;
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i] / 128 - 1;            // -1..1
        const y = h / 2 + v * (h / 2) * 0.9;   // leave a little headroom
        const x = i * step;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.stroke();
    };
    render();
  }

  function fitCanvas() {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
  }

  function releaseCapture() {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
    analyser = null;
    recorder = null;
  }

  function stopPlayback() {
    if (review) {
      review.pause();
      URL.revokeObjectURL(review.src);
      review = null;
    }
  }

  // Ask for the mic and start capturing. Rejects if permission is denied or the
  // browser can't record.
  async function start() {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    const mime = pickMime();
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.start();
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    fitCanvas();
    drawMeter();
  }

  // Stop capturing and resolve the finished clip as a Blob.
  function finish() {
    return new Promise((resolve) => {
      if (!recorder || recorder.state === 'inactive') { stopMeter(); releaseCapture(); resolve(null); return; }
      recorder.onstop = () => {
        stopMeter();
        const type = recorder?.mimeType || 'audio/webm';
        const blob = new Blob(chunks, { type });
        releaseCapture();
        resolve(blob.size ? blob : null);
      };
      recorder.stop();
    });
  }

  // Play a finished clip back to the recorder (review before sending).
  function play(blob) {
    stopPlayback();
    review = new Audio(URL.createObjectURL(blob));
    review.play().catch(() => {});
  }

  // Abandon everything: stop capture + playback, drop the buffered audio.
  function cancel() {
    stopMeter();
    stopPlayback();
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = () => releaseCapture();
      recorder.stop();
    } else {
      releaseCapture();
    }
    chunks = [];
  }

  function teardown() {
    stopMeter();
    stopPlayback();
    releaseCapture();
    chunks = [];
  }

  return { start, finish, play, stopPlayback, cancel, teardown };
}
