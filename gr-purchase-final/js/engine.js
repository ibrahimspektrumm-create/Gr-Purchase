/**
 * GR Purchase — Spreadsheet Engine
 * ═══════════════════════════════════════════════════════════════
 * Pure computation engine. Zero DOM. Zero Firebase. Zero UI.
 * Can run in a Web Worker or in the main thread.
 *
 * Responsibilities:
 *  - Cell data model (value / formula / format / link / manual-override)
 *  - Formula parser & evaluator (cross-sheet references)
 *  - Dependency graph (topological sort, cycle detection)
 *  - Data validation registry
 *  - Column definitions registry
 *  - Invoice boundary tracking (Purchases sheet)
 *  - Dirty-flag system → triggers targeted re-render
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

/* ─────────────────────────────────────────────────────────────
   CONSTANTS
───────────────────────────────────────────────────────────── */
const MAX_ROWS    = 50_000;
const MAX_COLS    = 200;
const SHEET_NAMES = ['Purchases', 'Kasa', 'Barcode', 'Phinex'];

const COL_TYPES = Object.freeze({
  TEXT:       'text',
  NUMBER:     'number',
  DATE:       'date',
  CURRENCY:   'currency',
  PERCENTAGE: 'percentage',
});

const FORMULA_TYPES = Object.freeze({
  NONE:         'none',          // plain input column
  LOOKUP:       'lookup',        // ب — lookup value from another column
  ARITHMETIC:   'arithmetic',    // ج — math expression over same-row columns
  CONDITIONAL:  'conditional',   // د — IF/IFS logic
  DISCOUNT:     'discount',      // هـ — invoice-level discount distribution
});

const VALIDATION_TYPES = Object.freeze({
  NONE:        'none',
  LIST_RANGE:  'list_range',     // values from another column
  NUMBER_RANGE:'number_range',   // min / max
  NO_ZERO:     'no_zero',
  CUSTOM:      'custom',         // regex / custom fn
});

/* ─────────────────────────────────────────────────────────────
   CELL MODEL
───────────────────────────────────────────────────────────── */
/**
 * Minimal cell storage — what we keep per cell in memory.
 * Only non-default fields are persisted to Firestore.
 *
 * @typedef {Object} Cell
 * @property {string|number|null} v   - stored/computed value
 * @property {string|number|null} m   - manual override (null = no override)
 * @property {string|null}        lnk - hyperlink URL or null
 * @property {boolean}            d   - dirty (needs re-render)
 */

function makeCell(value = null) {
  return { v: value, m: null, lnk: null, d: false };
}

/* ─────────────────────────────────────────────────────────────
   COLUMN DEFINITION
───────────────────────────────────────────────────────────── */
/**
 * @typedef {Object} ColumnDef
 * @property {string}  id           - unique id (uuid)
 * @property {string}  name         - display name
 * @property {string}  type         - COL_TYPES.*
 * @property {number}  width        - px width
 * @property {object}  format       - formatting options
 * @property {string}  formulaType  - FORMULA_TYPES.*
 * @property {object}  formulaDef   - formula configuration
 * @property {object}  validation   - VALIDATION_TYPES config
 * @property {boolean} frozen       - frozen column flag
 * @property {number}  index        - 0-based column order
 */

function makeColumnDef(overrides = {}) {
  return {
    id:          crypto.randomUUID(),
    name:        '',
    type:        COL_TYPES.TEXT,
    width:       120,
    format:      {},
    formulaType: FORMULA_TYPES.NONE,
    formulaDef:  {},
    validation:  { type: VALIDATION_TYPES.NONE },
    frozen:      false,
    index:       0,
    ...overrides,
  };
}

