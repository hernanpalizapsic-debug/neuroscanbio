// Sink final de la evaluación NeuroScan.
//
// Dos modos según getSession():
//   - session bridge (uid+tipo+token vinieron de Reset 3.0):
//       shape a Medicion, escribir en usuarios/{uid}/mediciones/{fechaISO},
//       redirigir a RESET_URL?evaluacion=completa.
//   - standalone (dev, sin token): fallback = descarga JSON local, sin write.
//
// El shape de Medicion vive documentado en Reset 3.0/src/types/biometrics.js.
// Acá lo replicamos en toMedicion() porque son deploys separados y no
// compartimos módulos.

import { doc, setDoc } from 'firebase/firestore';
import { db } from './firebase.js';
import { getSession } from './auth-bridge.js';

const RESET_URL = import.meta.env.VITE_RESET_URL || 'https://reset30.vercel.app';

/**
 * Adapta el payload de computeMetrics() a la forma Medicion de Firestore.
 * @param {object} payload
 * @param {string} tipo — 'inicial' | 'semanal' | 'final'
 */
function toMedicion(payload, tipo) {
  const fecha = new Date().toISOString().split('T')[0];
  const quiz = payload.quiz || {};
  return {
    fecha,
    tipo, // guardamos qué evaluación disparó Reset 3.0 (inicial/semanal/final)
    fuentes: {
      // fuentes.reloj debe existir con disponible:false para que las rules
      // acepten el create (ver relojNoDeclarado en firestore.rules).
      reloj: {
        disponible: false,
        dispositivo: null,
        hrv_rmssd_nocturno: null,
        fechaSueno: null,
        confianza: 'Ninguna',
      },
      camara: {
        disponible: true,
        hrv: payload.hrv,
        oculomotor: {
          blinkRate: payload.blinkRate,
          avgBlinkMs: payload.avgBlinkMs,
          baselineEAR: payload.baselineEAR,
          headStability: payload.headStability,
          saccadeTrackError: payload.saccadeTrackError,
        },
        plr: payload.plr,
        confianza_general: payload.hrv?.confidence || 'Ninguna',
      },
      // El quiz local usa keys en inglés (stress/energy/fatigue); el contrato
      // Firestore las quiere en castellano. Mapeamos acá para no tocar state.js.
      subjetivo: {
        tension: quiz.stress ?? null,
        energia: quiz.energy ?? null,
        fatiga: quiz.fatigue ?? null,
      },
    },
    resumen: {
      // Con solo fuente cámara no tiene sentido inventar un índice compuesto:
      // dejamos null y que la lógica agregadora de Reset 3.0 lo compute cuando
      // tenga suficientes fuentes (idealmente reloj+cámara+subjetivo).
      fuentePrincipal: 'camara',
      indiceCompuesto: null,
      tendenciaSemana: 'sin_datos',
    },
  };
}

/**
 * @param {object} payload - salida de computeMetrics()
 */
export async function writeMetrics(payload) {
  console.log('[neuroscan] metrics payload', payload);
  let session;
  try {
    session = await getSession();
  } catch (err) {
    console.warn('[neuroscan] auth-bridge falló, fallback a descarga local', err);
    downloadJson(payload);
    return;
  }

  const medicion = toMedicion(payload, session.tipo || 'standalone');

  if (session.standalone || !session.uid) {
    // Dev sin sesión: descarga JSON local, sin write ni redirect.
    downloadJson(medicion);
    return;
  }

  try {
    const ref = doc(db, 'usuarios', session.uid, 'mediciones', medicion.fecha);
    await setDoc(ref, medicion);
    console.log('[neuroscan] Firestore write OK →', ref.path);
  } catch (err) {
    console.error('[neuroscan] Firestore write falló:', err);
    // No redirigimos si falló el write — el user vería un modal "sin evaluación".
    // Fallback: descargar el JSON así al menos no se pierde la medición.
    downloadJson(medicion);
    throw err;
  }

  // Redirige de vuelta a Reset 3.0 para que dispare el modal de resultado.
  const url = new URL(RESET_URL);
  url.searchParams.set('evaluacion', 'completa');
  window.location.href = url.toString();
}

function downloadJson(obj) {
  try {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    a.download = `neuroscan-${ts}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.warn('[neuroscan] descarga local falló', e);
  }
}
