// ============================================================
//  HRV — captura por dedo en cámara trasera + flash.
//
//  ¿Por qué calidad ADAPTATIVA (amplitud AC/DC), no umbrales
//  fijos de brillo (estilo v18: r>120 && g<r*0.8 ...)?
//
//  El v18 asumía un escenario ideal: flash encendido + cámara
//  saturada en rojo. En la práctica, muchos navegadores móviles
//  no aceptan applyConstraints({torch:true}) después de abrir
//  el stream, o lo soportan parcialmente. Sin flash real, el
//  brillo del canal rojo nunca llega al umbral (r>120) y la
//  señal se descartaba como "mala" aunque tuviera latido real.
//
//  v19 desacopla calidad-de-medición de brillo-absoluto:
//  mide la amplitud relativa (AC/DC) del canal rojo en una
//  ventana móvil de ~90 muestras (~3s). Lo que importa para
//  HRV es la variación periódica de la luz transmitida, no su
//  nivel medio. Esto funciona con flash, sin flash, o con luz
//  ambiente residual, y permite mostrar feedback honesto al
//  usuario ("amplitud 0.18% — buena") en vez de un binario
//  arbitrario.
//
//  Otro motivo: análisis post-hoc. Guardar bio.hrv.diag
//  (torch, avgR, ampPct) deja huella para entender por qué
//  una medición salió "no medible" cuando Firestore tenga
//  histórico — útil para correlacionar fallas con modelo de
//  dispositivo.
// ============================================================

import { bio } from './state.js';
import { mean, std, median, detectPeaks } from './utils.js';
import { show, log, speak } from './ui.js';

let hrvStream = null;

export function startHRV() {
  show('view-hrv');
  document.getElementById('dot-0').classList.add('bg-cyan-500');
  speak('Fase cardíaca. Apoyá el dedo índice sobre la cámara trasera y el flash, sin presionar fuerte.');
  log('hrv_standby');
}

export function bindHrvButton(onDone) {
  document.getElementById('btn-hrv').onclick = async () => {
    const btn = document.getElementById('btn-hrv');
    btn.disabled = true;
    btn.innerText = 'SENSOR_ONLINE';
    document.getElementById('hrv-diag').classList.remove('hidden');
    try {
      // Intento 1: torch en el constraint inicial. Algunos navegadores solo
      // respetan torch acá, no en applyConstraints posterior.
      try {
        hrvStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: 320, height: 240, advanced: [{ torch: true }] },
        });
      } catch (e) {
        hrvStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: 320, height: 240 },
        });
      }
      const track = hrvStream.getVideoTracks()[0];
      const video = document.getElementById('video-hrv');
      video.srcObject = hrvStream;
      await video.play();

      // Intento 2: applyConstraints como refuerzo.
      let torchOn = false;
      try {
        const caps = track.getCapabilities ? track.getCapabilities() : {};
        if (caps.torch) await track.applyConstraints({ advanced: [{ torch: true }] });
        const settings = track.getSettings ? track.getSettings() : {};
        torchOn = !!settings.torch || !!caps.torch;
      } catch (e) {
        torchOn = false;
      }
      bio.hrv.diag.torch = torchOn ? 'activo (o soportado)' : 'no disponible';
      document.getElementById('torch-status').innerText = 'Flash: ' + bio.hrv.diag.torch;

      document.getElementById('hrv-heart').classList.replace('opacity-20', 'opacity-100');
      document.getElementById('hrv-heart').classList.add('heart');
      document.getElementById('hrv-timer').classList.remove('hidden');

      await captureHRV(video, 45);
      await analyzeHRV();
      if (hrvStream) hrvStream.getTracks().forEach((t) => t.stop());
      onDone();
    } catch (err) {
      log('hrv_hw_error');
      alert('No se pudo acceder a la cámara trasera. Avanzando a la fase facial.');
      if (hrvStream) hrvStream.getTracks().forEach((t) => t.stop());
      onDone();
    }
  };
}

