'use client';
// Client-SDK Firestore init. In emulator mode we connect to the local
// emulator (no GCP, no creds); in cloud mode we use the web config the plugin
// was given. Reads are governed by Firestore security rules (owner-only).
import { getApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  connectFirestoreEmulator,
  getFirestore,
  type Firestore,
} from 'firebase/firestore';
import type { BoardConfig } from './types';

let cached: Firestore | null = null;

export function getDb(cfg: BoardConfig): Firestore {
  if (cached) return cached;
  let app: FirebaseApp;
  if (getApps().length) {
    app = getApp();
  } else if (cfg.firestoreMode === 'cloud' && cfg.firebase) {
    app = initializeApp(cfg.firebase);
  } else {
    app = initializeApp({ projectId: cfg.gcpProjectId || 'ks-flow-emulator' });
  }
  const db = getFirestore(app);
  if (cfg.firestoreMode === 'emulator') {
    try {
      connectFirestoreEmulator(db, '127.0.0.1', 8080);
    } catch {
      // already connected (HMR) — ignore
    }
  }
  cached = db;
  return db;
}
