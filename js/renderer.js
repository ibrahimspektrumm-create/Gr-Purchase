/**
 * GR Purchase — Virtual Renderer
 * ════════════════════════════════════════════════════════════
 * Bidirectional virtual rendering (rows + columns).
 * Only DOM nodes for the visible viewport + overscan buffer.
 * Supports:
 *  - Frozen rows / columns (pixel-perfect alignment)
 *  - Scrollbar that reflects true sheet size (50k × 200)
 *  - Per-cell states: manual-override indicator, link, validation error
 *  - Neon separators for invoice boundaries
 *  - JARVIS OMEGA X visual theme applied at cell level
 *  - Cell selection (single / multi / range)
 *  - Keyboard navigation (with RTL awareness)
 * ════════════════════════════════════════════════════════════
 */

'use strict';

const DEFAULT_ROW_HEIGHT = 34;   // px
const DEFAULT_COL_WIDTH  = 120;  // px
const ROW_HEADER_WIDTH   = 52;   // px — row number gutter
const COL_HEADER_HEIGHT  = 36;   // px — column letter row
const OVERSCAN_ROWS      = 8;    // extra rows above/below viewport
const OVERSCAN_COLS      = 4;    // extra cols left/right viewport

class VirtualRenderer {
  /**
   * @param {HTMLElement} container  - the scrollable outer div
   * @param {object}      options
   */
  constructor(container, options = {}) {
    this.container = container;

    /* sheet meta — updated by host when data changes */
    this.totalRows    = 0;
    this.columns      = [];        // ColumnDef[]
    this.rowHeights   = {};        // sparse: rowIndex → px
    this.frozenRows   = options.frozenRows ?? 0;
    this.frozenCols   = options.frozenCols ?? 0;
    this.invoiceBoundaries = new Set();

    /* display data: Map<row, Map<colId, displayValue>> */
    this._data        = new Map();
    this._links       = new Map();    // row+colId → url
    this._manuals     = new Map();    // row+colId → bool (manual override)
    this._validErrors = new Map();    // row+colId → error string

    /* selection */
    this.selection    = { anchor: null, focus: null }; // { row, col }
    this._selecting   = false;

    /* scroll state */
    this._scrollTop   = 0;
    this._scrollLeft  = 0;

    /* callbacks */
    this.onCellClick    = null;
    this.onCellDblClick = null;
    this.onSelectionChange = null;
    this.onKeyDown      = null;
    this.onScroll       = null;    // ({ top, left, firstVisibleRow, firstVisibleCol })

    this._build();
    this._bindEvents();
  }

  /* ── Public API ── */

  /**
   * Set / update sheet metadata and trigger full re-render.
   */
  setSheet({ totalRows, columns, frozenRows = 0, frozenCols = 0 }) {
    this.totalRows  = Math.min(totalRows, 50_000);
    this.columns    = columns;
    this.frozenRows = frozenRows;
    this.frozenCols = frozenCols;
    this._updateScrollSize();
    this.render();
  }

  /**
   * Feed display data for a range of rows.
   * data: { [rowIndex]: { [colId]: value, [colId+'__lnk']: url, [colId+'__manual']: bool } }
   */
  loadData(data) {
    for (const [rowStr, cols] of Object.entries(data)) {
      const row = parseInt(rowStr);
      if (!this._data.has(row)) this._data.set(row, new Map());
      const rowMap = this._data.get(row);

      for (const [key, val] of Object.entries(cols)) {
        if (key.endsWith('__lnk')) {
          this._links.set(`${row}:${key.slice(0,-5)}`, val);
        } else if (key.endsWith('__manual')) {
          this._manuals.set(`${row}:${key.slice(0,-8)}`, true);
        } else {
          rowMap.set(key, val);
        }
      }
    }
    this._renderViewport();
  }

  setValidationError(row, colId, error) {
    const key = `${row}:${colId}`;
    if (error) this._validErrors.set(key, error);
    else        this._validErrors.delete(key);
    this._refreshCell(row, colId);
  }

  setInvoiceBoundaries(boundaries) {
    this.invoiceBoundaries = new Set(boundaries);
    this._renderViewport();
  }

  scrollToCell(row, colIndex) {
    const top  = this._rowTop(row);
    const left = this._colLeft(colIndex);
    this._scrollEl.scrollTop  = Math.max(0, top  - COL_HEADER_HEIGHT - 80);
    this._scrollEl.scrollLeft = Math.max(0, left - ROW_HEADER_WIDTH  - 80);
  }

