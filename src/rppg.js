// rPPG facial: pipeline POS + FFT + SNR.
//
// Reemplaza el v18/v19 que promediaba solo el canal verde de la frente y
// contaba picos en el tiempo (ruidoso y sensible a movimiento). El pipeline
// nuevo hace:
//
//   1. Muestrear R/G/B en 3 skin patches estables (frente + mejilla izq + der)
//      siguiendo landmarks de MediaPipe frame a frame.
//   2. Resamplear a una fs uniforme (~30 Hz) — compensa jitter de setInterval.
//   3. Aplicar POS (Wang et al. 2017, IEEE TBME 64(7)) — proyecta la señal
//      RGB sobre un plano ortogonal al vector de piel, cancelando componentes
//      de iluminación/movimiento y dejando el pulso.
//   4. FFT (radix-2 Cooley-Tukey, zero-padded a la potencia de 2 siguiente)
//      con ventana de Hann.
//   5. Buscar el pico dominante en la banda fisiológica [0.7, 4] Hz
//      (42–240 BPM). El HR resultante viene con un SNR espectral que
//      define la confianza.
//   6. Si el SNR es Media o Alta, extra: bandpass ± 1 Hz alrededor del HR
//      (por FFT zero-out + IFFT), detectar picos en el tiempo, computar
//      RMSSD/SDNN. Ese HRV latido-a-latido queda con confianza CAPADA a
//      un nivel debajo del HR (no inflemos).
//
// Referencia: Wang W., den Brinker A. C., Stuijk S., de Haan G.,
// "Algorithmic Principles of Remote PPG", IEEE Transactions on Biomedical
// Engineering 64(7):1479-1491 (2017).

// ============================================================
//  Constantes
// ============================================================

// Landmarks MediaPipe FaceMesh (índices 0-467, refined landmarks).
// Cada set define una skin patch: frente + mejilla izq + mejilla der.
// Elegidas para caer en piel expuesta, lejos de ojos/boca/pelo.
export const FOREHEAD_LM = [10, 338, 297, 67, 109, 151, 108, 336];
export const LEFT_CHEEK_LM = [116, 117, 118, 119, 100, 47];
export const RIGHT_CHEEK_LM = [345, 346, 347, 348, 329, 277];

const TARGET_FS = 30;         // Hz — sample rate uniforme post-resample
const POS_WINDOW_SEC = 1.6;   // ventana POS (Wang recomienda 1.6s)
const BAND_LOW = 0.7;         // Hz — 42 BPM
const BAND_HIGH = 4.0;        // Hz — 240 BPM
const MIN_SIGNAL_SEC = 8;     // no reportar si <8s de datos
const HRV_BAND_HALF = 1.0;    // Hz — half-width alrededor del HR para bandpass del HRV

// ============================================================
//  Sampling: 3 ROIs → 1 tripleta (R,G,B) ponderada por área
// ============================================================

let _canvas = null;
let _ctx = null;
function ctx() {
  if (!_canvas) {
    _canvas = document.createElement('canvas');
    _ctx = _canvas.getContext('2d', { willReadFrequently: true });
  }
  return _ctx;
}