/* ─────────────────────────────────────────────────────────────
   SHEET MODEL
───────────────────────────────────────────────────────────── */
class Sheet {
  /**
   * @param {string} name   - one of SHEET_NAMES
   * @param {string} branchId
   */
  constructor(name, branchId) {
    this.name     = name;
    this.branchId = branchId;

    /** @type {ColumnDef[]} ordered list of columns */
    this.columns  = [];

    /**
     * Sparse cell store: Map<rowIndex, Map<colId, Cell>>
     * We use colId (not index) so reordering columns never corrupts data.
     */
    this.cells    = new Map();

    /**
     * Invoice boundaries (Purchases sheet only).
     * Set of row indices that are the LAST row of an invoice.
     * e.g. {4, 9, 14} means rows 0-4 = invoice1, 5-9 = invoice2, …
     * @type {Set<number>}
     */
    this.invoiceBoundaries = new Set();

    /** Highest row index that has any data */
    this.maxRow   = -1;

    /** Dirty rows — need re-render */
    this._dirtyRows = new Set();

    /**
     * Lookup index per column: Map<colId, Map<value, Set<rowIndex>>>
     * Built lazily, invalidated on write.
     */
    this._lookupIndex = new Map();
  }

  /* ── Column helpers ── */

  addColumn(def) {
    const col = makeColumnDef({ ...def, index: this.columns.length });
    this.columns.push(col);
    return col;
  }

  /**
   * Non-destructive check: returns the IDs of columns whose formulas
   * reference the given column, WITHOUT removing anything. Callers
   * should use this to warn the user before calling removeColumn(),
   * since removeColumn() itself always performs the removal regardless
   * of dependents (it only reports them after the fact).
   */
  getColumnDependents(colId) {
    return this.columns
      .filter(c => c.id !== colId && this._formulaReferences(c.formulaDef, colId))
      .map(c => c.id);
  }

  removeColumn(colId) {
    const idx = this.columns.findIndex(c => c.id === colId);
    if (idx === -1) return { removed: false, affected: [] };

    // Find columns whose formulaDef references this colId
    const affected = this.columns
      .filter(c => this._formulaReferences(c.formulaDef, colId))
      .map(c => c.id);

    this.columns.splice(idx, 1);
    // Re-index
    this.columns.forEach((c, i) => c.index = i);
    this._invalidateLookupIndex(colId);
    return { removed: true, affected };
  }

  updateColumn(colId, patch) {
    const col = this.columns.find(c => c.id === colId);
    if (!col) return null;
    Object.assign(col, patch);
    if ('formulaDef' in patch || 'formulaType' in patch) {
      this._markAllDirty();
    }
    return col;
  }

  getColumnByIndex(index) {
    return this.columns[index] ?? null;
  }

  getColumnById(colId) {
    return this.columns.find(c => c.id === colId) ?? null;
  }

  /* ── Cell read / write ── */

  getCell(row, colId) {
    return this.cells.get(row)?.get(colId) ?? null;
  }

  /**
   * Write a value to a cell.
   * If the column has a formula, this becomes a manual override.
   */
  setCell(row, colId, value, isManual = false) {
    if (row < 0 || row >= MAX_ROWS) throw new RangeError(`Row ${row} out of range`);

    if (!this.cells.has(row)) this.cells.set(row, new Map());
    const rowMap = this.cells.get(row);

    const existing = rowMap.get(colId) ?? makeCell();
    const col = this.getColumnById(colId);
    const hasFormula = col && col.formulaType !== FORMULA_TYPES.NONE;

    if (isManual && hasFormula) {
      existing.m = value;   // manual override sits on top of formula
    } else {
      existing.v = value;
      existing.m = null;    // clear any prior override when formula recalcs
    }

    existing.d = true;
    rowMap.set(colId, existing);
    this._dirtyRows.add(row);

    if (row > this.maxRow) this.maxRow = row;
    this._invalidateLookupIndex(colId);
  }

  setCellLink(row, colId, url) {
    if (!this.cells.has(row)) this.cells.set(row, new Map());
    const rowMap = this.cells.get(row);
    const existing = rowMap.get(colId) ?? makeCell();
    existing.lnk = url || null;
    existing.d   = true;
    rowMap.set(colId, existing);
    this._dirtyRows.add(row);
  }

  /**
   * Display value of a cell — manual override takes priority.
   */
  displayValue(row, colId) {
    const cell = this.getCell(row, colId);
    if (!cell) return null;
    return cell.m !== null ? cell.m : cell.v;
  }

  clearCell(row, colId) {
    const rowMap = this.cells.get(row);
    if (!rowMap) return;
    rowMap.delete(colId);
    this._dirtyRows.add(row);
    this._invalidateLookupIndex(colId);
  }

  /* ── Bulk paste (from Excel clipboard) ── */