  selectCell(row, col, extend = false) {
    if (!extend) this.selection.anchor = { row, col };
    this.selection.focus = { row, col };
    this._renderSelection();
    if (this.onSelectionChange) this.onSelectionChange(this.selection);
  }

  getSelectedRange() {
    const { anchor, focus } = this.selection;
    if (!anchor || !focus) return null;
    return {
      startRow: Math.min(anchor.row, focus.row),
      endRow:   Math.max(anchor.row, focus.row),
      startCol: Math.min(anchor.col, focus.col),
      endCol:   Math.max(anchor.col, focus.col),
    };
  }

  /* ── DOM construction ── */

  _build() {
    this.container.style.cssText = `
      position: relative;
      overflow: hidden;
      width: 100%;
      height: 100%;
      background: #080C14;
    `;

    /* Outer scroll element — intercepts wheel/touch */
    this._scrollEl = document.createElement('div');
    this._scrollEl.style.cssText = `
      position: absolute;
      inset: 0;
      overflow: scroll;
      will-change: scroll-position;
    `;

    /* Inner spacer — sized to represent the full sheet */
    this._spacer = document.createElement('div');
    this._spacer.style.cssText = `
      position: absolute;
      top: 0; left: 0;
      pointer-events: none;
    `;
    this._scrollEl.appendChild(this._spacer);

    /* Canvas layer — only visible cells */
    this._canvas = document.createElement('div');
    this._canvas.style.cssText = `
      position: sticky;
      top: 0; left: 0;
      width: 0; height: 0;
      overflow: visible;
      pointer-events: none;
      z-index: 2;
    `;
    this._scrollEl.appendChild(this._canvas);

    /* Column header layer */
    this._colHeader = document.createElement('div');
    this._colHeader.className = 'gr-col-header';
    this._colHeader.style.cssText = `
      position: sticky;
      top: 0;
      left: 0;
      height: ${COL_HEADER_HEIGHT}px;
      background: #0D1421;
      border-bottom: 1.5px solid #00C2FF33;
      z-index: 10;
      display: flex;
      pointer-events: auto;
    `;

    /* Row header layer */
    this._rowHeader = document.createElement('div');
    this._rowHeader.className = 'gr-row-header';
    this._rowHeader.style.cssText = `
      position: absolute;
      top: ${COL_HEADER_HEIGHT}px;
      left: 0;
      width: ${ROW_HEADER_WIDTH}px;
      overflow: hidden;
      z-index: 9;
      pointer-events: auto;
    `;

    /* Cell viewport */
    this._viewport = document.createElement('div');
    this._viewport.className = 'gr-viewport';
    this._viewport.style.cssText = `
      position: absolute;
      top: ${COL_HEADER_HEIGHT}px;
      left: ${ROW_HEADER_WIDTH}px;
      overflow: hidden;
      z-index: 1;
      pointer-events: auto;
    `;

    /* Selection overlay */
    this._selOverlay = document.createElement('div');
    this._selOverlay.className = 'gr-selection';
    this._selOverlay.style.cssText = `
      position: absolute;
      pointer-events: none;
      z-index: 5;
      border: 2px solid #00C2FF;
      box-shadow: 0 0 0 1px #00C2FF44, 0 0 12px #00C2FF33;
      border-radius: 2px;
      transition: top 0.06s, left 0.06s, width 0.06s, height 0.06s;
      display: none;
    `;

    this._viewport.appendChild(this._selOverlay);
    this._canvas.appendChild(this._colHeader);
    this._canvas.appendChild(this._rowHeader);
    this._canvas.appendChild(this._viewport);

    this.container.appendChild(this._scrollEl);
  }

  /* ── Events ── */