function captureHRV(video, seconds) {
  const canvas = document.getElementById('hrv-canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const W = 40, H = 40;
  const timerEl = document.getElementById('hrv-timer');
  const bpmLive = document.getElementById('bpm-live');
  const ampFill = document.getElementById('amp-bar-fill');
  const ampLabel = document.getElementById('amp-label');
  const trace = document.getElementById('ppg-trace');
  const tctx = trace.getContext('2d');
  trace.width = trace.clientWidth;
  trace.height = 70;
  const t0 = performance.now();
  const ROLL = 90; // ~3s window @ 30fps
  return new Promise((res) => {
    let lastTick = Math.ceil(seconds);
    const loop = setInterval(() => {
      const t = (performance.now() - t0) / 1000;
      ctx.drawImage(video, 0, 0, W, H);
      const px = ctx.getImageData(0, 0, W, H).data;
      const n = px.length / 4;
      let r = 0;
      for (let i = 0; i < px.length; i += 4) r += px[i];
      r /= n;
      bio.hrv.raw.push({ t, v: r });
      drawTrace(tctx, trace);

      // Adaptive quality: relative AC/DC amplitude over rolling window.
      const win = bio.hrv.raw.slice(-ROLL).map((s) => s.v);
      let ampPct = 0, dc = 0;
      if (win.length >= 15) {
        dc = mean(win);
        const mx = Math.max(...win);
        const mn = Math.min(...win);
        ampPct = dc > 0 ? ((mx - mn) / dc) * 100 : 0;
      }
      // Visual scale: 2% AC = full bar.
      const pct = Math.min(100, (ampPct / 2) * 100);
      ampFill.style.width = pct + '%';
      ampFill.className = ampPct > 0.15 ? 'bg-emerald-500' : ampPct > 0.05 ? 'bg-amber-500' : 'bg-red-500';
      ampLabel.innerText =
        `Amplitud de señal: ${ampPct.toFixed(2)}% ` +
        (ampPct > 0.15 ? '(buena)' : ampPct > 0.05 ? '(débil, no te muevas)' : '(muy baja — ajustá el dedo)');
      bio.hrv.diag.avgR = +dc.toFixed(1);
      bio.hrv.diag.ampPct = +ampPct.toFixed(2);

      if (t > 6) {
        const liveBpm = quickBpm(bio.hrv.raw);
        if (liveBpm) bpmLive.innerText = liveBpm + ' BPM';
      }

      const left = Math.ceil(seconds - t);
      if (left !== lastTick && left >= 0) {
        lastTick = left;
        timerEl.innerText = left;
        log('hrv_t-' + left);
      }
      if (t >= seconds) {
        clearInterval(loop);
        res();
      }
    }, 33);
  });
}

function drawTrace(ctx, cv) {
  const data = bio.hrv.raw.slice(-150);
  if (data.length < 2) return;
  const vs = data.map((d) => d.v);
  const mn = Math.min(...vs);
  const mx = Math.max(...vs);
  const rng = mx - mn || 1;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.beginPath();
  ctx.strokeStyle = '#00f2ff';
  ctx.lineWidth = 2;
  data.forEach((d, i) => {
    const x = (i / (data.length - 1)) * cv.width;
    const y = cv.height - ((d.v - mn) / rng) * cv.height;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
}

function quickBpm(raw) {
  if (raw.length < 60) return null;
  const seg = raw.slice(-Math.min(raw.length, 240));
  const peaks = detectPeaks(seg);
  if (peaks.length < 3) return null;
  const ibis = [];
  for (let i = 1; i < peaks.length; i++) ibis.push(peaks[i].t - peaks[i - 1].t);
  const m = median(ibis);
  const bpm = m ? Math.round(60 / m) : null;
  return bpm && bpm >= 35 && bpm <= 200 ? bpm : null;
}

async function analyzeHRV() {
  const samples = bio.hrv.raw;
  if (samples.length < 200) {
    bio.hrv.measurable = false;
    bio.hrv.confidence = 'Ninguna';
    return;
  }
  const peaks = detectPeaks(samples);
  bio.hrv.peaks = peaks;
  if (peaks.length < 6) {
    bio.hrv.measurable = false;
    bio.hrv.confidence = 'Ninguna';
    return;
  }
  let ibis = [];
  for (let i = 1; i < peaks.length; i++) ibis.push((peaks[i].t - peaks[i - 1].t) * 1000);
  // Physiological window: 35-180 BPM.
  ibis = ibis.filter((x) => x > 333 && x < 1714);
  const clean = [ibis[0]];
  for (let i = 1; i < ibis.length; i++) {
    if (
      clean[clean.length - 1] &&
      Math.abs(ibis[i] - clean[clean.length - 1]) / clean[clean.length - 1] < 0.25
    ) {
      clean.push(ibis[i]);
    }
  }
  if (clean.length < 6) {
    bio.hrv.measurable = false;
    bio.hrv.confidence = 'Ninguna';
    return;
  }

  bio.hrv.ibis = clean;
  const bpm = Math.round(60000 / mean(clean));
  bio.hrv.bpm = bpm;
  bio.hrv.sdnn = +std(clean).toFixed(1);
  const sq = [];
  for (let i = 1; i < clean.length; i++) sq.push((clean[i] - clean[i - 1]) ** 2);
  bio.hrv.rmssd = +Math.sqrt(mean(sq)).toFixed(1);

  // Confidence: clean beats count + physiological plausibility + CV.
  const cv = std(clean) / mean(clean);
  if (clean.length >= 15 && bpm >= 40 && bpm <= 150 && cv < 0.35) bio.hrv.confidence = 'Alta';
  else if (clean.length >= 8 && bpm >= 40 && bpm <= 160) bio.hrv.confidence = 'Media';
  else bio.hrv.confidence = 'Baja';
  bio.hrv.measurable = bio.hrv.confidence !== 'Ninguna';
  log('hrv_' + bio.hrv.confidence.toLowerCase() + '_' + bpm + 'bpm');
}
