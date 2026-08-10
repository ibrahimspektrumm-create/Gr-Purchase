/**
 * GR Purchase — Formula Web Worker
 * ════════════════════════════════════════════════════════════
 * Runs FormulaEngine off the main thread.
 * Communication via structured messages.
 *
 * Message protocol:
 *   IN  → { id, type, payload }
 *   OUT → { id, type, result?, error? }
 * ════════════════════════════════════════════════════════════
 */

'use strict';

importScripts(new URL('engine.js', self.location.href).href);

const { Workbook, ClipboardParser } = self.GREngine;

/** Active workbooks keyed by branchId */
const workbooks = new Map();

/* ── Message router ── */
self.onmessage = function({ data }) {
  const { id, type, payload } = data;

  try {
    const result = dispatch(type, payload);
    // Result may be a Promise (async ops)
    if (result && typeof result.then === 'function') {
      result
        .then(res => self.postMessage({ id, type, result: res }))
        .catch(err => self.postMessage({ id, type, error: String(err) }));
    } else {
      self.postMessage({ id, type, result });
    }
  } catch (err) {
    self.postMessage({ id, type, error: String(err) });
  }
};

function dispatch(type, payload) {
  switch (type) {

    /* ── Workbook lifecycle ── */
    case 'INIT_WORKBOOK': {
      const wb = new Workbook(payload.branchId);
      workbooks.set(payload.branchId, wb);
      return { ok: true };
    }

    case 'DESTROY_WORKBOOK': {
      workbooks.delete(payload.branchId);
      return { ok: true };
    }

    /* ── Column management ── */
    case 'ADD_COLUMN': {
      const sheet = getSheet(payload.branchId, payload.sheetName);
      const col   = sheet.addColumn(payload.def);
      return { col };
    }

    case 'REMOVE_COLUMN': {
      const sheet    = getSheet(payload.branchId, payload.sheetName);
      const result   = sheet.removeColumn(payload.colId);
      return result;
    }

    case 'UPDATE_COLUMN': {
      const sheet = getSheet(payload.branchId, payload.sheetName);
      const col   = sheet.updateColumn(payload.colId, payload.patch);
      return { col };
    }

    case 'GET_COLUMNS': {
      const sheet = getSheet(payload.branchId, payload.sheetName);
      return { columns: sheet.columns };
    }

    /* ── Cell operations ── */
    case 'SET_CELL': {
      const sheet = getSheet(payload.branchId, payload.sheetName);
      sheet.setCell(payload.row, payload.colId, payload.value, payload.isManual ?? false);
      const updated = getWorkbook(payload.branchId).recalc();
      return { updated: serializeUpdated(updated) };
    }

    case 'SET_CELL_LINK': {
      const sheet = getSheet(payload.branchId, payload.sheetName);
      sheet.setCellLink(payload.row, payload.colId, payload.url);
      return { ok: true };
    }

    case 'CLEAR_CELL': {
      const sheet = getSheet(payload.branchId, payload.sheetName);
      sheet.clearCell(payload.row, payload.colId);
      const updated = getWorkbook(payload.branchId).recalc();
      return { updated: serializeUpdated(updated) };
    }

    case 'GET_DISPLAY_VALUES': {
      /* Get a viewport of display values for rendering
         payload: { branchId, sheetName, startRow, endRow } */
      const sheet  = getSheet(payload.branchId, payload.sheetName);
      const result = {};
      for (let r = payload.startRow; r <= Math.min(payload.endRow, sheet.maxRow); r++) {
        result[r] = {};
        for (const col of sheet.columns) {
          const v = sheet.displayValue(r, col.id);
          if (v !== null) result[r][col.id] = v;
          // Include link info
          const cell = sheet.getCell(r, col.id);
          if (cell?.lnk) result[r][`${col.id}__lnk`] = cell.lnk;
          if (cell?.m !== null && cell?.m !== undefined) result[r][`${col.id}__manual`] = true;
        }
      }
      return { values: result, maxRow: sheet.maxRow };
    }

    /* ── Paste from Excel ── */
    case 'PASTE_GRID': {
      const sheet  = getSheet(payload.branchId, payload.sheetName);
      const grid   = ClipboardParser.parse(payload.clipboardText);
      const result = sheet.pasteGrid(payload.startRow, payload.startColIndex, grid);
      const updated = getWorkbook(payload.branchId).recalc();
      return { ...result, updated: serializeUpdated(updated) };
    }

    case 'COPY_RANGE': {
      /* Returns TSV string ready for clipboard */
      const sheet = getSheet(payload.branchId, payload.sheetName);
      const grid  = [];
      for (let r = payload.startRow; r <= payload.endRow; r++) {
        const row = [];
        for (let c = payload.startCol; c <= payload.endCol; c++) {
          const col = sheet.getColumnByIndex(c);
          row.push(col ? (sheet.displayValue(r, col.id) ?? '') : '');
        }
        grid.push(row);
      }
      return { tsv: ClipboardParser.serialize(grid) };
    }

    /* ── Invoice boundaries ── */
    case 'CLOSE_INVOICE': {
      const sheet = getSheet(payload.branchId, 'Purchases');
      sheet.closeInvoice(payload.lastRow);
      const updated = getWorkbook(payload.branchId).fullRecalc();
      return { updated: serializeUpdated(updated), boundaries: [...sheet.invoiceBoundaries] };
    }

    case 'OPEN_INVOICE': {
      const sheet = getSheet(payload.branchId, 'Purchases');
      sheet.openInvoice(payload.lastRow);
      const updated = getWorkbook(payload.branchId).fullRecalc();
      return { updated: serializeUpdated(updated), boundaries: [...sheet.invoiceBoundaries] };
    }

    case 'GET_INVOICE_RANGE': {
      const sheet = getSheet(payload.branchId, 'Purchases');
      const range = sheet.getInvoiceRange(payload.row);
      return { range };
    }

    /* ── Validation ── */
    case 'GET_DROPDOWN_OPTIONS': {
      const wb = getWorkbook(payload.branchId);
      // ValidationRegistry is managed in main thread, but we mirror source data here
      const srcSheet = wb.getSheet(payload.sourceSheetName);
      if (!srcSheet) return { options: [] };
      let options = srcSheet.getUniqueValues(payload.sourceColId);
      if (payload.query) {
        const q = payload.query.toLowerCase();
        options = options.filter(v => String(v).toLowerCase().includes(q));
      }
      return { options: options.sort() };
    }

    /* ── Find & Replace ── */
    case 'FIND': {
      const { FindReplace } = self.GREngine;
      const sheet = getSheet(payload.branchId, payload.sheetName);
      const fr    = new FindReplace(sheet);
      const count = fr.find(payload.query, payload.opts);
      const results = fr.results().map(r => ({ row: r.row, colId: r.colId }));
      return { count, results };
    }

    case 'REPLACE_ALL': {
      const { FindReplace } = self.GREngine;
      const sheet = getSheet(payload.branchId, payload.sheetName);
      const fr    = new FindReplace(sheet);
      const count = fr.replaceAll(payload.query, payload.replacement, payload.opts);
      const updated = getWorkbook(payload.branchId).recalc();
      return { count, updated: serializeUpdated(updated) };
    }

    /* ── Data loading from Firestore ── */
    case 'LOAD_ROWS': {
      /* payload.rows: [{ rowIndex, data }] */
      const sheet = getSheet(payload.branchId, payload.sheetName);
      for (const { rowIndex, data } of payload.rows) {
        sheet.loadRow(rowIndex, data);
      }
      return { loaded: payload.rows.length, maxRow: sheet.maxRow };
    }

    case 'LOAD_COLUMNS': {
      const sheet = getSheet(payload.branchId, payload.sheetName);
      // Replace columns wholesale (from Firestore snapshot)
      sheet.columns = payload.columns;
      return { ok: true };
    }

    case 'LOAD_INVOICE_BOUNDARIES': {
      const sheet = getSheet(payload.branchId, 'Purchases');
      sheet.invoiceBoundaries = new Set(payload.boundaries);
      return { ok: true };
    }

    /* ── Serialization ── */
    case 'SERIALIZE_ROW': {
      const sheet = getSheet(payload.branchId, payload.sheetName);
      const data  = sheet.serializeRow(payload.rowIndex);
      return { data };
    }

    /**
     * SERIALIZE_ROWS — batched version of SERIALIZE_ROW. Used after a
     * recalc affecting many rows (e.g. fullRecalc after paste/import)
     * to avoid one round-trip per row when merging worker-computed
     * results back into the main thread's display cache.
     * payload: { branchId, sheetName, rowIndices: number[] }
     * returns: { rows: { [rowIndex]: serializedRowData|null } }
     */
    case 'SERIALIZE_ROWS': {
      const sheet = getSheet(payload.branchId, payload.sheetName);
      const rows  = {};
      for (const rowIndex of payload.rowIndices) {
        rows[rowIndex] = sheet.serializeRow(rowIndex);
      }
      return { rows };
    }

    case 'FULL_RECALC': {
      const wb      = getWorkbook(payload.branchId);
      const updated = wb.fullRecalc();
      return { updated: serializeUpdated(updated) };
    }

    /**
     * STATELESS_RECALC — recompute formula columns for a snapshot of cell
     * data without requiring any prior INIT_WORKBOOK call or persistent
     * worker-side state. This is the low-risk integration point: the
     * caller sends exactly what changed, the worker does the (potentially
     * expensive) topological-sort + formula evaluation work off the main
     * thread, and returns only the computed results to merge back in.
     *
     * payload: {
     *   columns: ColumnDef[],          // current sheet's column definitions
     *   dirtyRows: {                   // rows that changed, raw cell data
     *     [rowIndex]: { [colId]: { v, m, lnk } }
     *   },
     *   invoiceBoundaries: number[],   // for Purchases sheet discount formulas
     * }
     * returns: {
     *   results: {                     // computed display values for affected rows
     *     [rowIndex]: { [colId]: value }
     *   }
     * }
     */
    case 'STATELESS_RECALC': {
      const { Workbook } = self.GREngine;
      const tempWb    = new Workbook('__stateless__');
      const tempSheet = tempWb.getSheet('Purchases'); // any sheet works, we only use its column/cell machinery

      tempSheet.columns = payload.columns;
      if (payload.invoiceBoundaries) {
        tempSheet.invoiceBoundaries = new Set(payload.invoiceBoundaries);
      }

      for (const [rowStr, rowData] of Object.entries(payload.dirtyRows || {})) {
        const row = parseInt(rowStr);
        tempSheet.loadRow(row, rowData);
        tempSheet._dirtyRows.add(row); // ensure it's picked up even if loadRow's diffing misses it
      }

      const updatedMap = tempWb.recalc();
      const affectedRows = updatedMap.get('Purchases') ?? new Set();

      const results = {};
      for (const row of affectedRows) {
        results[row] = {};
        for (const col of tempSheet.columns) {
          const val = tempSheet.displayValue(row, col.id);
          if (val !== null) results[row][col.id] = val;
        }
      }

      return { results, affectedRows: [...affectedRows] };
    }

    default:
      throw new Error(`Unknown worker message type: ${type}`);
  }
}

/* ── Helpers ── */

function getWorkbook(branchId) {
  const wb = workbooks.get(branchId);
  if (!wb) throw new Error(`Workbook not initialized for branch: ${branchId}`);
  return wb;
}

function getSheet(branchId, sheetName) {
  const wb    = getWorkbook(branchId);
  const sheet = wb.getSheet(sheetName);
  if (!sheet) throw new Error(`Sheet not found: ${sheetName}`);
  return sheet;
}

function serializeUpdated(updatedMap) {
  const out = {};
  for (const [sheetName, rows] of updatedMap) {
    out[sheetName] = [...rows];
  }
  return out;
}