  _bindEvents() {
    /* Scroll sync */
    this._scrollEl.addEventListener('scroll', () => {
      this._scrollTop  = this._scrollEl.scrollTop;
      this._scrollLeft = this._scrollEl.scrollLeft;

      /* Sync header positions */
      this._colHeader.style.transform = `translateX(-${this._scrollLeft}px)`;
      this._rowHeader.style.transform = `translateY(-${this._scrollTop}px)`;

      this._renderViewport();

      if (this.onScroll) {
        this.onScroll({
          top:             this._scrollTop,
          left:            this._scrollLeft,
          firstVisibleRow: this._firstVisibleRow(),
          firstVisibleCol: this._firstVisibleCol(),
        });
      }
    }, { passive: true });

    /* Cell pointer events (delegated) */
    this._viewport.addEventListener('pointerdown', e => {
      const cell = e.target.closest('[data-row]');
      if (!cell) return;
      const row = parseInt(cell.dataset.row);
      const col = parseInt(cell.dataset.col);
      this._selecting = true;
      this.selectCell(row, col, e.shiftKey);
    });

    this._viewport.addEventListener('pointermove', e => {
      if (!this._selecting) return;
      const cell = e.target.closest('[data-row]');
      if (!cell) return;
      const row = parseInt(cell.dataset.row);
      const col = parseInt(cell.dataset.col);
      this.selection.focus = { row, col };
      this._renderSelection();
    });

    document.addEventListener('pointerup', () => { this._selecting = false; });

    this._viewport.addEventListener('click', e => {
      const cell = e.target.closest('[data-row]');
      if (!cell) return;
      if (this.onCellClick) this.onCellClick({
        row: parseInt(cell.dataset.row),
        col: parseInt(cell.dataset.col),
        colId: cell.dataset.colId,
        event: e,
      });
    });

    this._viewport.addEventListener('dblclick', e => {
      const cell = e.target.closest('[data-row]');
      if (!cell) return;
      if (this.onCellDblClick) this.onCellDblClick({
        row:   parseInt(cell.dataset.row),
        col:   parseInt(cell.dataset.col),
        colId: cell.dataset.colId,
        event: e,
      });
    });

    /* Keyboard navigation */
    document.addEventListener('keydown', e => {
      if (this.onKeyDown && this.onKeyDown(e)) return;
      this._handleKey(e);
    });
  }

  _handleKey(e) {
    const { focus } = this.selection;
    if (!focus) return;

    const colCount = this.columns.length;
    let { row, col } = focus;
    let moved = false;

    // RTL-aware: left/right arrows are swapped for column navigation
    switch (e.key) {
      case 'ArrowDown':  row++; moved = true; break;
      case 'ArrowUp':    row--; moved = true; break;
      case 'ArrowRight': col++; moved = true; break;  // LTR column order in data
      case 'ArrowLeft':  col--; moved = true; break;
      case 'Tab':
        col += e.shiftKey ? -1 : 1; moved = true;
        e.preventDefault();
        break;
      case 'Enter':
        row++; moved = true;
        e.preventDefault();
        break;
      case 'Home':
        col = 0; moved = true;
        if (e.ctrlKey) { row = 0; }
        e.preventDefault();
        break;
      case 'End':
        col = colCount - 1; moved = true;
        if (e.ctrlKey) { row = this.totalRows - 1; }
        e.preventDefault();
        break;
      case 'PageDown':
        row += Math.floor((this._viewportHeight()) / DEFAULT_ROW_HEIGHT);
        moved = true; e.preventDefault(); break;
      case 'PageUp':
        row -= Math.floor((this._viewportHeight()) / DEFAULT_ROW_HEIGHT);
        moved = true; e.preventDefault(); break;
    }

    if (!moved) return;

    row = Math.max(0, Math.min(row, this.totalRows - 1));
    col = Math.max(0, Math.min(col, colCount - 1));
    this.selectCell(row, col, e.shiftKey);
    this.scrollToCell(row, col);
    e.preventDefault();
  }

  /* ── Rendering ── */

  _updateScrollSize() {
    const totalW = ROW_HEADER_WIDTH + this._totalWidth();
    const totalH = COL_HEADER_HEIGHT + this.totalRows * DEFAULT_ROW_HEIGHT;
    this._spacer.style.width  = totalW + 'px';
    this._spacer.style.height = totalH + 'px';
  }

  render() {
    this._updateScrollSize();
    this._renderColHeader();
    this._renderViewport();
  }