  /**
   * Paste a 2D array of values starting at (startRow, startColIndex).
   * Preserves empty cells in the source grid.
   * @param {number}   startRow
   * @param {number}   startColIndex
   * @param {Array[]}  grid  - 2D array [row][col]
   * @returns {{ written: number, errors: string[] }}
   */
  pasteGrid(startRow, startColIndex, grid) {
    let written = 0;
    const errors = [];

    for (let r = 0; r < grid.length; r++) {
      const targetRow = startRow + r;
      if (targetRow >= MAX_ROWS) { errors.push(`Row limit reached at row ${targetRow}`); break; }

      const rowData = grid[r];
      for (let c = 0; c < rowData.length; c++) {
        const colDef = this.getColumnByIndex(startColIndex + c);
        if (!colDef) continue;

        const rawVal = rowData[c];
        const parsed = this._parseInputValue(rawVal, colDef.type);
        const valErr = this._validateValue(parsed, colDef.validation);
        if (valErr) { errors.push(`(${targetRow},${colDef.name}): ${valErr}`); }

        this.setCell(targetRow, colDef.id, parsed, true); // treat paste as manual
        written++;
      }
    }
    return { written, errors };
  }

  /* ── Invoice boundaries ── */

  closeInvoice(lastRow) {
    this.invoiceBoundaries.add(lastRow);
    this._markAllDirty(); // discount formulas depend on boundaries
  }

  openInvoice(lastRow) {
    this.invoiceBoundaries.delete(lastRow);
    this._markAllDirty();
  }

  /**
   * Get the row range [start, end] (inclusive) of the invoice
   * that contains the given row.
   */
  getInvoiceRange(row) {
    const boundaries = [...this.invoiceBoundaries].sort((a, b) => a - b);
    let start = 0;
    for (const boundary of boundaries) {
      if (row <= boundary) return [start, boundary];
      start = boundary + 1;
    }
    return [start, this.maxRow];
  }

  /* ── Lookup index ── */

  /**
   * Build or return cached lookup index for a column.
   * O(1) lookup after first build.
   * @returns {Map<value, Set<rowIndex>>}
   */
  getLookupIndex(colId) {
    if (this._lookupIndex.has(colId)) return this._lookupIndex.get(colId);
    const index = new Map();
    for (const [row, rowMap] of this.cells) {
      const cell = rowMap.get(colId);
      if (!cell) continue;
      const val = cell.m !== null ? cell.m : cell.v;
      if (val === null || val === undefined) continue;
      const key = String(val);
      if (!index.has(key)) index.set(key, new Set());
      index.get(key).add(row);
    }
    this._lookupIndex.set(colId, index);
    return index;
  }

  /**
   * Get all unique values in a column (for Dropdown / Validation).
   * @returns {Array}
   */
  getUniqueValues(colId) {
    return [...this.getLookupIndex(colId).keys()];
  }

  _invalidateLookupIndex(colId) {
    this._lookupIndex.delete(colId);
  }

  /* ── Dirty tracking ── */

  getDirtyRows() { return new Set(this._dirtyRows); }
  clearDirty()   { this._dirtyRows.clear(); }

  _markAllDirty() {
    for (const row of this.cells.keys()) this._dirtyRows.add(row);
  }

  /* ── Serialization helpers ── */

  /**
   * Extract a row as plain object for Firestore persistence.
   * Only persists non-null cells to keep documents small.
   */
  serializeRow(rowIndex) {
    const rowMap = this.cells.get(rowIndex);
    if (!rowMap || rowMap.size === 0) return null;
    const obj = {};
    for (const [colId, cell] of rowMap) {
      const entry = {};
      if (cell.v !== null) entry.v = cell.v;
      if (cell.m !== null) entry.m = cell.m;
      if (cell.lnk)        entry.lnk = cell.lnk;
      if (Object.keys(entry).length) obj[colId] = entry;
    }
    return Object.keys(obj).length ? obj : null;
  }

  /**
   * Load a row from Firestore snapshot data.
   */
  loadRow(rowIndex, data) {
    if (!data) return;
    for (const [colId, entry] of Object.entries(data)) {
      if (!this.cells.has(rowIndex)) this.cells.set(rowIndex, new Map());
      const cell = makeCell(entry.v ?? null);
      cell.m   = entry.m   ?? null;
      cell.lnk = entry.lnk ?? null;
      this.cells.get(rowIndex).set(colId, cell);
    }
    if (rowIndex > this.maxRow) this.maxRow = rowIndex;
    this._invalidateLookupIndex('*'); // wildcard invalidation
  }

