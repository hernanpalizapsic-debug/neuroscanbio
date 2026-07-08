import { bio } from './state.js';
import { dist } from './utils.js';
import { show, log, speak, setInstr, faceTimerEl } from './ui.js';
import { sampleRegionsRGB, analyzeRPPG_v2 } from './rppg.js';

const L_EYE = { top: [159, 145], side: [33, 133] };
const R_EYE = { top: [386, 374], side: [362, 263] };
export const L_IRIS_CENTER = 468;
export const R_IRIS_CENTER = 473;
export const L_IRIS_RING = [469, 470, 471, 472];
const NOSE_TIP = 1;

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
    // rPPG v2: muestreamos R/G/B de 3 skin patches (frente + 2 mejillas)
    // siguiendo los landmarks frame a frame. El pipeline POS+FFT corre al
    // final de la fase facial en analyzeRPPG.
    const rppgTimer = setInterval(() => {
      const rgb = sampleRegionsRGB(faceContext.latestLandmarks, faceContext.latestFrame);
      if (rgb) {
        bio.rppg.raw.push({
          t: performance.now() / 1000,
          r: rgb.r, g: rgb.g, b: rgb.b,
        });
      }
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
  // Pipeline nuevo: POS + FFT + SNR. Reemplaza el conteo de picos crudo.
  // Ver src/rppg.js para el detalle del algoritmo.
  const result = analyzeRPPG_v2(bio.rppg.raw);
  Object.assign(bio.rppg, result);
  // Cross-validación dedo↔cara: intacta, útil solo si ambos midieron.
  if (bio.rppg.measurable && bio.rppg.bpm && bio.hrv.measurable && bio.hrv.bpm) {
    bio.xval.bpmDiff = Math.abs(bio.hrv.bpm - bio.rppg.bpm);
    bio.xval.agreement =
      bio.xval.bpmDiff <= 5 ? 'Alta' : bio.xval.bpmDiff <= 10 ? 'Media' : 'Baja';
  }
}