  _renderColHeader() {
    this._colHeader.innerHTML = '';

    /* Corner cell */
    const corner = document.createElement('div');
    corner.style.cssText = `
      flex-shrink: 0;
      width: ${ROW_HEADER_WIDTH}px;
      height: ${COL_HEADER_HEIGHT}px;
      background: #0D1421;
      border-right: 1px solid #1E2D47;
      border-bottom: 1px solid #00C2FF33;
      position: sticky;
      left: 0;
      z-index: 11;
    `;
    this._colHeader.appendChild(corner);

    /* Column headers */
    for (let c = 0; c < this.columns.length; c++) {
      const col = this.columns[c];
      const el  = document.createElement('div');
      const w   = col.width ?? DEFAULT_COL_WIDTH;
      el.dataset.colIndex = c;
      el.style.cssText = `
        flex-shrink: 0;
        width: ${w}px;
        height: ${COL_HEADER_HEIGHT}px;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        border-right: 1px solid #1E2D47;
        font-size: 11px;
        font-family: 'Cairo', sans-serif;
        font-weight: 600;
        color: ${c < this.frozenCols ? '#00C2FF' : '#7A92B0'};
        cursor: pointer;
        user-select: none;
        position: relative;
        background: ${c < this.frozenCols ? '#0D1421' : 'transparent'};
        transition: background 0.15s;
      `;

      const letter = this._colLetter(c);
      el.innerHTML = `
        <span style="color:#3D5472; font-size:9px; font-family:monospace">${letter}</span>
        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:${w - 28}px" title="${col.name}">${col.name}</span>
      `;

      el.addEventListener('mouseenter', () => el.style.background = '#162035');
      el.addEventListener('mouseleave', () => el.style.background = c < this.frozenCols ? '#0D1421' : 'transparent');
      this._colHeader.appendChild(el);
    }
  }

  _renderViewport() {
    const firstRow = Math.max(0, this._firstVisibleRow() - OVERSCAN_ROWS);
    const lastRow  = Math.min(this.totalRows - 1, this._lastVisibleRow() + OVERSCAN_ROWS);
    const firstCol = Math.max(0, this._firstVisibleCol() - OVERSCAN_COLS);
    const lastCol  = Math.min(this.columns.length - 1, this._lastVisibleCol() + OVERSCAN_COLS);

    /* Reuse existing DOM rows (keyed by rowIndex) */
    const existing = new Map();
    for (const el of this._viewport.querySelectorAll('[data-row-el]')) {
      existing.set(parseInt(el.dataset.rowEl), el);
    }

    const toKeep = new Set();

    for (let r = firstRow; r <= lastRow; r++) {
      toKeep.add(r);
      let rowEl = existing.get(r);
      if (!rowEl) {
        rowEl = this._createRowEl(r);
        this._viewport.appendChild(rowEl);
      }
      this._updateRowEl(rowEl, r, firstCol, lastCol);
    }

    /* Remove out-of-viewport rows */
    for (const [row, el] of existing) {
      if (!toKeep.has(row)) el.remove();
    }

    this._renderRowHeaders(firstRow, lastRow);
    this._renderSelection();
  }

  _createRowEl(row) {
    const el = document.createElement('div');
    el.dataset.rowEl = row;
    el.style.cssText = `
      position: absolute;
      left: 0;
      top: ${this._rowTop(row)}px;
      height: ${this._rowHeight(row)}px;
      display: flex;
      align-items: stretch;
    `;
    /* Invoice boundary — neon separator above row */
    if (this.invoiceBoundaries.has(row - 1)) {
      el.style.borderTop = '2px solid #00C2FF66';
      el.style.boxShadow = '0 -2px 8px rgba(0,194,255,0.2)';
    }
    return el;
  }

  _updateRowEl(rowEl, row, firstCol, lastCol) {
    rowEl.style.top    = this._rowTop(row) + 'px';
    rowEl.style.height = this._rowHeight(row) + 'px';

    /* Sync invoice boundary */
    if (this.invoiceBoundaries.has(row - 1)) {
      rowEl.style.borderTop = '2px solid #00C2FF66';
      rowEl.style.boxShadow = '0 -2px 8px rgba(0,194,255,0.2)';
    } else {
      rowEl.style.borderTop = '';
      rowEl.style.boxShadow = '';
    }

    /* Update only visible columns */
    const existingCells = new Map();
    for (const el of rowEl.querySelectorAll('[data-col]')) {
      existingCells.set(parseInt(el.dataset.col), el);
    }

    /* Left offset tracking */
    let left = 0;
    for (let c = 0; c <= lastCol; c++) {
      const col = this.columns[c];
      const w   = col.width ?? DEFAULT_COL_WIDTH;
      if (c < firstCol) { left += w; continue; }

      let cellEl = existingCells.get(c);
      if (!cellEl) {
        cellEl = this._createCellEl();
        rowEl.appendChild(cellEl);
      }

      this._updateCellEl(cellEl, row, c, col, left);
      left += w;
    }

    /* Remove off-screen cells */
    for (const [c, el] of existingCells) {
      if (c < firstCol || c > lastCol) el.remove();
    }
  }

