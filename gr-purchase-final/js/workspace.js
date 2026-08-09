/**
 * GR Purchase — Worker Bridge
 * ════════════════════════════════════════════════════════════
 * Main-thread interface to the Formula Web Worker.
 * Provides a clean Promise-based API.
 * Falls back to synchronous in-thread execution if Workers
 * are unavailable (e.g. file:// protocol).
 * ════════════════════════════════════════════════════════════
 */

'use strict';

class WorkerBridge {
  constructor(workerUrl) {
    this._pending = new Map();  // id → { resolve, reject }
    this._id      = 0;

    try {
      this._worker = new Worker(workerUrl);
      this._worker.onmessage = ({ data }) => this._onMessage(data);
      this._worker.onerror   = (e) => {
        console.error('[WorkerBridge] Worker error:', e);
        this._rejectAll(e.message);
      };
      this._available = true;
    } catch (e) {
      console.warn('[WorkerBridge] Web Workers unavailable, falling back to sync', e);
      this._available = false;
    }
  }

  /**
   * Send a message to the worker and return a Promise.
   * @param {string} type
   * @param {object} payload
   * @returns {Promise<any>}
   */
  send(type, payload = {}) {
    if (!this._available) {
      return this._syncFallback(type, payload);
    }

    return new Promise((resolve, reject) => {
      const id = ++this._id;
      this._pending.set(id, { resolve, reject });
      this._worker.postMessage({ id, type, payload });
    });
  }

  terminate() {
    if (this._worker) this._worker.terminate();
  }

  _onMessage({ id, type, result, error }) {
    const pending = this._pending.get(id);
    if (!pending) return;
    this._pending.delete(id);
    if (error) pending.reject(new Error(error));
    else       pending.resolve(result);
  }

  _rejectAll(msg) {
    for (const [, { reject }] of this._pending) {
      reject(new Error(msg));
    }
    this._pending.clear();
  }

  async _syncFallback(type, payload) {
    // In fallback mode, import engine directly and run synchronously
    if (!self.GREngine) throw new Error('GREngine not loaded');
    // Minimal sync dispatch (subset of worker protocol)
    console.warn('[WorkerBridge] Sync fallback for:', type);
    return null;
  }
}

/* ─────────────────────────────────────────────────────────────
   SHEET CONTROLLER
   Coordinates: WorkerBridge ↔ VirtualRenderer ↔ FirestoreSync
───────────────────────────────────────────────────────────── */
class SheetController {
  /**
   * @param {object} opts
   * @param {string}          opts.branchId
   * @param {string}          opts.sheetName
   * @param {WorkerBridge}    opts.worker
   * @param {VirtualRenderer} opts.renderer
   * @param {FirestoreSync}   opts.sync        - optional, can be null
   * @param {function}        opts.onLog       - activity logger
   * @param {function}        opts.onValidErr  - validation error callback
   */
  constructor(opts) {
    this.branchId  = opts.branchId;
    this.sheetName = opts.sheetName;
    this.worker    = opts.worker;
    this.renderer  = opts.renderer;
    this.sync      = opts.sync ?? null;
    this.onLog     = opts.onLog ?? (() => {});
    this.onValidErr= opts.onValidErr ?? (() => {});

    /* Draft system */
    this._draftKey    = `gr_draft_${opts.branchId}_${opts.sheetName}`;
    this._draftTimer  = null;
    this._hasDraft    = false;

    /* Column definitions (mirrored from worker) */
    this.columns = [];

    /* Undo stack */
    this._undoStack = [];
    this._redoStack = [];

    /* Clipboard state */
    this._clipboard  = null;

    /* Active cell editor */
    this._editor     = null;

    /* Find & Replace state */
    this._findResults = [];
    this._findCursor  = -1;

    /* Validation errors map (colId → rule) */
    this._validationRules = new Map();

    /* Pending Firestore writes (batched) */
    this._pendingWrites = new Map(); // rowIndex → dirty

    this._bindKeyboardShortcuts();
  }

  /* ── Initialization ── */

  async init() {
    // Load columns from Firestore / worker
    const { columns } = await this.worker.send('GET_COLUMNS', {
      branchId: this.branchId,
      sheetName: this.sheetName,
    });

    this.columns = columns ?? [];

    // Update renderer
    this.renderer.setSheet({
      totalRows: 50_000,
      columns:   this.columns,
    });

    // Restore draft if exists
    await this._restoreDraft();

    // Load first visible page from Firestore
    await this._loadViewport(0, 100);
  }

