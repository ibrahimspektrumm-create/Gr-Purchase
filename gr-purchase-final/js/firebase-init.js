/**
 * GR Purchase v3 — Firebase Initializer & Integration Glue
 * ════════════════════════════════════════════════════════════════
 * Drop this script in every HTML page.
 * It wires FirebaseSync ↔ SheetController ↔ VirtualRenderer
 * and handles the session + auth flow automatically.
 * ════════════════════════════════════════════════════════════════
 *
 * HOW TO USE
 * ──────────
 * 1. Replace the placeholder values in FIREBASE_CONFIG below
 *    with your real Firebase project credentials.
 *
 * 2. Add these two script tags to every HTML page BEFORE your
 *    own scripts (engine.js, workspace.js, etc.):
 *
 *    <!-- Firebase compat SDK -->
 *    <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
 *    <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-auth-compat.js"></script>
 *    <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore-compat.js"></script>
 *
 *    <!-- GR Purchase -->
 *    <script src="js/firebase-sync.js"></script>
 *    <script src="js/firebase-init.js"></script>
 *
 * 3. In your page's JS, use:
 *    const sync = window.GRFirebase.getSync();
 *    const session = GRSession.get();
 * ════════════════════════════════════════════════════════════════
 */

'use strict';

/* ─────────────────────────────────────────────────────────────
   ★  REPLACE THESE WITH YOUR FIREBASE PROJECT CONFIG  ★
   Get them from: Firebase Console → Project Settings → General
───────────────────────────────────────────────────────────── */
const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyDoZNTTRe5XhHNoUlY_Ze3LB6M9tRUUAIw',
  authDomain:        'gr-pur.firebaseapp.com',
  projectId:         'gr-pur',
  storageBucket:     'gr-pur.firebasestorage.app',
  messagingSenderId: '390252045427',
  appId:             '1:390252045427:web:ef97f1f42f6110e946b606',
  measurementId:     'G-7KND441SPH',
};