  _createCellEl() {
    const el = document.createElement('div');
    el.style.cssText = `
      position: absolute;
      display: flex;
      align-items: center;
      padding: 0 10px;
      border-right: 1px solid #1E2D47;
      border-bottom: 1px solid #1E2D47;
      font-size: 13px;
      font-family: 'Cairo', sans-serif;
      color: #E8F0FE;
      cursor: cell;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      transition: background 0.12s;
      box-sizing: border-box;
    `;
    return el;
  }

  _updateCellEl(el, row, colIndex, col, left) {
    const h   = this._rowHeight(row);
    const w   = col.width ?? DEFAULT_COL_WIDTH;
    const key = `${row}:${col.id}`;

    el.dataset.row   = row;
    el.dataset.col   = colIndex;
    el.dataset.colId = col.id;

    el.style.left   = left + 'px';
    el.style.width  = w + 'px';
    el.style.height = h + 'px';
    el.style.top    = '0';

    const val     = this._data.get(row)?.get(col.id) ?? null;
    const link    = this._links.get(key);
    const manual  = this._manuals.get(key);
    const valErr  = this._validErrors.get(key);

    /* Format value */
    const displayText = val === null ? '' : this._formatValue(val, col);

    /* Background */
    let bg = 'transparent';
    if (valErr)  bg = 'rgba(239,68,68,0.08)';

    el.style.background  = bg;
    el.style.color       = link ? '#38BDF8' : '#E8F0FE';
    el.style.textDecoration = link ? 'underline' : 'none';
    el.style.fontStyle   = 'normal';
    /* Manual override indicator — subtle left border */
    el.style.borderLeft  = manual ? '2px solid #F59E0B' : '';

    /* Text alignment */
    const isNumeric = [
      'number','currency','percentage'
    ].includes(col.type);
    el.style.justifyContent = isNumeric ? 'flex-end' : 'flex-start';
    el.style.direction = 'rtl';

    if (link) {
      el.innerHTML = `<a href="${link}" target="_blank" rel="noopener"
        style="color:inherit;text-decoration:inherit;overflow:hidden;text-overflow:ellipsis;pointer-events:auto"
        title="${link}">${displayText}</a>`;
    } else {
      el.textContent = displayText;
      if (valErr) {
        el.title = valErr;
        el.style.boxShadow = 'inset 0 0 0 1px rgba(239,68,68,0.5)';
      } else {
        el.title = '';
        el.style.boxShadow = '';
      }
    }

    /* Hover effect */
    el.onmouseenter = () => { el.style.background = valErr ? 'rgba(239,68,68,0.12)' : 'rgba(0,194,255,0.04)'; };
    el.onmouseleave = () => { el.style.background = bg; };
  }

  _renderRowHeaders(firstRow, lastRow) {
    this._rowHeader.innerHTML = '';
    for (let r = firstRow; r <= lastRow; r++) {
      const h  = this._rowHeight(r);
      const el = document.createElement('div');
      el.style.cssText = `
        position: absolute;
        top: ${this._rowTop(r)}px;
        width: ${ROW_HEADER_WIDTH}px;
        height: ${h}px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-right: 1.5px solid #00C2FF22;
        border-bottom: 1px solid #1E2D47;
        font-size: 11px;
        font-family: monospace;
        color: #3D5472;
        background: #0D1421;
        cursor: row-resize;
        user-select: none;
      `;
      el.textContent = r + 1;
      this._rowHeader.appendChild(el);
    }
  }

  _renderSelection() {
    const range = this.getSelectedRange();
    if (!range) { this._selOverlay.style.display = 'none'; return; }

    const top  = this._rowTop(range.startRow);
    const left = this._colLeft(range.startCol);
    const w    = this._rangeWidth(range.startCol, range.endCol);
    const h    = this._rangeHeight(range.startRow, range.endRow);

    this._selOverlay.style.display = 'block';
    this._selOverlay.style.top     = top  + 'px';
    this._selOverlay.style.left    = left + 'px';
    this._selOverlay.style.width   = w    + 'px';
    this._selOverlay.style.height  = h    + 'px';
  }