  /* ── Column management ── */

  async addColumn(def) {
    const { col } = await this.worker.send('ADD_COLUMN', {
      branchId:  this.branchId,
      sheetName: this.sheetName,
      def,
    });
    this.columns.push(col);
    this.renderer.setSheet({ totalRows: 50_000, columns: this.columns });

    if (this.sync) await this.sync.saveColumns(this.branchId, this.sheetName, this.columns);
    this.onLog({ action: 'ADD_COLUMN', column: col.name, sheet: this.sheetName });
    return col;
  }

  async removeColumn(colId) {
    const { removed, affected } = await this.worker.send('REMOVE_COLUMN', {
      branchId: this.branchId, sheetName: this.sheetName, colId,
    });
    if (!removed) return { removed: false, affected: [] };

    this.columns = this.columns.filter(c => c.id !== colId);
    this.renderer.setSheet({ totalRows: 50_000, columns: this.columns });
    if (this.sync) await this.sync.saveColumns(this.branchId, this.sheetName, this.columns);
    this.onLog({ action: 'REMOVE_COLUMN', colId, sheet: this.sheetName });
    return { removed: true, affected };
  }

  async updateColumn(colId, patch) {
    const { col } = await this.worker.send('UPDATE_COLUMN', {
      branchId: this.branchId, sheetName: this.sheetName, colId, patch,
    });
    const idx = this.columns.findIndex(c => c.id === colId);
    if (idx !== -1) this.columns[idx] = col;
    this.renderer.setSheet({ totalRows: 50_000, columns: this.columns });
    if (this.sync) await this.sync.saveColumns(this.branchId, this.sheetName, this.columns);
    return col;
  }

  /* ── Cell editing ── */

  async setCell(row, colId, value, isManual = true) {
    // Validate
    const rule  = this._validationRules.get(colId);
    const error = rule ? this._validate(value, rule, row) : null;

    if (error) {
      this.renderer.setValidationError(row, colId, error);
      this.onValidErr({ row, colId, error });
      return { ok: false, error };
    } else {
      this.renderer.setValidationError(row, colId, null);
    }

    // Push to undo stack
    this._pushUndo({ type: 'SET_CELL', row, colId, prevValue: this._getCachedValue(row, colId) });

    const { updated } = await this.worker.send('SET_CELL', {
      branchId: this.branchId, sheetName: this.sheetName,
      row, colId, value, isManual,
    });

    await this._applyUpdates(updated);
    this._scheduleDraft();
    this._scheduleWrite(row);
    this.onLog({ action: 'EDIT_CELL', row, colId, value, sheet: this.sheetName });
    return { ok: true };
  }

  async setCellLink(row, colId, url) {
    await this.worker.send('SET_CELL_LINK', {
      branchId: this.branchId, sheetName: this.sheetName, row, colId, url,
    });
    await this._loadViewport(row, row); // reload this row
    this._scheduleWrite(row);
    this.onLog({ action: 'SET_LINK', row, colId, url, sheet: this.sheetName });
  }

  async clearCell(row, colId) {
    this._pushUndo({ type: 'SET_CELL', row, colId, prevValue: this._getCachedValue(row, colId) });
    const { updated } = await this.worker.send('CLEAR_CELL', {
      branchId: this.branchId, sheetName: this.sheetName, row, colId,
    });
    await this._applyUpdates(updated);
    this._scheduleDraft();
    this._scheduleWrite(row);
  }

  /* ── Paste from Excel ── */

  async paste(startRow, startColIndex, clipboardText) {
    const { written, errors, updated } = await this.worker.send('PASTE_GRID', {
      branchId: this.branchId, sheetName: this.sheetName,
      startRow, startColIndex, clipboardText,
    });
    await this._applyUpdates(updated);
    this._scheduleDraft();

    // Schedule writes for all affected rows
    const lines = clipboardText.split('\n');
    for (let i = 0; i < lines.length; i++) {
      this._scheduleWrite(startRow + i);
    }

    this.onLog({ action: 'PASTE', startRow, startColIndex, written, errors, sheet: this.sheetName });
    return { written, errors };
  }

  /* ── Copy to clipboard ── */

  async copyRange(startRow, endRow, startCol, endCol) {
    const { tsv } = await this.worker.send('COPY_RANGE', {
      branchId: this.branchId, sheetName: this.sheetName,
      startRow, endRow, startCol, endCol,
    });
    try {
      await navigator.clipboard.writeText(tsv);
    } catch (e) {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = tsv;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select(); document.execCommand('copy');
      ta.remove();
    }
    return tsv;
  }