function sampleRegion(video, landmarks, indices) {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return null;
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
  for (const i of indices) {
    const lm = landmarks[i];
    if (!lm) return null;
    const x = lm.x * vw, y = lm.y * vh;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  const x0 = Math.max(0, Math.floor(xMin));
  const y0 = Math.max(0, Math.floor(yMin));
  const x1 = Math.min(vw, Math.ceil(xMax));
  const y1 = Math.min(vh, Math.ceil(yMax));
  const w = x1 - x0, h = y1 - y0;
  if (w < 4 || h < 4) return null;
  const c = ctx();
  c.canvas.width = w;
  c.canvas.height = h;
  c.drawImage(video, x0, y0, w, h, 0, 0, w, h);
  const px = c.getImageData(0, 0, w, h).data;
  let rSum = 0, gSum = 0, bSum = 0;
  const n = px.length / 4;
  for (let i = 0; i < px.length; i += 4) {
    rSum += px[i]; gSum += px[i + 1]; bSum += px[i + 2];
  }
  return { r: rSum / n, g: gSum / n, b: bSum / n, count: n };
}

/**
 * Muestrea 3 skin patches y devuelve el promedio RGB ponderado por área.
 * @param {object[]|null} landmarks - array de landmarks de MediaPipe FaceMesh
 * @param {HTMLVideoElement|null} video
 * @returns {{r:number, g:number, b:number}|null}
 */
export function sampleRegionsRGB(landmarks, video) {
  if (!landmarks || !video) return null;
  const results = [
    sampleRegion(video, landmarks, FOREHEAD_LM),
    sampleRegion(video, landmarks, LEFT_CHEEK_LM),
    sampleRegion(video, landmarks, RIGHT_CHEEK_LM),
  ].filter(Boolean);
  if (results.length === 0) return null;
  let sR = 0, sG = 0, sB = 0, sN = 0;
  for (const r of results) {
    sR += r.r * r.count;
    sG += r.g * r.count;
    sB += r.b * r.count;
    sN += r.count;
  }
  return { r: sR / sN, g: sG / sN, b: sB / sN };
}

// ============================================================
//  Resample a fs uniforme (interpolación lineal por muestra)
// ============================================================

function resampleUniform(samples, fs) {
  if (samples.length < 2) return [];
  const t0 = samples[0].t;
  const tN = samples[samples.length - 1].t;
  const durationS = tN - t0;
  const N = Math.floor(durationS * fs) + 1;
  const out = new Array(N);
  let j = 0;
  for (let i = 0; i < N; i++) {
    const t = t0 + i / fs;
    while (j < samples.length - 2 && samples[j + 1].t < t) j++;
    const s0 = samples[j];
    const s1 = samples[j + 1] || s0;
    const denom = s1.t - s0.t;
    const a = denom > 0 ? (t - s0.t) / denom : 0;
    out[i] = {
      r: s0.r * (1 - a) + s1.r * a,
      g: s0.g * (1 - a) + s1.g * a,
      b: s0.b * (1 - a) + s1.b * a,
    };
  }
  return out;
}

// ============================================================
//  POS (Wang et al. 2017)
// ============================================================

function stdOf(arr) {
  const n = arr.length;
  let m = 0;
  for (let i = 0; i < n; i++) m += arr[i];
  m /= n;
  let v = 0;
  for (let i = 0; i < n; i++) {
    const d = arr[i] - m;
    v += d * d;
  }
  return Math.sqrt(v / n);
}

/**
 * @param {{r:number,g:number,b:number}[]} rgb - señal uniforme
 * @param {number} fs
 * @returns {Float64Array} señal POS del mismo largo
 */
export function posSignal(rgb, fs) {
  const N = rgb.length;
  const l = Math.round(POS_WINDOW_SEC * fs);
  const H = new Float64Array(N);
  if (N < l) return H;

  const S1 = new Float64Array(l);
  const S2 = new Float64Array(l);
  for (let n = l - 1; n < N; n++) {
    const m = n - l + 1;
    // Media temporal por canal
    let mR = 0, mG = 0, mB = 0;
    for (let k = 0; k < l; k++) {
      mR += rgb[m + k].r;
      mG += rgb[m + k].g;
      mB += rgb[m + k].b;
    }
    mR /= l; mG /= l; mB /= l;
    if (mR <= 1 || mG <= 1 || mB <= 1) continue; // canal casi negro → skip

    // Proyecciones POS: S1 = Gn - Bn ; S2 = -2*Rn + Gn + Bn
    for (let k = 0; k < l; k++) {
      const R = rgb[m + k].r / mR;
      const G = rgb[m + k].g / mG;
      const B = rgb[m + k].b / mB;
      S1[k] = G - B;
      S2[k] = -2 * R + G + B;
    }
    const s1s = stdOf(S1), s2s = stdOf(S2);
    if (s2s < 1e-9) continue;
    const alpha = s1s / s2s;

    // h_window y overlap-add (con remoción de media)
    let sum = 0;
    for (let k = 0; k < l; k++) sum += S1[k] + alpha * S2[k];
    const mean = sum / l;
    for (let k = 0; k < l; k++) H[m + k] += S1[k] + alpha * S2[k] - mean;
  }
  return H;
}

// ============================================================
//  FFT (radix-2 Cooley-Tukey, in-place)
// ============================================================

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * FFT in-place. re, im: Float64Array de largo N (potencia de 2).
 * @param {Float64Array} re
 * @param {Float64Array} im
 */
export function fft(re, im) {
  const n = re.length;
  // Bit-reverse permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }
  // Butterflies
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = (-2 * Math.PI) / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < half; k++) {
        const angle = step * k;
        const c = Math.cos(angle), s = Math.sin(angle);
        const idx = i + k + half;
        const tre = re[idx] * c - im[idx] * s;
        const tim = re[idx] * s + im[idx] * c;
        re[idx] = re[i + k] - tre;
        im[idx] = im[i + k] - tim;
        re[i + k] += tre;
        im[i + k] += tim;
      }
    }
  }
}