  _refreshCell(row, colId) {
    const el = this._viewport.querySelector(`[data-row="${row}"][data-col-id="${colId}"]`);
    if (!el) return;
    const colIndex = parseInt(el.dataset.col);
    const col      = this.columns[colIndex];
    if (!col) return;
    this._updateCellEl(el, row, colIndex, col, parseInt(el.style.left));
  }

  /* ── Geometry helpers ── */

  _rowHeight(row) {
    return this.rowHeights[row] ?? DEFAULT_ROW_HEIGHT;
  }

  _rowTop(row) {
    let top = 0;
    for (let r = 0; r < row; r++) top += this._rowHeight(r);
    return top;
  }

  _colLeft(colIndex) {
    let left = 0;
    for (let c = 0; c < colIndex; c++) {
      left += (this.columns[c]?.width ?? DEFAULT_COL_WIDTH);
    }
    return left;
  }

  _totalWidth() {
    return this.columns.reduce((s, c) => s + (c.width ?? DEFAULT_COL_WIDTH), 0);
  }

  _viewportHeight() {
    return this.container.offsetHeight - COL_HEADER_HEIGHT;
  }

  _firstVisibleRow() {
    let top = 0, r = 0;
    while (r < this.totalRows && top < this._scrollTop) {
      top += this._rowHeight(r++);
    }
    return Math.max(0, r - 1);
  }

  _lastVisibleRow() {
    const bottom = this._scrollTop + this._viewportHeight();
    let top = 0, r = 0;
    while (r < this.totalRows && top < bottom) {
      top += this._rowHeight(r++);
    }
    return Math.min(this.totalRows - 1, r);
  }

  _firstVisibleCol() {
    let left = this._scrollLeft, c = 0;
    while (c < this.columns.length && left > 0) {
      left -= (this.columns[c++]?.width ?? DEFAULT_COL_WIDTH);
    }
    return Math.max(0, c - 1);
  }

  _lastVisibleCol() {
    const right = this._scrollLeft + this.container.offsetWidth - ROW_HEADER_WIDTH;
    let left = 0, c = 0;
    while (c < this.columns.length && left < right) {
      left += (this.columns[c++]?.width ?? DEFAULT_COL_WIDTH);
    }
    return Math.min(this.columns.length - 1, c);
  }

  _rangeWidth(startCol, endCol) {
    let w = 0;
    for (let c = startCol; c <= endCol; c++) w += (this.columns[c]?.width ?? DEFAULT_COL_WIDTH);
    return w;
  }

  _rangeHeight(startRow, endRow) {
    let h = 0;
    for (let r = startRow; r <= endRow; r++) h += this._rowHeight(r);
    return h;
  }

  _colLetter(index) {
    let s = '';
    index++;
    while (index > 0) {
      const r = (index - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      index = Math.floor((index - 1) / 26);
    }
    return s;
  }

  _formatValue(val, col) {
    if (val === null || val === undefined) return '';
    switch (col.type) {
      case 'currency': {
        const n = parseFloat(val);
        if (isNaN(n)) return String(val);
        const fmt = col.format || {};
        return new Intl.NumberFormat(fmt.locale ?? 'de-DE', {
          style:                 'currency',
          currency:              fmt.currency ?? 'EUR',
          minimumFractionDigits: fmt.decimals ?? 2,
          maximumFractionDigits: fmt.decimals ?? 2,
        }).format(n);
      }
      case 'percentage': {
        const n = parseFloat(val);
        if (isNaN(n)) return String(val);
        return (n * (col.format?.asDecimal ? 100 : 1)).toFixed(col.format?.decimals ?? 1) + '%';
      }
      case 'number': {
        const n = parseFloat(val);
        if (isNaN(n)) return String(val);
        const fmt = col.format || {};
        return new Intl.NumberFormat(fmt.locale ?? 'de-DE', {
          minimumFractionDigits: fmt.decimals ?? 0,
          maximumFractionDigits: fmt.decimals ?? 4,
          useGrouping:           fmt.thousands ?? true,
        }).format(n);
      }
      case 'date': {
        if (!val) return '';
        const d = new Date(val);
        if (isNaN(d)) return String(val);
        return new Intl.DateTimeFormat(col.format?.locale ?? 'de-DE').format(d);
      }
      default:
        return String(val);
    }
  }
}

/* Export */
if (typeof module !== 'undefined') module.exports = { VirtualRenderer };
if (typeof self   !== 'undefined') self.GRRenderer = { VirtualRenderer };
