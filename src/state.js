export const bio = {
  quiz: {},
  hrv: {
    raw: [], peaks: [], ibis: [], bpm: null, rmssd: null, sdnn: null,
    confidence: 'Ninguna', measurable: false,
    diag: { torch: 'desconocido', avgR: null, ampPct: null },
  },
  rppg: { raw: [], bpm: null, measurable: false },
  xval: { bpmDiff: null, agreement: null },
  blink: { count: 0, durations: [], ear: [] },
  saccade: { targets: [], gaze: [], errors: [] },
  headJitter: [],
  plr: { baselineDark: [], response: [], measurable: false, constriction: null, latencyMs: null },
};

export const questions = [
  { id: 'stress', q: '¿Cómo calificarías tu tensión mental ahora?', opts: ['Baja', 'Moderada', 'Alta'] },
  { id: 'energy', q: '¿Tu nivel de energía física percibida?', opts: ['Poca', 'Normal', 'Mucha'] },
  { id: 'fatigue', q: '¿Sentís fatiga o pesadez en los ojos?', opts: ['No', 'Algo', 'Bastante'] },
];
