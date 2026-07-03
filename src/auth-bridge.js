// Puente de sesión desde Reset 3.0.
//
// Al cargar la app, leemos ?uid=&tipo=&token= de la URL. Si están, hacemos
// signInWithCustomToken(token) y limpiamos los params (para que el token no
// quede en historial). Si no están, arrancamos en modo standalone (dev):
// getSession() resuelve { uid:null, tipo:null, standalone:true } y el sink
// hace fallback a descarga local.
//
// Confiamos SIEMPRE en el uid del token (cred.user.uid), no en el uid del
// query param — el token es firmado por Firebase, el param no.

import { auth } from './firebase.js';
import { signInWithCustomToken } from 'firebase/auth';

let _resolve, _reject;
const sessionReady = new Promise((resolve, reject) => {
  _resolve = resolve;
  _reject = reject;
});

async function bootstrap() {
  const params = new URLSearchParams(window.location.search);
  const uidParam = params.get('uid');
  const tipo = params.get('tipo');
  const token = params.get('token');

  if (!uidParam || !tipo || !token) {
    _resolve({ uid: null, tipo: null, standalone: true });
    return;
  }

  try {
    const cred = await signInWithCustomToken(auth, token);
    const uid = cred.user.uid;
    if (uid !== uidParam) {
      console.warn('[auth-bridge] uid param ≠ token uid — uso el del token');
    }

    // El token es sensible. Lo quitamos del history/URL apenas se consumió.
    const clean = new URL(window.location.href);
    clean.searchParams.delete('token');
    clean.searchParams.delete('uid');
    // dejamos tipo para que la UI pueda ajustar el copy (inicial/semanal/final)
    window.history.replaceState({}, '', clean.toString());

    _resolve({ uid, tipo, standalone: false });
  } catch (err) {
    console.error('[auth-bridge] signInWithCustomToken falló:', err);
    _reject(err);
  }
}

bootstrap();

/** @returns {Promise<{uid: string|null, tipo: string|null, standalone: boolean}>} */
export function getSession() {
  return sessionReady;
}
