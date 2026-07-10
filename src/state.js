export const bio = {
  quiz: {},
  hrv: {
    raw: [], peaks: [], ibis: [], bpm: null, rmssd: null, sdnn: null,
    confidence: 'Ninguna', measurable: false,
    diag: { torch: 'desconocido', avgR: null, ampPct: null },
  },
  rppg: {
    raw: [],
    bpm: null, rmssd: null, sdnn: null, beats: null,
    confidence: 'Ninguna', rmssd_confidence: 'Ninguna',
    snr: null, measurable: false,
  },
  xval: { bpmDiff: null, agreement: null },
  blink: {
    count: 0,
    durations: [],
    ear: [],
    calibratedThreshold: null,  // umbral EAR adaptativo del usuario (median*0.75)
    countingSec: null,           // duración efectiva de conteo, tras 2s de calibración
  },
  saccade: { targets: [], gaze: [], errors: [] },
  headJitter: [],
  plr: { baselineDark: [], response: [], measurable: false, constriction: null, latencyMs: null },
};

export const questions = [
  { id: 'stress', q: '¿Cómo calificarías tu tensión mental ahora?', opts: ['Baja', 'Moderada', 'Alta'] },
  { id: 'energy', q: '¿Tu nivel de energía física percibida?', opts: ['Poca', 'Normal', 'Mucha'] },
  { id: 'fatigue', q: '¿Sentís fatiga o pesadez en los ojos?', opts: ['No', 'Algo', 'Bastante'] },
];
