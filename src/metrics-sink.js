// Sink for the final metrics JSON.
// Default: log to console + download a .json file. Replace the body of
// writeMetrics() (or swap in writeMetricsToFirestore) once you have Firebase
// config to plug in.

/**
 * @param {object} payload - the metrics object returned by computeMetrics()
 * @returns {Promise<void>}
 */
export async function writeMetrics(payload) {
  console.log('[neuroscan] metrics payload', payload);
  try {
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
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
    console.warn('[neuroscan] local download failed', e);
  }
  // TODO(firestore): once Firebase config is available, swap this body for:
  //   await writeMetricsToFirestore(payload);
}

/* --- Firestore wiring (uncomment + fill when ready) ---------------------

import { initializeApp } from 'firebase/app';
import { getFirestore, collection, addDoc, serverTimestamp } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  // ...
};

let _db = null;
function db() {
  if (!_db) _db = getFirestore(initializeApp(firebaseConfig));
  return _db;
}

export async function writeMetricsToFirestore(payload) {
  const ref = await addDoc(collection(db(), 'neuroscan_runs'), {
    ...payload,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

------------------------------------------------------------------------ */