/** IFFT via conjugate trick. */
function ifft(re, im) {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] = -im[i] / n;
  }
}

// ============================================================
//  Estimación de HR + SNR desde POS via FFT
// ============================================================

function hannWindow(N) {
  const w = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
  }
  return w;
}

/**
 * @param {Float64Array} H - señal POS
 * @param {number} fs
 * @returns {{bpm:number, snr:number, nfft:number}|null}
 */
export function estimateHR(H, fs) {
  const N = H.length;
  if (N < fs * MIN_SIGNAL_SEC) return null;

  const nfft = Math.max(4096, nextPow2(N));
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  const win = hannWindow(N);
  for (let i = 0; i < N; i++) re[i] = H[i] * win[i];
  fft(re, im);

  const halfN = nfft >> 1;
  const power = new Float64Array(halfN + 1);
  for (let i = 0; i <= halfN; i++) power[i] = re[i] * re[i] + im[i] * im[i];

  const binLo = Math.max(1, Math.floor((BAND_LOW * nfft) / fs));
  const binHi = Math.min(halfN, Math.ceil((BAND_HIGH * nfft) / fs));
  let peakBin = binLo, peakPwr = power[binLo];
  for (let i = binLo + 1; i <= binHi; i++) {
    if (power[i] > peakPwr) {
      peakPwr = power[i];
      peakBin = i;
    }
  }
  const freq = (peakBin * fs) / nfft;
  const bpm = Math.round(freq * 60);

  // SNR = peak / mean(rest of band excluding ±excl bins around peak)
  const excl = 3;
  let sumRest = 0, cntRest = 0;
  for (let i = binLo; i <= binHi; i++) {
    if (Math.abs(i - peakBin) <= excl) continue;
    sumRest += power[i];
    cntRest++;
  }
  const meanRest = cntRest > 0 ? sumRest / cntRest : 1e-12;
  const snrLinear = peakPwr / (meanRest + 1e-12);
  const snrDb = 10 * Math.log10(Math.max(snrLinear, 1e-6));

  return { bpm, snr: snrDb, nfft };
}

// ============================================================
//  HRV latido-a-latido (opcional, confianza baja/media)
// ============================================================

/**
 * Bandpass ± HRV_BAND_HALF alrededor de HR via FFT zero-out + IFFT,
 * después detección de picos y RMSSD/SDNN.
 * @returns {{rmssd:number|null, sdnn:number|null, beats:number}}
 */
