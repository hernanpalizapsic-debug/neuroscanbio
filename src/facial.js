import { bio } from './state.js';
import { mean, median, detectPeaks, dist } from './utils.js';
import { show, log, speak, setInstr, faceTimerEl } from './ui.js';

const L_EYE = { top: [159, 145], side: [33, 133] };
const R_EYE = { top: [386, 374], side: [362, 263] };
export const L_IRIS_CENTER = 468;
export const R_IRIS_CENTER = 473;
export const L_IRIS_RING = [469, 470, 471, 472];
const NOSE_TIP = 1;
const FOREHEAD = [10, 338, 297, 67, 109];

// Shared face context — plr.js reads these references for pupil measurement.
export const faceContext = {
  latestLandmarks: null,
  latestFrame: null,
};

let faceMesh = null;
let faceStream = null;

const earFor = (lm, E) => {
  const h = dist(lm[E.side[0]], lm[E.side[1]]);
  return h > 0 ? dist(lm[E.top[0]], lm[E.top[1]]) / h : 0;
};

async function initMesh() {
  faceMesh = new window.FaceMesh({
    locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`,
  });
  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  faceMesh.onResults((r) => {
    faceContext.latestLandmarks =
      r.multiFaceLandmarks && r.multiFaceLandmarks[0] ? r.multiFaceLandmarks[0] : null;
  });
}

const _rc = document.createElement('canvas');
const _rctx = _rc.getContext('2d', { willReadFrequently: true });

function sampleForeheadGreen() {
  if (!faceContext.latestLandmarks || !faceContext.latestFrame) return null;
  const lm = faceContext.latestLandmarks;
  const v = faceContext.latestFrame;
  const vw = v.videoWidth, vh = v.videoHeight;
  const xs = FOREHEAD.map((i) => lm[i].x * vw);
  const ys = FOREHEAD.map((i) => lm[i].y * vh);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const w = Math.max(4, (x1 - x0) | 0);
  const h = Math.max(4, (y1 - y0) | 0);
  _rc.width = w; _rc.height = h;
  _rctx.drawImage(v, x0, y0, w, h, 0, 0, w, h);
  const px = _rctx.getImageData(0, 0, w, h).data;
  let g = 0;
  for (let i = 0; i < px.length; i += 4) g += px[i + 1];
  return g / (px.length / 4);
}

export async function startFace({ runPLR, onComplete }) {
  show('view-face');
  document.getElementById('dot-1').classList.replace('bg-white/10', 'bg-cyan-500');
  log('front_optics');
  await initMesh();
  try {
    faceStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: 640, height: 480 },
    });
    const video = document.getElementById('video');
    video.srcObject = faceStream;
    await video.play();
    const cam = new window.Camera(video, {
      onFrame: async () => {
        faceContext.latestFrame = video;
        await faceMesh.send({ image: video });
      },
      width: 640,
      height: 480,
    });
    cam.start();
    await waitForFace();
    const rppgTimer = setInterval(() => {
      const g = sampleForeheadGreen();
      if (g != null) bio.rppg.raw.push({ t: performance.now() / 1000, v: g });
    }, 33);
    await taskBlink(8);
    await taskSaccade(10);
    await runPLR();
    clearInterval(rppgTimer);
    analyzeRPPG();
    if (faceStream) faceStream.getTracks().forEach((t) => t.stop());
    onComplete();
  } catch (e) {
    log('optics_fail');
    alert('No se pudo acceder a la cámara frontal: ' + e.message);
  }
}

function waitForFace() {
  document.getElementById('face-instr').innerText = 'Buscando rostro…';
  return new Promise((r) => {
    const t = setInterval(() => {
      if (faceContext.latestLandmarks) { clearInterval(t); r(); }
    }, 200);
  });
}

function taskBlink(sec) {
  setInstr('ESTABILIZACIÓN', 'Mirá el lente y parpadeá normal');
  speak('Mantené la mirada en la cámara y parpadeá con naturalidad.');
  document.getElementById('dot-2').classList.replace('bg-white/10', 'bg-cyan-500');
  faceTimerEl().classList.remove('hidden');
  let left = sec, closed = false, closeStart = 0;
  const TH = 0.21;
  return new Promise((res) => {
    const t = setInterval(() => {
      faceTimerEl().innerText = left;
      left--;
      if (left < 0) {
        clearInterval(t);
        clearInterval(sampler);
        faceTimerEl().classList.add('hidden');
        res();
      }
    }, 1000);
    const sampler = setInterval(() => {
      if (!faceContext.latestLandmarks) return;
      const lm = faceContext.latestLandmarks;
      const ear = (earFor(lm, L_EYE) + earFor(lm, R_EYE)) / 2;
      bio.blink.ear.push(ear);
      bio.headJitter.push({ x: lm[NOSE_TIP].x, y: lm[NOSE_TIP].y });
      if (ear < TH && !closed) {
        closed = true;
        closeStart = performance.now();
      } else if (ear >= TH && closed) {
        closed = false;
        bio.blink.count++;
        bio.blink.durations.push(performance.now() - closeStart);
      }
    }, 33);
  });
}

function taskSaccade(sec) {
  setInstr('SACÁDICO', 'Seguí el punto SOLO con los ojos');
  speak('Seguí el punto azul únicamente con la mirada, sin mover la cabeza.');
  const dot = document.getElementById('target-dot');
  dot.style.display = 'block';
  faceTimerEl().classList.remove('hidden');
  let left = sec;
  let curTarget = { x: 0.5, y: 0.5 };
  const moveTarget = () => {
    curTarget = { x: Math.random() * 0.6 + 0.2, y: Math.random() * 0.6 + 0.2 };
    dot.style.left = curTarget.x * 100 + '%';
    dot.style.top = curTarget.y * 100 + '%';
    bio.saccade.targets.push({ ...curTarget, t: performance.now() });
  };
  moveTarget();
  return new Promise((res) => {
    const mover = setInterval(moveTarget, 1300);
    const timer = setInterval(() => {
      faceTimerEl().innerText = left;
      left--;
      if (left < 0) {
        clearInterval(timer);
        clearInterval(mover);
        clearInterval(sampler);
        faceTimerEl().classList.add('hidden');
        dot.style.display = 'none';
        res();
      }
    }, 1000);
    const sampler = setInterval(() => {
      if (!faceContext.latestLandmarks) return;
      const lm = faceContext.latestLandmarks;
      const ix = (lm[L_IRIS_CENTER].x + lm[R_IRIS_CENTER].x) / 2;
      const iy = (lm[L_IRIS_CENTER].y + lm[R_IRIS_CENTER].y) / 2;
      bio.saccade.gaze.push({ x: ix, y: iy, t: performance.now() });
      bio.saccade.errors.push(Math.hypot(ix - curTarget.x, iy - curTarget.y));
    }, 33);
  });
}

function analyzeRPPG() {
  if (bio.rppg.raw.length < 200) { bio.rppg.measurable = false; return; }
  const peaks = detectPeaks(bio.rppg.raw);
  if (peaks.length < 8) { bio.rppg.measurable = false; return; }
  let ibis = [];
  for (let i = 1; i < peaks.length; i++) ibis.push((peaks[i].t - peaks[i - 1].t) * 1000);
  ibis = ibis.filter((x) => x > 300 && x < 1500);
  if (ibis.length < 5) { bio.rppg.measurable = false; return; }
  bio.rppg.bpm = Math.round(60000 / median(ibis));
  bio.rppg.measurable = true;
  if (bio.hrv.measurable && bio.hrv.bpm) {
    bio.xval.bpmDiff = Math.abs(bio.hrv.bpm - bio.rppg.bpm);
    bio.xval.agreement =
      bio.xval.bpmDiff <= 5 ? 'Alta' : bio.xval.bpmDiff <= 10 ? 'Media' : 'Baja';
  }
}