  /* ── Private helpers ── */

  _parseInputValue(raw, type) {
    if (raw === null || raw === undefined || raw === '') return null;
    switch (type) {
      case COL_TYPES.NUMBER:
      case COL_TYPES.CURRENCY:
      case COL_TYPES.PERCENTAGE: {
        const n = parseFloat(String(raw).replace(/,/g, ''));
        return isNaN(n) ? raw : n;
      }
      case COL_TYPES.DATE: {
        const d = new Date(raw);
        return isNaN(d) ? raw : d.toISOString().slice(0, 10);
      }
      default:
        return String(raw);
    }
  }

  _validateValue(value, validation) {
    if (!validation || validation.type === VALIDATION_TYPES.NONE) return null;
    switch (validation.type) {
      case VALIDATION_TYPES.NUMBER_RANGE: {
        const n = Number(value);
        if (isNaN(n)) return 'قيمة رقمية مطلوبة';
        if (validation.min !== undefined && n < validation.min) return `أقل من الحد الأدنى ${validation.min}`;
        if (validation.max !== undefined && n > validation.max) return `أكبر من الحد الأقصى ${validation.max}`;
        return null;
      }
      case VALIDATION_TYPES.NO_ZERO: {
        if (Number(value) === 0) return 'لا يُسمح بالقيمة صفر';
        return null;
      }
      case VALIDATION_TYPES.LIST_RANGE:
        // Checked by FormulaEngine against live lookup index
        return null;
      default:
        return null;
    }
  }

  _formulaReferences(formulaDef, colId) {
    if (!formulaDef) return false;
    return JSON.stringify(formulaDef).includes(colId);
  }
}

/* ─────────────────────────────────────────────────────────────
   FORMULA ENGINE
───────────────────────────────────────────────────────────── */
class FormulaEngine {
  /**
   * @param {Map<string, Sheet>} sheets  - all sheets for this branch
   */
  constructor(sheets) {
    this.sheets = sheets; // Map<sheetName, Sheet>
    this._depGraph = new Map(); // colId → Set<colId> (depends on)
  }

  /**
   * Recalculate all formula columns in all sheets that have dirty rows.
   * Returns Map<sheetName, Set<rowIndex>> of cells updated.
   */
  recalcDirty() {
    const updated = new Map();

    for (const [sheetName, sheet] of this.sheets) {
      const dirtyRows = sheet.getDirtyRows();
      if (dirtyRows.size === 0) continue;

      // Always include the originally-dirtied rows — a manual edit to a
      // plain (non-formula) cell still needs to be reported so callers
      // can repaint it, even if no formula's computed value changed.
      const affectedRows = new Set(dirtyRows);

      const formulaCols = sheet.columns.filter(
        c => c.formulaType !== FORMULA_TYPES.NONE
      );

      if (formulaCols.length > 0) {
        // Topological sort of formula columns by dependency
        const ordered = this._topoSort(formulaCols, sheet);
        for (const col of ordered) {
          const propagated = this._recalcColumn(sheet, col, dirtyRows);
          propagated.forEach(r => affectedRows.add(r));
        }
      }

      updated.set(sheetName, affectedRows);
      sheet.clearDirty();
    }

    return updated;
  }

  /**
   * Force recalculate a specific column across all rows.
   */
  recalcColumn(sheetName, colId) {
    const sheet = this.sheets.get(sheetName);
    if (!sheet) return;
    const col = sheet.getColumnById(colId);
    if (!col || col.formulaType === FORMULA_TYPES.NONE) return;
    const allRows = new Set(sheet.cells.keys());
    this._recalcColumn(sheet, col, allRows);
  }

  /* ── Formula evaluators ── */

  _recalcColumn(sheet, col, dirtyRows) {
    const updated = new Set();

    for (const row of dirtyRows) {
      let result = null;
      try {
        result = this._evalCell(sheet, col, row);
      } catch (e) {
        result = `#ERR: ${e.message}`;
      }
      // Only write if changed (avoid infinite loops)
      const current = sheet.getCell(row, col.id);
      const currentVal = current?.m !== null ? current?.m : current?.v;
      if (result !== currentVal) {
        sheet.setCell(row, col.id, result, false);
        updated.add(row);
      }
    }

    return updated;
  }

