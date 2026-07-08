// Sink final de la evaluación NeuroScan.
//
// Success path:
//   getSession() → toMedicion() → setDoc() → window.location.href RESET_URL
//
// Failure paths (v2 — sin fallbacks silenciosos):
//   - session rechazó (auth token inválido/expirado) →
//     WriteMetricsError('AUTH_FAILED', ..., medicion, cause)
//   - session standalone en DEV → downloadMedicion + return (comportamiento útil de dev)
//   - session standalone en PROD →
//     WriteMetricsError('STANDALONE', ..., medicion)
//   - setDoc rechazó (rules o red) →
//     WriteMetricsError('FIRESTORE_FAILED', ..., medicion, cause)
//
// El caller (main.js finish()) captura y renderiza una vista de error con
// acciones (reintentar, descargar JSON, ver informe local). Nada silencioso.

import { doc, setDoc } from 'firebase/firestore';
import { db } from './firebase.js';
import { getSession } from './auth-bridge.js';

const RESET_URL = import.meta.env.VITE_RESET_URL || 'https://reset30.vercel.app';

export class WriteMetricsError extends Error {
  /**
   * @param {'AUTH_FAILED'|'STANDALONE'|'FIRESTORE_FAILED'} code
   * @param {string} message   — texto amigable para mostrar al usuario
   * @param {object} medicion  — payload para permitir descarga desde el error UI
   * @param {unknown} [cause]  — error original (Firebase, red, etc.)
   */
  constructor(code, message, medicion, cause) {
    super(message);
    this.name = 'WriteMetricsError';
    this.code = code;
    this.medicion = medicion;
    this.cause = cause;
  }
}

/**
 * Adapta el payload de computeMetrics() a la forma Medicion de Firestore.
 * @param {object} payload
 * @param {'inicial' | 'semanal' | 'cierre' | 'final'} tipo
 */
function toMedicion(payload, tipo) {
  const fecha = new Date().toISOString().split('T')[0];
  const quiz = payload.quiz || {};
  return {
    fecha,
    tipo, // opcional en el schema Medicion (ver reset30/src/types/biometrics.js)
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
        // fuentes.camara.hrv ahora contiene la rPPG (POS + FFT + SNR) — sesión
        // sin dedo aún se registra con datos de cámara. El HRV del dedo se
        // preserva en hrv_dedo (opcional) para cross-validación / histórico.
        hrv: payload.rppg,
        hrv_dedo: payload.hrv,
        oculomotor: {
          blinkRate: payload.blinkRate,
          avgBlinkMs: payload.avgBlinkMs,
          baselineEAR: payload.baselineEAR,
          headStability: payload.headStability,
          saccadeTrackError: payload.saccadeTrackError,
        },
        plr: payload.plr,
        // confianza_general viene del HR de rPPG (fuente cámara canónica).
        confianza_general: payload.rppg?.confidence || 'Ninguna',
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
      // lo deja null y que la lógica agregadora de Reset 3.0 lo compute cuando
      // haya suficiente info (idealmente reloj+cámara+subjetivo).
      fuentePrincipal: 'camara',
      indiceCompuesto: null,
      tendenciaSemana: 'sin_datos',
    },
  };
}

/**
 * Escribe la medición a Firestore y redirige a Reset 3.0.
 * En caso de falla, arroja WriteMetricsError que el caller muestra en UI.
 * @param {object} payload — salida de computeMetrics()
 */
export async function writeMetrics(payload) {
  console.log('[neuroscan] metrics payload', payload);
  let session;
  try {
    session = await getSession();
  } catch (err) {
    console.error('[neuroscan] auth-bridge falló:', err);
    throw new WriteMetricsError(
      'AUTH_FAILED',
      'No pudimos verificar tu sesión de Reset 3.0. El link puede haber vencido o el token es inválido.',
      toMedicion(payload, 'inicial'),
      err
    );
  }

  const medicion = toMedicion(payload, session.tipo || 'inicial');

  if (session.standalone || !session.uid) {
    if (import.meta.env.DEV) {
      // En dev tirar los datos a un JSON local es útil.
      console.log('[neuroscan] dev standalone → descargando JSON local, sin write/redirect');
      downloadMedicion(medicion);
      return;
    }
    throw new WriteMetricsError(
      'STANDALONE',
      'Esta app se abre desde Reset 3.0. Si llegaste acá directamente, volvé a Reset 3.0 y tocá "Comenzar evaluación".',
      medicion,
      null
    );
  }

  try {
    const ref = doc(db, 'usuarios', session.uid, 'mediciones', medicion.fecha);
    await setDoc(ref, medicion);
    console.log('[neuroscan] Firestore write OK →', ref.path);
  } catch (err) {
    console.error('[neuroscan] Firestore write falló:', err);
    throw new WriteMetricsError(
      'FIRESTORE_FAILED',
      'La medición no pudo guardarse en la nube. Puede ser un problema temporal de red o de permisos.',
      medicion,
      err
    );
  }

  // Todo OK — redirect a Reset 3.0 para que dispare el modal de resultado.
  const url = new URL(RESET_URL);
  url.searchParams.set('evaluacion', 'completa');
  window.location.href = url.toString();
}

/**
 * Descarga la medición como JSON local. Usada desde la UI de error cuando el
 * user quiere no perder los datos si el upload falla.
 * @param {object} medicion
 */
export function downloadMedicion(medicion) {
  try {
    const blob = new Blob([JSON.stringify(medicion, null, 2)], {
      type: 'application/json',
    });
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