export function estimateHRV(H, fs, hrBpm) {
  const N = H.length;
  const nfft = nextPow2(Math.max(N, 2048));
  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  for (let i = 0; i < N; i++) re[i] = H[i];
  fft(re, im);

  const hrFreq = hrBpm / 60;
  const halfN = nfft >> 1;
  const lo = Math.max(1, Math.floor(((hrFreq - HRV_BAND_HALF) * nfft) / fs));
  const hi = Math.min(halfN, Math.ceil(((hrFreq + HRV_BAND_HALF) * nfft) / fs));
  // Zero out todo lo que no esté en [lo, hi] (y su mirror negativo)
  for (let i = 0; i <= halfN; i++) {
    if (i < lo || i > hi) {
      re[i] = 0; im[i] = 0;
      const mirror = nfft - i;
      if (mirror !== i && mirror < nfft) {
        re[mirror] = 0; im[mirror] = 0;
      }
    }
  }
  ifft(re, im);

  // Peak detection sobre la señal filtrada
  const refr = Math.max(1, Math.round(0.35 * fs));
  const peaks = [];
  for (let i = 1; i < N - 1; i++) {
    if (re[i] > re[i - 1] && re[i] > re[i + 1]) {
      if (peaks.length === 0 || i - peaks[peaks.length - 1] >= refr) {
        peaks.push(i);
      }
    }
  }
  if (peaks.length < 6) return { rmssd: null, sdnn: null, beats: 0 };

  // IBIs en ms
  const ibis = [];
  for (let i = 1; i < peaks.length; i++) {
    ibis.push(((peaks[i] - peaks[i - 1]) / fs) * 1000);
  }
  const clean = ibis.filter((x) => x >= 333 && x <= 1714);
  if (clean.length < 5) return { rmssd: null, sdnn: null, beats: 0 };

  let sq = 0;
  for (let i = 1; i < clean.length; i++) {
    const d = clean[i] - clean[i - 1];
    sq += d * d;
  }
  const rmssd = Math.sqrt(sq / (clean.length - 1));
  let m = 0;
  for (const x of clean) m += x;
  m /= clean.length;
  let v = 0;
  for (const x of clean) {
    const d = x - m;
    v += d * d;
  }
  const sdnn = Math.sqrt(v / clean.length);
  return {
    rmssd: +rmssd.toFixed(1),
    sdnn: +sdnn.toFixed(1),
    beats: clean.length + 1,
  };
}

// ============================================================
//  Confianza a partir de SNR
// ============================================================

/**
 * HRV siempre queda un escalón debajo del HR (nunca "inflamos").
 * @param {number} snrDb
 * @param {'hr'|'hrv'} kind
 * @returns {'Alta'|'Media'|'Baja'|'Ninguna'}
 */
export function confFromSnr(snrDb, kind) {
  if (kind === 'hr') {
    if (snrDb >= 10) return 'Alta';
    if (snrDb >= 5) return 'Media';
    if (snrDb >= 2) return 'Baja';
    return 'Ninguna';
  }
  // HRV: cap one step below HR
  if (snrDb >= 10) return 'Media';
  if (snrDb >= 5) return 'Baja';
  return 'Ninguna';
}

// ============================================================
//  Pipeline de alto nivel
// ============================================================

/**
 * @param {{t:number, r:number, g:number, b:number}[]} raw
 * @returns {object} shape compatible con HrvCamara (bpm, rmssd?, sdnn?,
 *   confidence, rmssd_confidence, snr, measurable)
 */
export function analyzeRPPG_v2(raw) {
  const empty = {
    measurable: false,
    bpm: null, rmssd: null, sdnn: null, beats: null,
    confidence: 'Ninguna', rmssd_confidence: 'Ninguna',
    snr: null,
  };
  if (!raw || raw.length < 60) return empty;

  const rgb = resampleUniform(raw, TARGET_FS);
  if (rgb.length < TARGET_FS * MIN_SIGNAL_SEC) return empty;

  const H = posSignal(rgb, TARGET_FS);
  const hrResult = estimateHR(H, TARGET_FS);
  if (!hrResult) return empty;

  const { bpm, snr } = hrResult;
  const snrRounded = +snr.toFixed(1);

  // Plausibilidad fisiológica
  if (bpm < 40 || bpm > 200) {
    return { ...empty, snr: snrRounded };
  }

  const confidence = confFromSnr(snr, 'hr');
  if (confidence === 'Ninguna') {
    return { ...empty, snr: snrRounded };
  }

  // HRV solo si HR confidence ≥ Media
  let rmssd = null, sdnn = null, beats = null, rmssd_confidence = 'Ninguna';
  if (confidence === 'Alta' || confidence === 'Media') {
    const hrv = estimateHRV(H, TARGET_FS, bpm);
    if (hrv.rmssd != null) {
      rmssd = hrv.rmssd;
      sdnn = hrv.sdnn;
      beats = hrv.beats;
      rmssd_confidence = confFromSnr(snr, 'hrv');
    }
  }

  return {
    measurable: true,
    bpm,
    rmssd,
    sdnn,
    beats,
    confidence,
    rmssd_confidence,
    snr: snrRounded,
  };
}