  _evalCell(sheet, col, row) {
    const { formulaType, formulaDef } = col;

    switch (formulaType) {
      case FORMULA_TYPES.LOOKUP:
        return this._evalLookup(sheet, formulaDef, row);

      case FORMULA_TYPES.ARITHMETIC:
        return this._evalArithmetic(sheet, formulaDef, row);

      case FORMULA_TYPES.CONDITIONAL:
        return this._evalConditional(sheet, formulaDef, row);

      case FORMULA_TYPES.DISCOUNT:
        return this._evalDiscount(sheet, formulaDef, row);

      default:
        return null;
    }
  }

  /**
   * ب — LOOKUP
   * formulaDef: { keyColId, keySheetName?, valueColId, valueSheetName? }
   *
   * Looks up the value in keyCol of this row in the source sheet,
   * returns the corresponding value from valueCol.
   */
  _evalLookup(sheet, def, row) {
    const keySheet   = def.keySheetName   ? this.sheets.get(def.keySheetName)   : sheet;
    const valueSheet = def.valueSheetName ? this.sheets.get(def.valueSheetName) : sheet;
    if (!keySheet || !valueSheet) return null;

    const lookupKey = sheet.displayValue(row, def.keyColId);
    if (lookupKey === null) return null;

    // Use lookup index for O(1) search
    const index = valueSheet.getLookupIndex(def.sourceKeyColId ?? def.keyColId);
    const matchingRows = index.get(String(lookupKey));
    if (!matchingRows || matchingRows.size === 0) return null;

    const firstMatch = matchingRows.values().next().value;
    return valueSheet.displayValue(firstMatch, def.valueColId);
  }

  /**
   * ج — ARITHMETIC
   * formulaDef: { expression: string }
   *
   * expression uses column IDs as variables:
   * e.g. "#{colId1} * #{colId2} + 100"
   * Supports +, -, *, /, (), unary minus, abs(), round(), floor(), ceil()
   */
  _evalArithmetic(sheet, def, row) {
    if (!def.expression) return null;

    let expr = def.expression;
    // Replace #{colId} with actual cell values
    expr = expr.replace(/#\{([^}]+)\}/g, (_, colId) => {
      // Support cross-sheet: #{sheetName.colId}
      let targetSheet = sheet;
      let targetColId = colId;
      if (colId.includes('.')) {
        const [sn, cid] = colId.split('.');
        targetSheet  = this.sheets.get(sn) ?? sheet;
        targetColId  = cid;
      }
      const val = targetSheet.displayValue(row, targetColId);
      const num = parseFloat(val);
      return isNaN(num) ? '0' : String(num);
    });

