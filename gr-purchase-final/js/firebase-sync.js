/**
 * GR Purchase v3 — Firebase Sync Layer
 * ════════════════════════════════════════════════════════════════
 * Drop-in replacement for the in-memory data layer.
 * Handles:
 *  - Firebase Auth (sign-in, sign-out, session persistence)
 *  - Firestore CRUD for sheets / rows / columns / boundaries
 *  - Real-time listeners (onSnapshot) for live collaboration
 *  - Batch writes (up to 500 ops / batch)
 *  - Activity log writes
 *  - Offline persistence (enableIndexedDbPersistence)
 *  - Exponential backoff retry on transient failures
 *
 * Usage:
 *   import { FirebaseSync } from './js/firebase-sync.js';
 *   const sync = new FirebaseSync(firebaseConfig);
 *   await sync.init();
 *   await sync.signIn(email, password);
 * ════════════════════════════════════════════════════════════════
 */

'use strict';

/* ─────────────────────────────────────────────────────────────
   FIREBASE SDK  (loaded via CDN in HTML — compat mode)
   Replace with modular imports if using a bundler:
   import { initializeApp } from 'firebase/app';
───────────────────────────────────────────────────────────── */

const SHEET_NAMES    = ['Purchases', 'Kasa', 'Barcode', 'Phinex'];
const MAX_BATCH_OPS  = 490;   // Firestore limit is 500, stay under
const RETRY_DELAYS   = [300, 800, 2000, 5000]; // ms, exponential backoff

/* ─────────────────────────────────────────────────────────────
   FIREBASE SYNC CLASS
───────────────────────────────────────────────────────────── */
class FirebaseSync {
  /**
   * @param {object} config  - Firebase project config object
   */
  constructor(config) {
    this._config    = config;
    this._app       = null;
    this._auth      = null;
    this._db        = null;
    this._user      = null;       // current Firebase user
    this._listeners = new Map();  // key → unsubscribe fn
    this._logQueue  = [];         // pending log entries
    this._logTimer  = null;
  }

  /* ── Initialization ── */

