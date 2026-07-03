// NeuroScan v18 — entry point.
// Flow: start → quiz → HRV (finger+flash) → facial (rPPG + blink + saccade + PLR)
//       → computeMetrics → writeMetrics → renderReport
//
// Measurement logic intentionally preserved verbatim from the v18 prototype;
// only orchestration and DOM wiring were moved into modules.

import { bio } from './state.js';
import { mean, std, median } from './utils.js';
import { show, log, speak, renderQuiz, renderReport } from './ui.js';
import { startHRV, bindHrvButton } from './hrv.js';
import { startFace } from './facial.js';
import { taskPLR } from './plr.js';
import { writeMetrics } from './metrics-sink.js';

function computeMetrics() {
  const blinkRate = Math.round(bio.blink.count / (8 / 60));
  const jx = bio.headJitter.map((p) => p.x);
  const jy = bio.headJitter.map((p) => p.y);
  return {
    hrv: bio.hrv.measurable
      ? {
          ok: true,
          bpm: bio.hrv.bpm,
          rmssd: bio.hrv.rmssd,
          sdnn: bio.hrv.sdnn,
          beats: bio.hrv.ibis.length,
          confidence: bio.hrv.confidence,
        }
      : { ok: false, diag: bio.hrv.diag, beatsDetected: bio.hrv.peaks.length },
    rppg: bio.rppg.measurable ? { ok: true, bpm: bio.rppg.bpm } : { ok: false },
    crossValidation: bio.xval.agreement
      ? { agreement: bio.xval.agreement, bpmDiff: bio.xval.bpmDiff }
      : null,
    blinkRate,
    avgBlinkMs: Math.round(mean(bio.blink.durations) || 0),
    baselineEAR: +(median(bio.blink.ear) || 0).toFixed(3),
    headStability: +(((std(jx) + std(jy)) / 2) * 1000).toFixed(2),
    saccadeTrackError: +((mean(bio.saccade.errors) || 0) * 100).toFixed(1),
    plr: bio.plr.measurable
      ? { ok: true, constriction: bio.plr.constriction, latency: bio.plr.latencyMs }
      : { ok: false },
    quiz: bio.quiz,
    timestamp: new Date().toISOString(),
  };
}

async function finish() {
  show('view-loading');
  log('computing');
  const payload = computeMetrics();
  try {
    await writeMetrics(payload);
  } catch (e) {
    console.warn('[neuroscan] writeMetrics failed', e);
  }
  renderReport(payload);
}

function startFacePhase() {
  return startFace({ runPLR: taskPLR, onComplete: finish });
}

document.getElementById('btn-init').onclick = () => {
  speak('Iniciando protocolo. Respondé las preguntas.');
  show('view-quiz');
  renderQuiz(() => startHRV());
  log('quiz_active');
};

bindHrvButton(() => startFacePhase());