    return this._safeEval(expr);
  }

  /**
   * د — CONDITIONAL (IF/IFS)
   * formulaDef: { conditions: [{ test, trueExpr, falseExpr }] }
   *
   * Each test is a simple expression that evaluates to truthy/falsy.
   */
  _evalConditional(sheet, def, row) {
    if (!def.conditions?.length) return null;

    const resolveExpr = expr => {
      if (expr === undefined || expr === null) return null;
      return this._evalArithmetic(sheet, { expression: expr }, row);
    };

    for (const cond of def.conditions) {
      const testResult = resolveExpr(cond.test);
      if (testResult) return resolveExpr(cond.trueExpr);
    }

    const last = def.conditions[def.conditions.length - 1];
    return resolveExpr(last.falseExpr ?? null);
  }

  /**
   * هـ — DISCOUNT DISTRIBUTION
   * formulaDef: {
   *   itemTotalColId:    string,  // total price of this item
   *   discountColId:     string,  // total invoice discount amount (one cell, any row of invoice)
   *   invoiceTotalColId: string,  // total of all items in invoice (for ratio)
   *   outputMode: 'share' | 'new_price' | 'invoice_total_after'
   * }
   */
  _evalDiscount(sheet, def, row) {
    const [invoiceStart, invoiceEnd] = sheet.getInvoiceRange(row);

    // Sum of all item totals within this invoice
    let invoiceTotal = 0;
    for (let r = invoiceStart; r <= invoiceEnd; r++) {
      const v = parseFloat(sheet.displayValue(r, def.itemTotalColId));
      if (!isNaN(v)) invoiceTotal += v;
    }
    if (invoiceTotal === 0) return 0;

    // Discount amount — read from any row in invoice (first non-null wins)
    let discount = 0;
    for (let r = invoiceStart; r <= invoiceEnd; r++) {
      const v = parseFloat(sheet.displayValue(r, def.discountColId));
      if (!isNaN(v)) { discount = v; break; }
    }

    const itemTotal = parseFloat(sheet.displayValue(row, def.itemTotalColId)) || 0;
    const ratio     = itemTotal / invoiceTotal;
    const share     = discount * ratio;

    switch (def.outputMode) {
      case 'share':               return this._round(share, 4);
      case 'new_price':           return this._round(itemTotal - share, 4);
      case 'invoice_total_after': return this._round(invoiceTotal - discount, 4);
      default:                    return this._round(share, 4);
    }
  }

  /* ── Dependency graph & topological sort ── */

  /**
   * Returns formula columns in evaluation order (dependencies first).
   * Detects cycles and throws if found.
   */
  _topoSort(formulaCols, sheet) {
    const idSet  = new Set(formulaCols.map(c => c.id));
    const result = [];
    const visited = new Set();
    const inStack = new Set();

    const visit = (col) => {
      if (inStack.has(col.id)) throw new Error(`حلقة دائرية في المعادلات: ${col.name}`);
      if (visited.has(col.id)) return;
      inStack.add(col.id);

      const deps = this._getFormulaDeps(col);
      for (const depId of deps) {
        if (!idSet.has(depId)) continue;
        const depCol = sheet.getColumnById(depId);
        if (depCol) visit(depCol);
      }

      inStack.delete(col.id);
      visited.add(col.id);
      result.push(col);
    };

    for (const col of formulaCols) visit(col);
    return result;
  }

  _getFormulaDeps(col) {
    const deps = new Set();
    const def  = col.formulaDef;
    if (!def) return deps;

    // Extract #{colId} references from expressions
    const exprs = [
      def.expression,
      def.keyColId,
      def.valueColId,
      def.itemTotalColId,
      def.discountColId,
      def.invoiceTotalColId,
      ...(def.conditions ?? []).flatMap(c => [c.test, c.trueExpr, c.falseExpr]),
    ].filter(Boolean).join(' ');

    const matches = exprs.matchAll(/#\{([^}.]+)\}/g);
    for (const m of matches) deps.add(m[1]);

    return deps;
  }

  /* ── Safe expression evaluator ── */

  _safeEval(expr) {
    // Only allow: digits, operators, parens, spaces, decimal points
    // Plus a whitelist of math function names
    const sanitized = expr
      .replace(/\babs\b/g,   'Math.abs')
      .replace(/\bround\b/g, 'Math.round')
      .replace(/\bfloor\b/g, 'Math.floor')
      .replace(/\bceil\b/g,  'Math.ceil')
      .replace(/\bmin\b/g,   'Math.min')
      .replace(/\bmax\b/g,   'Math.max');

    // Security: reject anything that isn't math
    if (/[^0-9+\-*/().,%\sMath.absroundflorceil\s]/.test(sanitized.replace(/Math\.(abs|round|floor|ceil|min|max)/g, ''))) {
      throw new Error('تعبير غير مسموح به');
    }

    // eslint-disable-next-line no-new-func
    const result = Function(`"use strict"; return (${sanitized})`)();
    return isFinite(result) ? result : null;
  }

  _round(n, decimals = 2) {
    return Math.round(n * 10 ** decimals) / 10 ** decimals;
  }
}

/* ─────────────────────────────────────────────────────────────
   WORKBOOK  (one per branch)
───────────────────────────────────────────────────────────── */
class Workbook {
  constructor(branchId) {
    this.branchId = branchId;

    /** @type {Map<string, Sheet>} */
    this.sheets = new Map(
      SHEET_NAMES.map(name => [name, new Sheet(name, branchId)])
    );

    this.formulaEngine = new FormulaEngine(this.sheets);
  }

