import { bio } from './state.js';
import { median, sleep } from './utils.js';
import { setInstr, speak, log } from './ui.js';
import { faceContext, L_IRIS_CENTER, L_IRIS_RING } from './facial.js';

const _pc = document.createElement('canvas');
const _pctx = _pc.getContext('2d', { willReadFrequently: true });

function measurePupil() {
  if (!faceContext.latestLandmarks || !faceContext.latestFrame) return null;
  const lm = faceContext.latestLandmarks;
  const v = faceContext.latestFrame;
  const vw = v.videoWidth, vh = v.videoHeight;
  const ring = L_IRIS_RING.map((i) => lm[i]);
  const cx = lm[L_IRIS_CENTER].x * vw;
  const cy = lm[L_IRIS_CENTER].y * vh;
  const irisR = Math.max(...ring.map((p) => Math.hypot(p.x * vw - cx, p.y * vh - cy)));
  if (irisR < 6) return null;
  const size = Math.ceil(irisR * 2) + 4;
  _pc.width = size; _pc.height = size;
  _pctx.drawImage(v, cx - size / 2, cy - size / 2, size, size, 0, 0, size, size);
  const px = _pctx.getImageData(0, 0, size, size).data;
  const cxx = size / 2, cyy = size / 2;
  let sumB = 0, total = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (Math.hypot(x - cxx, y - cyy) > irisR) continue;
      const i = (y * size + x) * 4;
      sumB += (px[i] + px[i + 1] + px[i + 2]) / 3;
      total++;
    }
  }
  if (total === 0) return null;
  const meanB = sumB / total;
  const thresh = meanB * 0.45;
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (Math.hypot(x - cxx, y - cyy) > irisR) continue;
      const i = (y * size + x) * 4;
      if ((px[i] + px[i + 1] + px[i + 2]) / 3 < thresh) dark++;
    }
  }
  if (dark < 4) return null;
  return Math.sqrt(dark / Math.PI) / irisR;
}

export function taskPLR() {
  setInstr('REFLEJO PUPILAR', 'Acercá la cara ~25cm y NO te muevas');
  speak('Acercá la cara, mantené los ojos abiertos y no te muevas. Habrá un destello.');
  return new Promise(async (res) => {
    await sleep(3500);
    for (let i = 0; i < 10; i++) {
      const m = measurePupil();
      if (m !== null) bio.plr.baselineDark.push(m);
      await sleep(60);
    }
    const flash = document.getElementById('screen-flash');
    flash.style.display = 'block';
    log('flash_on');
    const t0 = performance.now();
    const resp = [];
    const grab = setInterval(() => {
      const m = measurePupil();
      if (m !== null) resp.push({ r: m, t: performance.now() - t0 });
    }, 40);
    await sleep(2500);
    clearInterval(grab);
    flash.style.display = 'none';
    bio.plr.response = resp;
    const base = median(bio.plr.baselineDark);
    if (base === null || resp.length < 10) {
      bio.plr.measurable = false;
      return res();
    }
    const minR = Math.min(...resp.map((p) => p.r));
    const constriction = (base - minR) / base;
    if (constriction > 0.04 && bio.plr.baselineDark.length >= 5) {
      bio.plr.measurable = true;
      bio.plr.constriction = +(constriction * 100).toFixed(1);
      const mp = resp.find((p) => p.r === minR);
      bio.plr.latencyMs = mp ? Math.round(mp.t) : null;
    } else {
      bio.plr.measurable = false;
    }
    res();
  });
}