  async init() {
    // Initialize Firebase app (idempotent)
    if (!firebase.apps.length) {
      this._app = firebase.initializeApp(this._config);
    } else {
      this._app = firebase.apps[0];
    }

    this._auth = firebase.auth();
    this._db   = firebase.firestore();

    // Enable offline persistence (IndexedDB)
    try {
      await this._db.enablePersistence({ synchronizeTabs: true });
    } catch (err) {
      if (err.code === 'failed-precondition') {
        console.warn('[FirebaseSync] Multiple tabs open — persistence disabled in this tab');
      } else if (err.code === 'unimplemented') {
        console.warn('[FirebaseSync] Browser does not support offline persistence');
      }
    }

    // Auth state listener
    this._auth.onAuthStateChanged(user => {
      this._user = user;
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('gr:auth-change', { detail: { user } }));
      }
    });

    return this;
  }

  /* ── Auth ── */

  /**
   * Sign in with email + password.
   * @returns {Promise<object>} user profile from /users/{uid}
   */
  async signIn(email, password) {
    const cred = await this._auth.signInWithEmailAndPassword(email, password);
    this._user = cred.user;

    // Fetch user profile
    const profileDoc = await this._db
      .collection('users')
      .doc(this._user.uid)
      .get();

    if (!profileDoc.exists) throw new Error('user-not-found-in-db');

    const profile = profileDoc.data();

    // Update lastSeen
    await this._db.collection('users').doc(this._user.uid).update({
      lastSeen:  firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    return profile;
  }

  async signOut() {
    this._stopAllListeners();
    await this._auth.signOut();
    this._user = null;
  }

  async sendPasswordReset(email) {
    await this._auth.sendPasswordResetEmail(email);
  }

  get currentUser() { return this._user; }
  get isSignedIn()  { return !!this._user; }

  /* ── User Profile ── */

  async getUserProfile(uid) {
    const doc = await this._db.collection('users').doc(uid).get();
    return doc.exists ? doc.data() : null;
  }

  async createUser(uid, profile) {
    await this._db.collection('users').doc(uid).set({
      ...profile,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  async updateUser(uid, patch) {
    await this._db.collection('users').doc(uid).update({
      ...patch,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  async listUsers() {
    // In production, use Admin SDK via Cloud Function
    // Client-side: fetch from /users collection (requires admin role)
    const snap = await this._db.collection('users').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  /* ── Branch / Sheet Metadata ── */

  /**
   * Save column definitions for a sheet.
   * Stored at: /branches/{branchId}/sheets/{sheetName}  (doc field: columns)
   */
  async saveColumns(branchId, sheetName, columns) {
    await this._retry(() =>
      this._sheetRef(branchId, sheetName).set(
        { columns, updatedAt: firebase.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      )
    );
    this._queueLog(branchId, 'UPDATE_COLUMN', sheetName, { count: columns.length });
  }

  /**
   * Load column definitions for a sheet.
   * @returns {ColumnDef[]}
   */
  async loadColumns(branchId, sheetName) {
    const doc = await this._sheetRef(branchId, sheetName).get();
    return doc.exists ? (doc.data().columns ?? []) : [];
  }

  /**
   * Save invoice boundaries (Purchases sheet only).
   */
  async saveBoundaries(branchId, boundaries) {
    await this._retry(() =>
      this._sheetRef(branchId, 'Purchases').set(
        { invoiceBoundaries: [...boundaries], updatedAt: firebase.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      )
    );
  }

  async loadBoundaries(branchId) {
    const doc = await this._sheetRef(branchId, 'Purchases').get();
    return doc.exists ? (doc.data().invoiceBoundaries ?? []) : [];
  }

  /* ── Row CRUD ── */

  /**
   * Save a single row to Firestore.
   * Row ID = rowIndex (zero-padded for lexicographic ordering).
   * @param {string}  branchId
   * @param {string}  sheetName
   * @param {number}  rowIndex
   * @param {object|null} data  - null means delete the row
   */
  async saveRow(branchId, sheetName, rowIndex, data) {
    const ref = this._rowRef(branchId, sheetName, rowIndex);

    if (!data || Object.keys(data).length === 0) {
      await this._retry(() => ref.delete());
    } else {
      await this._retry(() => ref.set({
        ...data,
        _rowIndex:  rowIndex,
        _updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        _updatedBy: this._user?.uid ?? 'unknown',
        _createdAt: firebase.firestore.FieldValue.serverTimestamp(), // ignored if already set due to merge
        _createdBy: this._user?.uid ?? 'unknown',
      }, { merge: true }));
    }
  }

  /**
   * Batch save multiple rows (efficient for paste operations).
   * Automatically splits into batches of MAX_BATCH_OPS.
   * @param {string}  branchId
   * @param {string}  sheetName
   * @param {Array<{rowIndex, data}>} rows
   */
  async saveRowsBatch(branchId, sheetName, rows) {
    const chunks = this._chunk(rows, MAX_BATCH_OPS);

    for (const chunk of chunks) {
      const batch = this._db.batch();
      for (const { rowIndex, data } of chunk) {
        const ref = this._rowRef(branchId, sheetName, rowIndex);
        if (!data || Object.keys(data).length === 0) {
          batch.delete(ref);
        } else {
          batch.set(ref, {
            ...data,
            _rowIndex:  rowIndex,
            _updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            _updatedBy: this._user?.uid ?? 'unknown',
          }, { merge: true });
        }
      }
      await this._retry(() => batch.commit());
    }

    this._queueLog(branchId, 'PASTE', sheetName, { count: rows.length });
  }

  /**
   * Load rows in a range (for virtual scroll pagination).
   * @returns {Array<{rowIndex, data}>}
   */
  async loadRows(branchId, sheetName, startRow, endRow) {
    const snap = await this._retry(() =>
      this._rowsCollection(branchId, sheetName)
        .where('_rowIndex', '>=', startRow)
        .where('_rowIndex', '<=', endRow)
        .orderBy('_rowIndex')
        .get()
    );

    return snap.docs.map(d => {
      const raw = d.data();
      // Strip meta fields before passing to engine
      const data = {};
      for (const [k, v] of Object.entries(raw)) {
        if (!k.startsWith('_')) data[k] = v;
      }
      return { rowIndex: raw._rowIndex, data };
    });
  }

  /**
   * Delete all rows from a sheet (dangerous — admin only in production).
   */
  async clearSheet(branchId, sheetName) {
    const snap  = await this._rowsCollection(branchId, sheetName).get();
    const batch = this._db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
  }

  /* ── Real-time Listeners ── */

  /**
   * Listen for real-time row changes in a viewport range.
   * Calls onUpdate({ rowIndex, data }) whenever a row changes.
   * @returns {function} unsubscribe
   */
  onRowsChange(branchId, sheetName, startRow, endRow, onUpdate, onError) {
    const key = `rows:${branchId}:${sheetName}:${startRow}-${endRow}`;
    this._stopListener(key);

    const unsub = this._rowsCollection(branchId, sheetName)
      .where('_rowIndex', '>=', startRow)
      .where('_rowIndex', '<=', endRow)
      .orderBy('_rowIndex')
      .onSnapshot(
        snap => {
          snap.docChanges().forEach(change => {
            if (change.type === 'removed') {
              onUpdate({ rowIndex: change.doc.data()._rowIndex, data: null });
              return;
            }
            const raw  = change.doc.data();
            const data = {};
            for (const [k, v] of Object.entries(raw)) {
              if (!k.startsWith('_')) data[k] = v;
            }
            onUpdate({ rowIndex: raw._rowIndex, data });
          });
        },
        err => onError?.(err)
      );

    this._listeners.set(key, unsub);
    return () => this._stopListener(key);
  }

  /**
   * Listen for column definition changes.
   */
  onColumnsChange(branchId, sheetName, onUpdate) {
    const key = `cols:${branchId}:${sheetName}`;
    this._stopListener(key);

    const unsub = this._sheetRef(branchId, sheetName)
      .onSnapshot(snap => {
        if (snap.exists) onUpdate(snap.data().columns ?? []);
      });

    this._listeners.set(key, unsub);
    return () => this._stopListener(key);
  }

  stopListening(branchId, sheetName) {
    for (const key of this._listeners.keys()) {
      if (key.includes(`${branchId}:${sheetName}`)) this._stopListener(key);
    }
  }

  /* ── Activity Log ── */

  /**
   * Queue a log entry (batched every 2s to avoid hammering Firestore).
   */
  _queueLog(branchId, action, sheetName, meta = {}) {
    if (!this._user) return;
    this._logQueue.push({ branchId, action, sheetName, meta });
    if (!this._logTimer) {
      this._logTimer = setTimeout(() => this._flushLog(), 2000);
    }
  }

  async _flushLog() {
    this._logTimer = null;
    const entries  = this._logQueue.splice(0);
    if (!entries.length || !this._user) return;

    // Group by branch
    const byBranch = {};
    for (const e of entries) {
      if (!byBranch[e.branchId]) byBranch[e.branchId] = [];
      byBranch[e.branchId].push(e);
    }

    for (const [branchId, group] of Object.entries(byBranch)) {
      const chunks = this._chunk(group, MAX_BATCH_OPS);
      for (const chunk of chunks) {
        const batch = this._db.batch();
        for (const e of chunk) {
          const ref = this._db
            .collection('branches').doc(branchId)
            .collection('log').doc();
          batch.set(ref, {
            uid:       this._user.uid,
            userName:  this._user.displayName ?? this._user.email,
            action:    e.action,
            sheetName: e.sheetName,
            meta:      e.meta,
            timestamp: firebase.firestore.FieldValue.serverTimestamp(),
            device:    this._getDevice(),
          });
        }
        await batch.commit().catch(err => console.warn('[FirebaseSync] Log flush failed:', err));
      }
    }
  }

  /**
   * Public wrapper for queued/batched logging — prefer this over calling
   * _queueLog directly from outside the class. Batches writes every ~2s
   * to avoid one Firestore write per keystroke on high-frequency actions
   * like cell edits.
   */
  queueLog(branchId, action, sheetName, meta = {}) {
    this._queueLog(branchId, action, sheetName, meta);
  }

  /**
   * Write a single log entry immediately (for critical actions).
   */
  async writeLog(branchId, action, sheetName, meta = {}) {
    if (!this._user) return;
    await this._db
      .collection('branches').doc(branchId)
      .collection('log').add({
        uid:       this._user.uid,
        userName:  this._user.displayName ?? this._user.email,
        action,
        sheetName,
        meta,
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        device:    this._getDevice(),
      });
  }

  /**
   * Load activity log with filters.
   * @returns {Array<object>}
   */
  async loadLog(branchId, {
    limitCount = 100,
    startAfter = null,
    uid        = null,
    action     = null,
    sheetName  = null,
  } = {}) {
    let q = this._db
      .collection('branches').doc(branchId)
      .collection('log')
      .orderBy('timestamp', 'desc')
      .limit(limitCount);

    if (uid)       q = q.where('uid', '==', uid);
    if (action)    q = q.where('action', '==', action);
    if (sheetName) q = q.where('sheetName', '==', sheetName);
    if (startAfter) q = q.startAfter(startAfter);

    const snap = await q.get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  }

  /* ── Branch Config ── */

  async saveBranchConfig(branchId, config) {
    await this._db.collection('branches').doc(branchId)
      .collection('meta').doc('config')
      .set({ ...config, updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
  }

  async loadBranchConfig(branchId) {
    const doc = await this._db.collection('branches').doc(branchId)
      .collection('meta').doc('config').get();
    return doc.exists ? doc.data() : null;
  }

  /* ── System Config ── */

  async loadSystemConfig() {
    const doc = await this._db.collection('config').doc('system').get();
    return doc.exists ? doc.data() : {};
  }

  async saveSystemConfig(data) {
    await this._db.collection('config').doc('system').set(
      { ...data, updatedAt: firebase.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
  }

  /* ── Private Helpers ── */

  _sheetRef(branchId, sheetName) {
    return this._db
      .collection('branches').doc(branchId)
      .collection('sheets').doc(sheetName);
  }

  _rowsCollection(branchId, sheetName) {
    return this._sheetRef(branchId, sheetName).collection('rows');
  }

  _rowRef(branchId, sheetName, rowIndex) {
    // Zero-pad to 6 digits for natural Firestore ordering
    const id = String(rowIndex).padStart(6, '0');
    return this._rowsCollection(branchId, sheetName).doc(id);
  }

  _stopListener(key) {
    const unsub = this._listeners.get(key);
    if (unsub) { unsub(); this._listeners.delete(key); }
  }

  _stopAllListeners() {
    for (const unsub of this._listeners.values()) unsub();
    this._listeners.clear();
  }

  /**
   * Retry a Firestore operation with exponential backoff.
   */
  async _retry(fn, attempt = 0) {
    try {
      return await fn();
    } catch (err) {
      const retryable = [
        'unavailable', 'deadline-exceeded', 'resource-exhausted', 'internal',
      ];
      if (attempt < RETRY_DELAYS.length && retryable.includes(err.code)) {
        await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
        return this._retry(fn, attempt + 1);
      }
      throw err;
    }
  }

  _chunk(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  _getDevice() {
    const ua = navigator.userAgent;
    if (/iPhone|iPad/.test(ua)) return 'iOS';
    if (/Android/.test(ua))     return 'Android';
    if (/Mac/.test(ua))         return 'macOS';
    if (/Win/.test(ua))         return 'Windows';
    return 'Unknown';
  }
}

/* ─────────────────────────────────────────────────────────────
   SINGLETON EXPORT
───────────────────────────────────────────────────────────── */
let _syncInstance = null;

/**
 * Get or create the FirebaseSync singleton.
 * Call initFirebase(config) first.
 */
function getSync() {
  if (!_syncInstance) throw new Error('FirebaseSync not initialized. Call initFirebase(config) first.');
  return _syncInstance;
}

async function initFirebase(config) {
  _syncInstance = new FirebaseSync(config);
  await _syncInstance.init();
  return _syncInstance;
}

// ES Module
if (typeof module !== 'undefined') {
  module.exports = { FirebaseSync, initFirebase, getSync };
}
// Browser global
if (typeof window !== 'undefined') {
  window.GRFirebase = { FirebaseSync, initFirebase, getSync };
}