  getSheet(name) {
    return this.sheets.get(name) ?? null;
  }

  /**
   * Trigger recalculation of all dirty cells across all sheets.
   * Returns a map of updated rows per sheet for the renderer.
   */
  recalc() {
    return this.formulaEngine.recalcDirty();
  }

  /**
   * Force full recalc of all formula columns everywhere.
   * Used after bulk paste or column definition changes.
   */
  fullRecalc() {
    for (const [, sheet] of this.sheets) {
      for (const row of sheet.cells.keys()) sheet._dirtyRows.add(row);
    }
    return this.formulaEngine.recalcDirty();
  }
}

/* ─────────────────────────────────────────────────────────────
   DATA VALIDATION REGISTRY
───────────────────────────────────────────────────────────── */
class ValidationRegistry {
  constructor(workbook) {
    this.workbook = workbook;
    /** colId → validationConfig */
    this._rules = new Map();
  }

  setRule(colId, rule) {
    this._rules.set(colId, rule);
  }

  getRule(colId) {
    return this._rules.get(colId) ?? null;
  }

  /**
   * Validate a value against the rule for this column.
   * Returns null (valid) or an Arabic error string.
   * @param {string} sheetName
   * @param {string} colId
   * @param {*}      value
   * @returns {string|null}
   */
  validate(sheetName, colId, value) {
    const rule = this._rules.get(colId);
    if (!rule || rule.type === VALIDATION_TYPES.NONE) return null;

    switch (rule.type) {
      case VALIDATION_TYPES.LIST_RANGE: {
        const srcSheet = this.workbook.getSheet(rule.sourceSheetName ?? sheetName);
        if (!srcSheet) return null;
        const allowed = srcSheet.getUniqueValues(rule.sourceColId);
        if (!allowed.includes(String(value))) {
          return `القيمة غير موجودة في القائمة`;
        }
        return null;
      }
      case VALIDATION_TYPES.NUMBER_RANGE: {
        const n = parseFloat(value);
        if (isNaN(n)) return 'قيمة رقمية مطلوبة';
        if (rule.min !== undefined && n < rule.min) return `أقل من الحد الأدنى (${rule.min})`;
        if (rule.max !== undefined && n > rule.max) return `أكبر من الحد الأقصى (${rule.max})`;
        return null;
      }
      case VALIDATION_TYPES.NO_ZERO: {
        if (Number(value) === 0) return 'لا يُسمح بالقيمة صفر';
        return null;
      }
      default:
        return null;
    }
  }

  /**
   * Get dropdown options for a LIST_RANGE column.
   * Returns sorted, unique values — O(1) via lookup index.
   */
  getDropdownOptions(sheetName, colId, query = '') {
    const rule = this._rules.get(colId);
    if (!rule || rule.type !== VALIDATION_TYPES.LIST_RANGE) return [];

    const srcSheet = this.workbook.getSheet(rule.sourceSheetName ?? sheetName);
    if (!srcSheet) return [];

    let values = srcSheet.getUniqueValues(rule.sourceColId);
    if (query) {
      const q = query.toLowerCase();
      values = values.filter(v => v.toLowerCase().includes(q));
    }
    return values.sort();
  }
}

/* ─────────────────────────────────────────────────────────────
   CLIPBOARD PARSER  (Excel paste)
───────────────────────────────────────────────────────────── */
const ClipboardParser = {
  /**
   * Parse TSV data as copied from Excel.
   * Handles: Tab separators, newline rows, quoted cells with commas/tabs inside.
   * @param {string} raw - clipboard text
   * @returns {Array<Array<string>>} 2D array
   */
  parse(raw) {
    const rows = [];
    // Excel uses \r\n
    const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

    for (const line of lines) {
      // Skip trailing empty line
      if (line === '' && rows.length > 0 && line === lines[lines.length - 1]) continue;
      rows.push(this._parseTSVRow(line));
    }

    return rows;
  },

  _parseTSVRow(line) {
    const cells = [];
    let i = 0;
    while (i < line.length) {
      if (line[i] === '"') {
        // Quoted cell
        let cell = '';
        i++; // skip opening quote
        while (i < line.length) {
          if (line[i] === '"' && line[i + 1] === '"') {
            cell += '"'; i += 2;
          } else if (line[i] === '"') {
            i++; break;
          } else {
            cell += line[i++];
          }
        }
        cells.push(cell);
        if (line[i] === '\t') i++;
      } else {
        let cell = '';
        while (i < line.length && line[i] !== '\t') cell += line[i++];
        cells.push(cell);
        if (line[i] === '\t') i++;
      }
    }
    return cells;
  },

  /**
   * Serialize a 2D array to TSV for copying to Excel.
   */
  serialize(grid) {
    return grid
      .map(row => row
        .map(cell => {
          const s = cell === null || cell === undefined ? '' : String(cell);
          // Quote cells that contain tab, newline, or double-quote
          if (s.includes('\t') || s.includes('\n') || s.includes('"')) {
            return `"${s.replace(/"/g, '""')}"`;
          }
          return s;
        })
        .join('\t')
      )
      .join('\r\n');
  },
};

