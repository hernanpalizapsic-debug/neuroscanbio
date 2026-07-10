// NeuroScan — entry point.
// Flow: start → quiz → HRV (finger+flash) → facial (rPPG + blink + saccade + PLR)
//       → computeMetrics → writeMetrics → redirect a Reset 3.0
//
// Manejo de error: si writeMetrics tira WriteMetricsError, mostramos una vista
// de error con acciones (reintentar / descargar JSON / ver informe local).
// Nada silencioso — el user siempre sabe qué pasó y qué opciones tiene.
//
// Guard adicional: en PROD, si la app se abrió SIN token de Reset 3.0
// (?uid=&tipo=&token=), no arrancamos el quiz — mostramos un cartel apuntando
// a Reset 3.0. En DEV eso está permitido para poder probar la eval standalone.

import { bio } from './state.js';
import { mean, std, median } from './utils.js';
import { show, log, speak, renderQuiz, renderReport, renderError } from './ui.js';
import { startHRV, bindHrvButton } from './hrv.js';
import { startFace } from './facial.js';
import { taskPLR } from './plr.js';
import { writeMetrics, downloadMedicion, WriteMetricsError } from './metrics-sink.js';
import { getSession } from './auth-bridge.js';

const RESET_URL = import.meta.env.VITE_RESET_URL || 'https://reset30.vercel.app';

function computeMetrics() {
  // Escala a per-minute usando la duración efectiva de conteo (tras 2s de
  // calibración adaptativa). Fallback a 8s si no hubo calibración (ej. la
  // fase se cortó temprano).
  const countingSec = bio.blink.countingSec || 8;
  const blinkRate = Math.round(bio.blink.count / (countingSec / 60));
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
    rppg: bio.rppg.measurable
      ? {
          ok: true,
          bpm: bio.rppg.bpm,
          rmssd: bio.rppg.rmssd,
          sdnn: bio.rppg.sdnn,
          beats: bio.rppg.beats,
          confidence: bio.rppg.confidence,
          rmssd_confidence: bio.rppg.rmssd_confidence,
          snr: bio.rppg.snr,
        }
      : { ok: false, snr: bio.rppg.snr, confidence: bio.rppg.confidence },
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

/**
 * Guard antes de arrancar la eval:
 * - En DEV, siempre dejamos arrancar (útil para probar el flow local).
 * - En PROD, si no hay sesión de Reset 3.0, mostramos error y no arrancamos.
 * @returns {Promise<boolean>} true si podés arrancar la eval
 */
async function puedeArrancar() {
  if (import.meta.env.DEV) return true;
  try {
    const session = await getSession();
    if (session.standalone || !session.uid) {
      renderError({
        title: 'Esta app se abre desde Reset 3.0',
        message:
          'Para hacer tu evaluación, volvé a Reset 3.0 y tocá "Comenzar evaluación". El link tiene que traer tu token de sesión.',
        actions: [
          {
            label: 'Ir a Reset 3.0',
            variant: 'primary',
            onClick: () => {
              window.location.href = RESET_URL;
            },
          },
        ],
      });
      return false;
    }
    return true;
  } catch (err) {
    renderError({
      title: 'No pudimos verificar tu sesión',
      message:
        'El token de acceso no pudo validarse. Puede haber vencido o hay un problema con la configuración de Firebase. Volvé a abrir la evaluación desde Reset 3.0.',
      detail: err?.message || String(err),
      actions: [
        {
          label: 'Ir a Reset 3.0',
          variant: 'primary',
          onClick: () => {
            window.location.href = RESET_URL;
          },
        },
      ],
    });
    return false;
  }
}

async function finish() {
  show('view-loading');
  log('computing');
  const payload = computeMetrics();
  try {
    await writeMetrics(payload);
    // Si writeMetrics resolvió sin error, ya disparó window.location.href
    // y la página está por navegar. No hacemos nada más.
  } catch (err) {
    const isKnown = err instanceof WriteMetricsError;
    const medicion = isKnown ? err.medicion : payload;

    const title =
      !isKnown
        ? 'Ups, algo falló'
        : err.code === 'STANDALONE'
        ? 'Esta app se abre desde Reset 3.0'
        : err.code === 'AUTH_FAILED'
        ? 'No pudimos verificar tu sesión'
        : 'La medición no se pudo guardar';

    const detail = isKnown
      ? err.cause?.message || err.cause?.code || ''
      : err?.message || String(err);

    renderError({
      title,
      message: isKnown
        ? err.message
        : 'Ocurrió un error inesperado al finalizar la evaluación. Podés descargar tus métricas o ver el informe local.',
      detail,
      actions: [
        {
          label: 'Reintentar subida',
          variant: 'primary',
          onClick: () => finish(),
        },
        {
          label: 'Descargar mis métricas (JSON)',
          onClick: () => downloadMedicion(medicion),
        },
        {
          label: 'Ver informe local',
          onClick: () => renderReport(payload),
        },
      ],
    });
  }
}

function startFacePhase() {
  return startFace({ runPLR: taskPLR, onComplete: finish });
}

document.getElementById('btn-init').onclick = async () => {
  const ok = await puedeArrancar();
  if (!ok) return;
  speak('Iniciando protocolo. Respondé las preguntas.');
  show('view-quiz');
  renderQuiz(() => startHRV());
  log('quiz_active');
};

bindHrvButton(() => startFacePhase());