/* ─────────────────────────────────────────────────────────────
   SESSION MANAGER
   Wraps localStorage with expiry + branch selection.
───────────────────────────────────────────────────────────── */
const GRSession = {
  KEY: 'gr_session',

  get() {
    try {
      const raw = localStorage.getItem(this.KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (s.expires < Date.now()) { this.clear(); return null; }
      return s;
    } catch(e) { return null; }
  },

  set(data, rememberMe = false) {
    const session = {
      ...data,
      expires: Date.now() + (rememberMe ? 30 * 24 * 3600_000 : 8 * 3600_000),
      savedAt: Date.now(),
    };
    localStorage.setItem(this.KEY, JSON.stringify(session));
    return session;
  },

  clear() {
    localStorage.removeItem(this.KEY);
    sessionStorage.removeItem('gr_branch');
  },

  getBranch() {
    return sessionStorage.getItem('gr_branch') ?? this.get()?.branches?.[0] ?? 'branch-01';
  },

  setBranch(id) {
    sessionStorage.setItem('gr_branch', id);
  },

  /**
   * Guard: redirect to index.html if not logged in.
   * Call at the top of every protected page.
   */
  guard(redirectTo = 'index.html') {
    const s = this.get();
    if (!s) { window.location.href = redirectTo; return null; }
    return s;
  },
};

/* ─────────────────────────────────────────────────────────────
   FIREBASE BOOT
───────────────────────────────────────────────────────────── */
const GRFirebaseInit = {
  _ready: false,
  _sync:  null,

  /**
   * Initialize Firebase and return the sync instance.
   * Safe to call multiple times — idempotent.
   */
  async boot() {
    if (this._ready) return this._sync;

    // Skip if config hasn't been filled in yet
    if (FIREBASE_CONFIG.apiKey === 'DEMO_MODE') {
      console.warn('[GRFirebase] Firebase config not set — running in offline/demo mode.');
      this._ready = true;
      return null;
    }

    try {
      const { initFirebase } = window.GRFirebase;
      this._sync  = await initFirebase(FIREBASE_CONFIG);
      this._ready = true;
      console.info('[GRFirebase] Initialized ✓');

      // Mirror Firebase auth state to local session
      this._sync._auth.onAuthStateChanged(user => {
        if (!user) return;
        // Refresh lastSeen silently
        this._sync._db.collection('users').doc(user.uid)
          .update({ lastSeen: firebase.firestore.FieldValue.serverTimestamp() })
          .catch(() => {});
      });

      return this._sync;
    } catch(err) {
      console.error('[GRFirebase] Boot failed:', err);
      this._ready = true;
      return null;
    }
  },

  getSync() { return this._sync; },
};

/* ─────────────────────────────────────────────────────────────
   PAGE-LEVEL INTEGRATIONS
───────────────────────────────────────────────────────────── */

/**
 * Integration helpers that connect FirebaseSync to the
 * existing SheetController and VirtualRenderer instances
 * already built in workspace.js.
 */
const GRIntegration = {

  /**
   * Full init for the main app.html page.
   * Call once after DOM ready and after WorkerBridge is set up.
   *
   * @param {object} opts
   * @param {string}          opts.branchId
   * @param {WorkerBridge}    opts.worker
   * @param {VirtualRenderer} opts.renderer
   * @param {function}        opts.onLog
   */
  async initAppPage({ branchId, worker, renderer, onLog }) {
    const sync = await GRFirebaseInit.boot();

    const controllers = {};

    for (const sheetName of ['Purchases', 'Kasa', 'Barcode', 'Phinex']) {
      const ctrl = new window.GRWorkspace.SheetController({
        branchId,
        sheetName,
        worker,
        renderer,
        sync: sync ? this._buildSyncAdapter(sync, branchId, sheetName) : null,
        onLog: (entry) => {
          onLog?.(entry);
          sync?.writeLog(branchId, entry.action, sheetName, entry).catch(() => {});
        },
        onValidErr: ({ row, colId, error }) => {
          renderer.setValidationError(row, colId, error);
        },
      });

      await ctrl.init();
      controllers[sheetName] = ctrl;
    }

    // Real-time listener for the active sheet viewport
    if (sync) {
      this._attachLiveListener(sync, branchId, 'Purchases', renderer, worker);
    }

    return controllers;
  },

  /**
   * Build a sync adapter that matches what SheetController expects.
   * SheetController calls: saveRow, saveColumns, saveBoundaries, loadRows
   */
  _buildSyncAdapter(sync, branchId, sheetName) {
    return {
      saveRow: (b, s, rowIndex, data) =>
        sync.saveRow(b ?? branchId, s ?? sheetName, rowIndex, data),

      saveColumns: (b, s, cols) =>
        sync.saveColumns(b ?? branchId, s ?? sheetName, cols),

      saveBoundaries: (b, boundaries) =>
        sync.saveBoundaries(b ?? branchId, boundaries),

      loadRows: (b, s, startRow, endRow) =>
        sync.loadRows(b ?? branchId, s ?? sheetName, startRow, endRow),
    };
  },

  /**
   * Attach a Firestore real-time listener for the visible viewport.
   * When remote changes arrive, push them to the engine worker + renderer.
   */
  _attachLiveListener(sync, branchId, sheetName, renderer, worker) {
    let listenerRange = { start: 0, end: 100 };

    // Update listener when the renderer scrolls to a new viewport
    renderer.onScroll = ({ firstVisibleRow }) => {
      const start = Math.max(0, firstVisibleRow - 5);
      const end   = firstVisibleRow + 60;

      if (start === listenerRange.start && end === listenerRange.end) return;
      listenerRange = { start, end };

      sync.onRowsChange(
        branchId, sheetName, start, end,
        async ({ rowIndex, data }) => {
          // Push remote change to engine worker
          await worker.send('LOAD_ROWS', {
            branchId,
            sheetName,
            rows: [{ rowIndex, data: data ?? null }],
          });

          // Get updated display values and push to renderer
          const { values } = await worker.send('GET_DISPLAY_VALUES', {
            branchId, sheetName,
            startRow: rowIndex, endRow: rowIndex,
          });
          renderer.loadData(values);
        },
        err => console.warn('[GRIntegration] Live listener error:', err)
      );
    };
  },

  /**
   * Init for log.html — load activity log from Firestore.
   */
  async initLogPage(branchId, filters = {}) {
    const sync = await GRFirebaseInit.boot();
    if (!sync) return { records: [], fromCache: false };

    try {
      const records = await sync.loadLog(branchId, filters);
      return { records, fromCache: false };
    } catch(err) {
      console.warn('[GRIntegration] Log load failed:', err);
      return { records: [], fromCache: true, error: err.message };
    }
  },

  /**
   * Init for settings.html — load users + branch config.
   */
  async initSettingsPage(branchId) {
    const sync = await GRFirebaseInit.boot();
    if (!sync) return { users: [], config: {} };

    const [users, config] = await Promise.all([
      sync.listUsers().catch(() => []),
      sync.loadBranchConfig(branchId).catch(() => ({})),
    ]);

    return { users, config };
  },
};

/* ─────────────────────────────────────────────────────────────
   AUTO-BOOT on DOMContentLoaded
───────────────────────────────────────────────────────────── */
if (typeof window !== 'undefined') {
  window.GRSession     = GRSession;
  window.GRFirebaseInit = GRFirebaseInit;
  window.GRIntegration = GRIntegration;

  // Boot Firebase as early as possible (non-blocking)
  document.addEventListener('DOMContentLoaded', () => {
    GRFirebaseInit.boot().then(sync => {
      window.dispatchEvent(new CustomEvent('gr:firebase-ready', { detail: { sync } }));
    });
  });
}