/* ─────────────────────────────────────────────────────────────
   FIND & REPLACE ENGINE
───────────────────────────────────────────────────────────── */
class FindReplace {
  /**
   * @param {Sheet} sheet
   */
  constructor(sheet) {
    this.sheet = sheet;
    this._results = []; // [{row, colId}]
    this._cursor  = -1;
  }

  /**
   * Find all matches in the sheet.
   * @param {string}  query
   * @param {object}  opts - { exact, caseSensitive, colId? }
   * @returns {number} count
   */
  find(query, opts = {}) {
    this._results = [];
    this._cursor  = -1;
    if (!query) return 0;

    const q = opts.caseSensitive ? query : query.toLowerCase();

    const colIds = opts.colId
      ? [opts.colId]
      : this.sheet.columns.map(c => c.id);

    for (const [row] of [...this.sheet.cells.entries()].sort(([a],[b]) => a - b)) {
      for (const colId of colIds) {
        const val = this.sheet.displayValue(row, colId);
        if (val === null) continue;
        const s = opts.caseSensitive ? String(val) : String(val).toLowerCase();
        const match = opts.exact ? s === q : s.includes(q);
        if (match) this._results.push({ row, colId });
      }
    }

    return this._results.length;
  }

  next()  { if (this._results.length) this._cursor = (this._cursor + 1) % this._results.length; return this.current(); }
  prev()  { if (this._results.length) this._cursor = (this._cursor - 1 + this._results.length) % this._results.length; return this.current(); }
  current(){ return this._results[this._cursor] ?? null; }
  results(){ return this._results; }

  /**
   * Replace current match.
   */
  replaceCurrent(replacement) {
    const cur = this.current();
    if (!cur) return false;
    this.sheet.setCell(cur.row, cur.colId, replacement, true);
    return true;
  }

  /**
   * Replace all matches.
   * @returns {number} replaced count
   */
  replaceAll(query, replacement, opts = {}) {
    this.find(query, opts);
    let count = 0;
    for (const { row, colId } of this._results) {
      const val = String(this.sheet.displayValue(row, colId) ?? '');
      const q   = opts.caseSensitive ? query : query.toLowerCase();
      const v   = opts.caseSensitive ? val   : val.toLowerCase();
      let newVal;
      if (opts.exact) {
        newVal = v === q ? replacement : val;
      } else {
        const re = new RegExp(
          query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          opts.caseSensitive ? 'g' : 'gi'
        );
        newVal = val.replace(re, replacement);
      }
      if (newVal !== val) {
        this.sheet.setCell(row, colId, newVal, true);
        count++;
      }
    }
    return count;
  }
}

/* ─────────────────────────────────────────────────────────────
   EXPORTS  (works as ES Module or Web Worker import)
───────────────────────────────────────────────────────────── */
const Engine = {
  MAX_ROWS,
  MAX_COLS,
  SHEET_NAMES,
  COL_TYPES,
  FORMULA_TYPES,
  VALIDATION_TYPES,
  Sheet,
  Workbook,
  FormulaEngine,
  ValidationRegistry,
  ClipboardParser,
  FindReplace,
  makeColumnDef,
  makeCell,
};

// ES Module export (for bundlers / modern browsers)
if (typeof module !== 'undefined') {
  module.exports = Engine;
}
// Global (for direct <script> use)
if (typeof self !== 'undefined') {
  self.GREngine = Engine;
}