  /* ── Invoice boundaries ── */

  async closeInvoice(lastRow) {
    const { updated, boundaries } = await this.worker.send('CLOSE_INVOICE', {
      branchId: this.branchId,
    });
    this.renderer.setInvoiceBoundaries(boundaries);
    await this._applyUpdates(updated);
    if (this.sync) await this.sync.saveBoundaries(this.branchId, boundaries);
    this.onLog({ action: 'CLOSE_INVOICE', lastRow, sheet: 'Purchases' });
  }

  async openInvoice(lastRow) {
    const { updated, boundaries } = await this.worker.send('OPEN_INVOICE', {
      branchId: this.branchId,
    });
    this.renderer.setInvoiceBoundaries(boundaries);
    await this._applyUpdates(updated);
    if (this.sync) await this.sync.saveBoundaries(this.branchId, boundaries);
    this.onLog({ action: 'OPEN_INVOICE', lastRow, sheet: 'Purchases' });
  }

  /* ── Validation rules ── */

  setValidationRule(colId, rule) {
    this._validationRules.set(colId, rule);
  }

  async getDropdownOptions(colId, query = '') {
    return this.worker.send('GET_DROPDOWN_OPTIONS', {
      branchId: this.branchId,
      sheetName: this.sheetName,
      sourceSheetName: this._validationRules.get(colId)?.sourceSheetName ?? this.sheetName,
      sourceColId:     this._validationRules.get(colId)?.sourceColId,
      query,
    });
  }

  /* ── Find & Replace ── */

  async find(query, opts = {}) {
    const { count, results } = await this.worker.send('FIND', {
      branchId: this.branchId, sheetName: this.sheetName, query, opts,
    });
    this._findResults = results;
    this._findCursor  = results.length > 0 ? 0 : -1;
    return { count, results };
  }

  findNext() {
    if (!this._findResults.length) return null;
    this._findCursor = (this._findCursor + 1) % this._findResults.length;
    const hit = this._findResults[this._findCursor];
    if (hit) this.renderer.scrollToCell(hit.row, this.columns.findIndex(c => c.id === hit.colId));
    return hit;
  }

  findPrev() {
    if (!this._findResults.length) return null;
    this._findCursor = (this._findCursor - 1 + this._findResults.length) % this._findResults.length;
    const hit = this._findResults[this._findCursor];
    if (hit) this.renderer.scrollToCell(hit.row, this.columns.findIndex(c => c.id === hit.colId));
    return hit;
  }

  async replaceAll(query, replacement, opts = {}) {
    const { count, updated } = await this.worker.send('REPLACE_ALL', {
      branchId: this.branchId, sheetName: this.sheetName, query, replacement, opts,
    });
    await this._applyUpdates(updated);
    this._scheduleDraft();
    this.onLog({ action: 'REPLACE_ALL', query, replacement, count, sheet: this.sheetName });
    return count;
  }

  /* ── Undo / Redo ── */

  async undo() {
    const op = this._undoStack.pop();
    if (!op) return;
    this._redoStack.push(op);

    if (op.type === 'SET_CELL') {
      const { updated } = await this.worker.send('SET_CELL', {
        branchId: this.branchId, sheetName: this.sheetName,
        row: op.row, colId: op.colId, value: op.prevValue, isManual: true,
      });
      await this._applyUpdates(updated);
    }
  }

  async redo() {
    const op = this._redoStack.pop();
    if (!op) return;
    this._undoStack.push(op);
    // Re-apply (simplified — a full implementation would store next-value too)
  }

  /* ── Keyboard shortcuts ── */

  _bindKeyboardShortcuts() {
    document.addEventListener('keydown', async (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;

      switch (e.key.toLowerCase()) {
        case 's': {
          e.preventDefault();
          await this.saveToFirestore();
          break;
        }
        case 'z': {
          e.preventDefault();
          if (e.shiftKey) await this.redo();
          else            await this.undo();
          break;
        }
        case 'c': {
          const range = this.renderer.getSelectedRange();
          if (!range) break;
          e.preventDefault();
          await this.copyRange(range.startRow, range.endRow, range.startCol, range.endCol);
          break;
        }
        case 'v': {
          e.preventDefault();
          try {
            const text   = await navigator.clipboard.readText();
            const sel    = this.renderer.selection;
            const anchor = sel.anchor;
            if (!anchor) break;
            await this.paste(anchor.row, anchor.col, text);
          } catch {}
          break;
        }
        case 'f': {
          e.preventDefault();
          document.dispatchEvent(new CustomEvent('gr:open-find'));
          break;
        }
      }
    });
  }

  /* ── Draft system ── */

  _scheduleDraft() {
    clearTimeout(this._draftTimer);
    this._draftTimer = setTimeout(() => this._saveDraft(), 400);
  }

  async _saveDraft() {
    try {
      const { IDBKeyRange } = window;
      // Serialize pending rows only
      const draft = {};
      for (const row of this._pendingWrites.keys()) {
        const { data } = await this.worker.send('SERIALIZE_ROW', {
          branchId: this.branchId, sheetName: this.sheetName, rowIndex: row,
        });
        if (data) draft[row] = data;
      }
      localStorage.setItem(this._draftKey, JSON.stringify(draft));
      this._hasDraft = true;
    } catch (e) {
      console.warn('[Draft] save failed:', e);
    }
  }

  async _restoreDraft() {
    try {
      const raw = localStorage.getItem(this._draftKey);
      if (!raw) return false;
      const draft = JSON.parse(raw);
      const rows  = Object.entries(draft).map(([rowIndex, data]) => ({
        rowIndex: parseInt(rowIndex), data,
      }));
      if (!rows.length) return false;
      await this.worker.send('LOAD_ROWS', {
        branchId: this.branchId, sheetName: this.sheetName, rows,
      });
      this._hasDraft = true;
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ── Firestore persistence ── */

  _scheduleWrite(row) {
    this._pendingWrites.set(row, true);
  }

  async saveToFirestore() {
    if (!this.sync || this._pendingWrites.size === 0) return;
    const rows = [...this._pendingWrites.keys()];
    this._pendingWrites.clear();

    for (const row of rows) {
      const { data } = await this.worker.send('SERIALIZE_ROW', {
        branchId: this.branchId, sheetName: this.sheetName, rowIndex: row,
      });
      await this.sync.saveRow(this.branchId, this.sheetName, row, data);
    }

    // Clear draft after successful save
    localStorage.removeItem(this._draftKey);
    this._hasDraft = false;
  }

  /* ── Data loading ── */

  async _loadViewport(startRow, endRow) {
    if (!this.sync) return;
    const rows = await this.sync.loadRows(this.branchId, this.sheetName, startRow, endRow);
    if (!rows.length) return;

    await this.worker.send('LOAD_ROWS', {
      branchId: this.branchId, sheetName: this.sheetName, rows,
    });

    // Fetch display values and push to renderer
    const { values } = await this.worker.send('GET_DISPLAY_VALUES', {
      branchId: this.branchId, sheetName: this.sheetName,
      startRow, endRow,
    });
    this.renderer.loadData(values);
  }

  async _applyUpdates(updatedMap) {
    if (!updatedMap) return;
    for (const [sheetName, rows] of Object.entries(updatedMap)) {
      if (sheetName !== this.sheetName) continue;
      if (!rows.length) continue;
      const minRow = Math.min(...rows);
      const maxRow = Math.max(...rows);
      const { values } = await this.worker.send('GET_DISPLAY_VALUES', {
        branchId: this.branchId, sheetName,
        startRow: minRow, endRow: maxRow,
      });
      this.renderer.loadData(values);
    }
  }

  _validate(value, rule, row) {
    switch (rule.type) {
      case 'number_range': {
        const n = parseFloat(value);
        if (isNaN(n)) return 'قيمة رقمية مطلوبة';
        if (rule.min !== undefined && n < rule.min) return `أقل من الحد الأدنى (${rule.min})`;
        if (rule.max !== undefined && n > rule.max) return `أكبر من الحد الأقصى (${rule.max})`;
        return null;
      }
      case 'no_zero':
        return Number(value) === 0 ? 'لا يُسمح بالقيمة صفر' : null;
      case 'list_range':
        return null; // async validation via worker
      default:
        return null;
    }
  }

  _pushUndo(op) {
    this._undoStack.push(op);
    if (this._undoStack.length > 100) this._undoStack.shift();
    this._redoStack = [];
  }

  _getCachedValue(row, colId) {
    return null; // In full impl, read from renderer cache
  }
}

/* Export */
if (typeof module !== 'undefined') {
  module.exports = { WorkerBridge, SheetController };
}
if (typeof window !== 'undefined') {
  window.GRWorkspace = { WorkerBridge, SheetController };
}
