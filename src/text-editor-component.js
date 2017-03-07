const etch = require('etch')
const {CompositeDisposable} = require('event-kit')
const $ = etch.dom
const TextEditorElement = require('./text-editor-element')
const resizeDetector = require('element-resize-detector')({strategy: 'scroll'})

const DEFAULT_ROWS_PER_TILE = 6
const NORMAL_WIDTH_CHARACTER = 'x'
const DOUBLE_WIDTH_CHARACTER = '我'
const HALF_WIDTH_CHARACTER = 'ﾊ'
const KOREAN_CHARACTER = '세'
const NBSP_CHARACTER = '\u00a0'

module.exports =
class TextEditorComponent {
  constructor (props) {
    this.props = props
    this.element = props.element || new TextEditorElement()
    this.element.initialize(this)
    this.virtualNode = $('atom-text-editor')
    this.virtualNode.domNode = this.element
    this.refs = {}

    this.disposables = new CompositeDisposable()
    this.updateScheduled = false
    this.measurements = null
    this.visible = false
    this.horizontalPositionsToMeasure = new Map() // Keys are rows with positions we want to measure, values are arrays of columns to measure
    this.horizontalPixelPositionsByScreenLineId = new Map() // Values are maps from column to horiontal pixel positions
    this.lineNodesByScreenLineId = new Map()
    this.textNodesByScreenLineId = new Map()
    this.pendingAutoscroll = null
    this.autoscrollTop = null
    this.contentWidthOrHeightChanged = false
    this.previousScrollWidth = 0
    this.previousScrollHeight = 0
    this.lastKeydown = null
    this.lastKeydownBeforeKeypress = null
    this.openedAccentedCharacterMenu = false
    this.decorationsToRender = {
      lineNumbers: new Map(),
      lines: new Map(),
      highlights: new Map(),
      cursors: []
    }
    this.decorationsToMeasure = {
      highlights: new Map(),
      cursors: []
    }

    if (this.props.model) this.observeModel()
    resizeDetector.listenTo(this.element, this.didResize.bind(this))

    etch.updateSync(this)
  }

  update (props) {
    this.props = props
    this.scheduleUpdate()
  }

  scheduleUpdate () {
    if (this.updatedSynchronously) {
      this.updateSync()
    } else if (!this.updateScheduled) {
      this.updateScheduled = true
      etch.getScheduler().updateDocument(() => {
        if (this.updateScheduled) this.updateSync()
      })
    }
  }

  updateSync () {
    this.updateScheduled = false
    if (this.nextUpdatePromise) {
      this.resolveNextUpdatePromise()
      this.nextUpdatePromise = null
      this.resolveNextUpdatePromise = null
    }

    this.horizontalPositionsToMeasure.clear()
    if (this.contentWidthOrHeightChanged) this.measureClientDimensions()
    if (this.pendingAutoscroll) this.initiateAutoscroll()
    this.populateVisibleRowRange()
    const longestLineToMeasure = this.checkForNewLongestLine()
    this.queryDecorationsToRender()

    etch.updateSync(this)

    this.measureHorizontalPositions()
    if (longestLineToMeasure) this.measureLongestLineWidth(longestLineToMeasure)
    if (this.pendingAutoscroll) this.finalizeAutoscroll()
    this.updateAbsolutePositionedDecorations()

    etch.updateSync(this)

    this.currentFrameLineNumberGutterProps = null
  }

  render () {
    const model = this.getModel()

    let style
    if (!model.getAutoHeight() && !model.getAutoWidth()) {
      style = {contain: 'strict'}
    }

    let className = 'editor'
    if (this.focused) {
      className += ' is-focused'
    }

    return $('atom-text-editor', {
        className,
        style,
        tabIndex: -1,
        on: {focus: this.didFocus}
      },
      $.div(
        {
          ref: 'scroller',
          className: 'scroll-view',
          on: {scroll: this.didScroll},
          style: {
            position: 'absolute',
            contain: 'strict',
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            overflowX: model.isSoftWrapped() ? 'hidden' : 'auto',
            overflowY: 'auto',
            backgroundColor: 'inherit'
          }
        },
        $.div(
          {
            style: {
              isolate: 'content',
              width: 'max-content',
              height: 'max-content',
              backgroundColor: 'inherit'
            }
          },
          this.renderGutterContainer(),
          this.renderContent()
        )
      )
    )
  }

  renderGutterContainer () {
    const props = {ref: 'gutterContainer', className: 'gutter-container'}

    if (this.measurements) {
      props.style = {
        position: 'relative',
        willChange: 'transform',
        transform: `translateX(${this.measurements.scrollLeft}px)`,
        zIndex: 1
      }
    }

    return $.div(props, this.renderLineNumberGutter())
  }

  renderLineNumberGutter () {
    if (this.currentFrameLineNumberGutterProps) {
      return $(LineNumberGutterComponent, this.currentFrameLineNumberGutterProps)
    }

    const model = this.getModel()
    const maxLineNumberDigits = Math.max(2, model.getLineCount().toString().length)

    if (this.measurements) {
      const startRow = this.getRenderedStartRow()
      const endRow = this.getRenderedEndRow()
      const renderedRowCount = endRow - startRow
      const bufferRows = new Array(renderedRowCount)
      const foldableFlags = new Array(renderedRowCount)
      const softWrappedFlags = new Array(renderedRowCount)
      const lineNumberDecorations = new Array(renderedRowCount)

      let previousBufferRow = (startRow > 0) ? model.bufferRowForScreenRow(startRow - 1) : -1
      for (let row = startRow; row < endRow; row++) {
        const i = row - startRow
        const bufferRow = model.bufferRowForScreenRow(row)
        bufferRows[i] = bufferRow
        softWrappedFlags[i] = bufferRow === previousBufferRow
        foldableFlags[i] = model.isFoldableAtBufferRow(bufferRow)
        lineNumberDecorations[i] = this.decorationsToRender.lineNumbers.get(row)
        previousBufferRow = bufferRow
      }

      const rowsPerTile = this.getRowsPerTile()

      this.currentFrameLineNumberGutterProps = {
        ref: 'lineNumberGutter',
        parentComponent: this,
        height: this.getScrollHeight(),
        width: this.measurements.lineNumberGutterWidth,
        lineHeight: this.measurements.lineHeight,
        startRow, endRow, rowsPerTile, maxLineNumberDigits,
        bufferRows, lineNumberDecorations, softWrappedFlags,
        foldableFlags
      }

      return $(LineNumberGutterComponent, this.currentFrameLineNumberGutterProps)
    } else {
      return $.div(
        {
          ref: 'lineNumberGutter',
          className: 'gutter line-numbers',
          'gutter-name': 'line-number'
        },
        $.div({className: 'line-number'},
          '0'.repeat(maxLineNumberDigits),
          $.div({className: 'icon-right'})
        )
      )
    }
  }

  renderContent () {
    let children
    let style = {
      contain: 'strict',
      overflow: 'hidden'
    }
    if (this.measurements) {
      const contentWidth = this.getContentWidth()
      const scrollHeight = this.getScrollHeight()
      if (contentWidth !== this.previousScrollWidth || scrollHeight !== this.previousScrollHeight) {
        this.contentWidthOrHeightChanged = true
        this.previousScrollWidth = contentWidth
        this.previousScrollHeight = scrollHeight
      }

      const width = contentWidth + 'px'
      const height = scrollHeight + 'px'
      style.width = width
      style.height = height
      children = [
        this.renderCursorsAndInput(width, height),
        this.renderLineTiles(width, height)
      ]
    } else {
      children = $.div({ref: 'characterMeasurementLine', className: 'line'},
        $.span({ref: 'normalWidthCharacterSpan'}, NORMAL_WIDTH_CHARACTER),
        $.span({ref: 'doubleWidthCharacterSpan'}, DOUBLE_WIDTH_CHARACTER),
        $.span({ref: 'halfWidthCharacterSpan'}, HALF_WIDTH_CHARACTER),
        $.span({ref: 'koreanCharacterSpan'}, KOREAN_CHARACTER)
      )
    }

    return $.div({ref: 'content', style}, children)
  }

  renderLineTiles (width, height) {
    if (!this.measurements) return []

    const {lineNodesByScreenLineId, textNodesByScreenLineId} = this

    const startRow = this.getRenderedStartRow()
    const endRow = this.getRenderedEndRow()
    const rowsPerTile = this.getRowsPerTile()
    const tileHeight = this.measurements.lineHeight * rowsPerTile
    const tileWidth = this.getContentWidth()

    const displayLayer = this.getModel().displayLayer
    const screenLines = displayLayer.getScreenLines(startRow, endRow)

    const tileNodes = new Array(this.getRenderedTileCount())

    for (let tileStartRow = startRow; tileStartRow < endRow; tileStartRow += rowsPerTile) {
      const tileEndRow = Math.min(endRow, tileStartRow + rowsPerTile)
      const tileIndex = this.tileIndexForTileStartRow(tileStartRow)

      const lineDecorations = new Array(tileEndRow - tileStartRow)
      for (let row = tileStartRow; row < tileEndRow; row++) {
        lineDecorations[row - tileStartRow] = this.decorationsToRender.lines.get(row)
      }
      const highlightDecorations = this.decorationsToRender.highlights.get(tileStartRow)

      tileNodes[tileIndex] = $(LinesTileComponent, {
        key: tileIndex,
        height: tileHeight,
        width: tileWidth,
        top: this.topPixelPositionForRow(tileStartRow),
        lineHeight: this.measurements.lineHeight,
        screenLines: screenLines.slice(tileStartRow - startRow, tileEndRow - startRow),
        lineDecorations,
        highlightDecorations,
        displayLayer,
        lineNodesByScreenLineId,
        textNodesByScreenLineId
      })
    }

    if (this.longestLineToMeasure != null && (this.longestLineToMeasureRow < startRow || this.longestLineToMeasureRow >= endRow)) {
      tileNodes.push($(LineComponent, {
        key: this.longestLineToMeasure.id,
        screenLine: this.longestLineToMeasure,
        displayLayer,
        lineNodesByScreenLineId,
        textNodesByScreenLineId
      }))
    }

    return $.div({
      key: 'lineTiles',
      className: 'lines',
      style: {
        position: 'absolute',
        contain: 'strict',
        width, height
      }
    }, tileNodes)
  }

  renderCursorsAndInput (width, height) {
    const cursorHeight = this.measurements.lineHeight + 'px'

    const children = [this.renderHiddenInput()]

    for (let i = 0; i < this.decorationsToRender.cursors.length; i++) {
      const {pixelLeft, pixelTop, pixelWidth} = this.decorationsToRender.cursors[i]
      children.push($.div({
        className: 'cursor',
        style: {
          height: cursorHeight,
          width: pixelWidth + 'px',
          transform: `translate(${pixelLeft}px, ${pixelTop}px)`
        }
      }))
    }

    return $.div({
      key: 'cursors',
      className: 'cursors',
      style: {
        position: 'absolute',
        contain: 'strict',
        width, height
      }
    }, children)
  }

  renderHiddenInput () {
    let top, left
    if (this.hiddenInputPosition) {
      top = this.hiddenInputPosition.pixelTop
      left = this.hiddenInputPosition.pixelLeft
    } else {
      top = 0
      left = 0
    }

    return $.input({
      ref: 'hiddenInput',
      key: 'hiddenInput',
      className: 'hidden-input',
      on: {
        blur: this.didBlurHiddenInput,
        focus: this.didFocusHiddenInput,
        textInput: this.didTextInput,
        keydown: this.didKeydown,
        keyup: this.didKeyup,
        keypress: this.didKeypress
      },
      tabIndex: -1,
      style: {
        position: 'absolute',
        width: '1px',
        height: this.measurements.lineHeight + 'px',
        top: top + 'px',
        left: left + 'px',
        opacity: 0,
        padding: 0,
        border: 0
      }
    })
  }

  queryDecorationsToRender () {
    this.decorationsToRender.lineNumbers.clear()
    this.decorationsToRender.lines.clear()
    this.decorationsToMeasure.highlights.clear()
    this.decorationsToMeasure.cursors.length = 0

    const decorationsByMarker =
      this.getModel().decorationManager.decorationPropertiesByMarkerForScreenRowRange(
        this.getRenderedStartRow(),
        this.getRenderedEndRow()
      )

    decorationsByMarker.forEach((decorations, marker) => {
      const screenRange = marker.getScreenRange()
      const reversed = marker.isReversed()
      for (let i = 0, length = decorations.length; i < decorations.length; i++) {
        const decoration = decorations[i]
        this.addDecorationToRender(decoration.type, decoration, marker, screenRange, reversed)
      }
    })
  }

  addDecorationToRender (type, decoration, marker, screenRange, reversed) {
    if (Array.isArray(type)) {
      for (let i = 0, length = type.length; i < length; i++) {
        this.addDecorationToRender(type[i], decoration, marker, screenRange, reversed)
      }
    } else {
      switch (type) {
        case 'line':
        case 'line-number':
          this.addLineDecorationToRender(type, decoration, screenRange, reversed)
          break
        case 'highlight':
          this.addHighlightDecorationToMeasure(decoration, screenRange)
          break
        case 'cursor':
          this.addCursorDecorationToMeasure(marker, screenRange)
          break
      }
    }
  }

  addLineDecorationToRender (type, decoration, screenRange, reversed) {
    const decorationsByRow = (type === 'line') ? this.decorationsToRender.lines : this.decorationsToRender.lineNumbers

    let omitLastRow = false
    if (screenRange.isEmpty()) {
      if (decoration.onlyNonEmpty) return
    } else {
      if (decoration.onlyEmpty) return
      if (decoration.omitEmptyLastRow !== false) {
        omitLastRow = screenRange.end.column === 0
      }
    }

    let startRow = screenRange.start.row
    let endRow = screenRange.end.row

    if (decoration.onlyHead) {
      if (reversed) {
        endRow = startRow
      } else {
        startRow = endRow
      }
    }

    startRow = Math.max(startRow, this.getRenderedStartRow())
    endRow = Math.min(endRow, this.getRenderedEndRow() - 1)

    for (let row = startRow; row <= endRow; row++) {
      if (omitLastRow && row === screenRange.end.row) break
      const currentClassName = decorationsByRow.get(row)
      const newClassName = currentClassName ? currentClassName + ' ' + decoration.class : decoration.class
      decorationsByRow.set(row, newClassName)
    }
  }

  addHighlightDecorationToMeasure(decoration, screenRange) {
    screenRange = constrainRangeToRows(screenRange, this.getRenderedStartRow(), this.getRenderedEndRow())
    if (screenRange.isEmpty()) return
    let tileStartRow = this.tileStartRowForRow(screenRange.start.row)
    const rowsPerTile = this.getRowsPerTile()

    while (tileStartRow <= screenRange.end.row) {
      const tileEndRow = tileStartRow + rowsPerTile
      const screenRangeInTile = constrainRangeToRows(screenRange, tileStartRow, tileEndRow)

      let tileHighlights = this.decorationsToMeasure.highlights.get(tileStartRow)
      if (!tileHighlights) {
        tileHighlights = []
        this.decorationsToMeasure.highlights.set(tileStartRow, tileHighlights)
      }
      tileHighlights.push({decoration, screenRange: screenRangeInTile})

      this.requestHorizontalMeasurement(screenRangeInTile.start.row, screenRangeInTile.start.column)
      this.requestHorizontalMeasurement(screenRangeInTile.end.row, screenRangeInTile.end.column)

      tileStartRow += rowsPerTile
    }
  }

  addCursorDecorationToMeasure (marker, screenRange, reversed) {
    const model = this.getModel()
    const isLastCursor = model.getLastCursor().getMarker() === marker
    const screenPosition = reversed ? screenRange.start : screenRange.end
    const {row, column} = screenPosition

    if (row < this.getRenderedStartRow() || row >= this.getRenderedEndRow()) return

    this.requestHorizontalMeasurement(row, column)
    let columnWidth = 0
    if (model.lineLengthForScreenRow(row) > column) {
      columnWidth = 1
      this.requestHorizontalMeasurement(row, column + 1)
    }
    this.decorationsToMeasure.cursors.push({screenPosition, columnWidth, isLastCursor})
  }

  updateAbsolutePositionedDecorations () {
    this.updateHighlightsToRender()
    this.updateCursorsToRender()
  }

  updateHighlightsToRender () {
    this.decorationsToRender.highlights.clear()
    this.decorationsToMeasure.highlights.forEach((highlights, tileRow) => {
      for (let i = 0, length = highlights.length; i < length; i++) {
        const highlight = highlights[i]
        const {start, end} = highlight.screenRange
        highlight.startPixelTop = this.pixelTopForScreenRow(start.row)
        highlight.startPixelLeft = this.pixelLeftForScreenRowAndColumn(start.row, start.column)
        highlight.endPixelTop = this.pixelTopForScreenRow(end.row + 1)
        highlight.endPixelLeft = this.pixelLeftForScreenRowAndColumn(end.row, end.column)
      }
      this.decorationsToRender.highlights.set(tileRow, highlights)
    })
  }

  updateCursorsToRender () {
    this.decorationsToRender.cursors.length = 0

    const height = this.measurements.lineHeight + 'px'
    for (let i = 0; i < this.decorationsToMeasure.cursors.length; i++) {
      const cursor = this.decorationsToMeasure.cursors[i]
      const {row, column} = cursor.screenPosition

      const pixelTop = this.pixelTopForScreenRow(row)
      const pixelLeft = this.pixelLeftForScreenRowAndColumn(row, column)
      const pixelRight = (cursor.columnWidth === 0)
        ? pixelLeft
        : this.pixelLeftForScreenRowAndColumn(row, column + 1)
      const pixelWidth = pixelRight - pixelLeft

      const cursorPosition = {pixelTop, pixelLeft, pixelWidth}
      this.decorationsToRender.cursors[i] = cursorPosition
      if (cursor.isLastCursor) this.hiddenInputPosition = cursorPosition
    }
  }

  didAttach () {
    if (!this.attached) {
      this.attached = true
      this.intersectionObserver = new IntersectionObserver((entries) => {
        const {intersectionRect} = entries[entries.length - 1]
        if (intersectionRect.width > 0 || intersectionRect.height > 0) {
          this.didShow()
        } else {
          this.didHide()
        }
      })
      this.intersectionObserver.observe(this.element)
      if (this.isVisible()) this.didShow()
    }
  }

  didShow () {
    if (!this.visible) {
      this.visible = true
      if (!this.measurements) this.performInitialMeasurements()
      this.getModel().setVisible(true)
      this.updateSync()
    }
  }

  didHide () {
    if (this.visible) {
      this.visible = false
      this.getModel().setVisible(false)
    }
  }

  didFocus () {
    // This element can be focused from a parent custom element's
    // attachedCallback before *its* attachedCallback is fired. This protects
    // against that case.
    if (!this.attached) this.didAttach()

    if (!this.focused) {
      this.focused = true
      this.scheduleUpdate()
    }

    // Transfer focus to the hidden input, but first ensure the input is in the
    // visible part of the scrolled content to avoid the browser trying to
    // auto-scroll to the form-field.
    const {hiddenInput} = this.refs
    hiddenInput.style.top = this.getScrollTop() + 'px'
    hiddenInput.style.left = this.getScrollLeft() + 'px'

    hiddenInput.focus()

    // Restore the previous position of the field now that it is already focused
    // and won't cause unwanted scrolling.
    if (this.hiddenInputPosition) {
      hiddenInput.style.top = this.hiddenInputPosition.pixelTop + 'px'
      hiddenInput.style.left = this.hiddenInputPosition.pixelLeft + 'px'
    } else {
      hiddenInput.style.top = 0
      hiddenInput.style.left = 0
    }
  }

  didBlurHiddenInput (event) {
    if (this.element !== event.relatedTarget && !this.element.contains(event.relatedTarget)) {
      this.focused = false
      this.scheduleUpdate()
    }
  }

  didFocusHiddenInput () {
    if (!this.focused) {
      this.focused = true
      this.scheduleUpdate()
    }
  }

  didScroll () {
    if (this.measureScrollPosition(true)) {
      this.updateSync()
    }
  }

  didResize () {
    if (this.measureEditorDimensions()) {
      this.measureClientDimensions()
      this.scheduleUpdate()
    }
  }

  didTextInput (event) {
    event.stopPropagation()

    // WARNING: If we call preventDefault on the input of a space character,
    // then the browser interprets the spacebar keypress as a page-down command,
    // causing spaces to scroll elements containing editors. This is impossible
    // to test.
    if (event.data !== ' ') event.preventDefault()

    // if (!this.isInputEnabled()) return

    // Workaround of the accented character suggestion feature in macOS. This
    // will only occur when the user is not composing in IME mode. When the user
    // selects a modified character from the macOS menu, `textInput` will occur
    // twice, once for the initial character, and once for the modified
    // character. However, only a single keypress will have fired. If this is
    // the case, select backward to replace the original character.
    if (this.openedAccentedCharacterMenu) {
      this.getModel().selectLeft()
      this.openedAccentedCharacterMenu = false
    }

    this.getModel().insertText(event.data, {groupUndo: true})
  }

  // We need to get clever to detect when the accented character menu is
  // opened on macOS. Usually, every keydown event that could cause input is
  // followed by a corresponding keypress. However, pressing and holding
  // long enough to open the accented character menu causes additional keydown
  // events to fire that aren't followed by their own keypress and textInput
  // events.
  //
  // Therefore, we assume the accented character menu has been deployed if,
  // before observing any keyup event, we observe events in the following
  // sequence:
  //
  // keydown(keyCode: X), keypress, keydown(keyCode: X)
  //
  // The keyCode X must be the same in the keydown events that bracket the
  // keypress, meaning we're *holding* the _same_ key we intially pressed.
  // Got that?
  didKeydown (event) {
    if (this.lastKeydownBeforeKeypress != null) {
      if (this.lastKeydownBeforeKeypress.keyCode === event.keyCode) {
        this.openedAccentedCharacterMenu = true
      }
      this.lastKeydownBeforeKeypress = null
    } else {
      this.lastKeydown = event
    }
  }

  didKeypress () {
    this.lastKeydownBeforeKeypress = this.lastKeydown
    this.lastKeydown = null

    // This cancels the accented character behavior if we type a key normally
    // with the menu open.
    this.openedAccentedCharacterMenu = false
  }

  didKeyup () {
    this.lastKeydownBeforeKeypress = null
    this.lastKeydown = null
  }

  didRequestAutoscroll (autoscroll) {
    this.pendingAutoscroll = autoscroll
    this.scheduleUpdate()
  }

  initiateAutoscroll () {
    const {screenRange, options} = this.pendingAutoscroll

    const screenRangeTop = this.pixelTopForScreenRow(screenRange.start.row)
    const screenRangeBottom = this.pixelTopForScreenRow(screenRange.end.row) + this.measurements.lineHeight
    const verticalScrollMargin = this.getVerticalScrollMargin()

    this.requestHorizontalMeasurement(screenRange.start.row, screenRange.start.column)
    this.requestHorizontalMeasurement(screenRange.end.row, screenRange.end.column)

    let desiredScrollTop, desiredScrollBottom
    if (options && options.center) {
      const desiredScrollCenter = (screenRangeTop + screenRangeBottom) / 2
      if (desiredScrollCenter < this.getScrollTop() || desiredScrollCenter > this.getScrollBottom()) {
        desiredScrollTop = desiredScrollCenter - this.measurements.clientHeight / 2
        desiredScrollBottom = desiredScrollCenter + this.measurements.clientHeight / 2
      }
    } else {
      desiredScrollTop = screenRangeTop - verticalScrollMargin
      desiredScrollBottom = screenRangeBottom + verticalScrollMargin
    }

    if (desiredScrollTop != null) {
      desiredScrollTop = Math.max(0, Math.min(desiredScrollTop, this.getScrollHeight() - this.getClientHeight()))
    }

    if (desiredScrollBottom != null) {
      desiredScrollBottom = Math.max(this.getClientHeight(), Math.min(desiredScrollBottom, this.getScrollHeight()))
    }

    if (!options || options.reversed !== false) {
      if (desiredScrollBottom > this.getScrollBottom()) {
        this.autoscrollTop = desiredScrollBottom - this.measurements.clientHeight
        this.measurements.scrollTop = this.autoscrollTop
      }
      if (desiredScrollTop < this.getScrollTop()) {
        this.autoscrollTop = desiredScrollTop
        this.measurements.scrollTop = this.autoscrollTop
      }
    } else {
      if (desiredScrollTop < this.getScrollTop()) {
        this.autoscrollTop = desiredScrollTop
        this.measurements.scrollTop = this.autoscrollTop
      }
      if (desiredScrollBottom > this.getScrollBottom()) {
        this.autoscrollTop = desiredScrollBottom - this.measurements.clientHeight
        this.measurements.scrollTop = this.autoscrollTop
      }
    }
  }

  finalizeAutoscroll () {
    const horizontalScrollMargin = this.getHorizontalScrollMargin()

    const {screenRange, options} = this.pendingAutoscroll
    const gutterContainerWidth = this.getGutterContainerWidth()
    let left = this.pixelLeftForScreenRowAndColumn(screenRange.start.row, screenRange.start.column) + gutterContainerWidth
    let right = this.pixelLeftForScreenRowAndColumn(screenRange.end.row, screenRange.end.column) + gutterContainerWidth
    const desiredScrollLeft = Math.max(0, left - horizontalScrollMargin - gutterContainerWidth)
    const desiredScrollRight = Math.min(this.getScrollWidth(), right + horizontalScrollMargin)

    let autoscrollLeft
    if (!options || options.reversed !== false) {
      if (desiredScrollRight > this.getScrollRight()) {
        autoscrollLeft = desiredScrollRight - this.getClientWidth()
        this.measurements.scrollLeft = autoscrollLeft
      }
      if (desiredScrollLeft < this.getScrollLeft()) {
        autoscrollLeft = desiredScrollLeft
        this.measurements.scrollLeft = autoscrollLeft
      }
    } else {
      if (desiredScrollLeft < this.getScrollLeft()) {
        autoscrollLeft = desiredScrollLeft
        this.measurements.scrollLeft = autoscrollLeft
      }
      if (desiredScrollRight > this.getScrollRight()) {
        autoscrollLeft = desiredScrollRight - this.getClientWidth()
        this.measurements.scrollLeft = autoscrollLeft
      }
    }

    if (this.autoscrollTop != null) {
      this.refs.scroller.scrollTop = this.autoscrollTop
      this.autoscrollTop = null
    }

    if (autoscrollLeft != null) {
      this.refs.scroller.scrollLeft = autoscrollLeft
    }

    this.pendingAutoscroll = null
  }

  getVerticalScrollMargin () {
    const {clientHeight, lineHeight} = this.measurements
    const marginInLines = Math.min(
      this.getModel().verticalScrollMargin,
      Math.floor(((clientHeight / lineHeight) - 1) / 2)
    )
    return marginInLines * lineHeight
  }

  getHorizontalScrollMargin () {
    const {clientWidth, baseCharacterWidth} = this.measurements
    const contentClientWidth = clientWidth - this.getGutterContainerWidth()
    const marginInBaseCharacters = Math.min(
      this.getModel().horizontalScrollMargin,
      Math.floor(((contentClientWidth / baseCharacterWidth) - 1) / 2)
    )
    return marginInBaseCharacters * baseCharacterWidth
  }

  performInitialMeasurements () {
    this.measurements = {}
    this.measureGutterDimensions()
    this.measureEditorDimensions()
    this.measureClientDimensions()
    this.measureScrollPosition()
    this.measureCharacterDimensions()
  }

  measureEditorDimensions () {
    let dimensionsChanged = false
    const scrollerHeight = this.refs.scroller.offsetHeight
    const scrollerWidth = this.refs.scroller.offsetWidth
    if (scrollerHeight !== this.measurements.scrollerHeight) {
      this.measurements.scrollerHeight = scrollerHeight
      dimensionsChanged = true
    }
    if (scrollerWidth !== this.measurements.scrollerWidth) {
      this.measurements.scrollerWidth = scrollerWidth
      dimensionsChanged = true
    }
    return dimensionsChanged
  }

  measureScrollPosition () {
    let scrollPositionChanged = false
    const {scrollTop, scrollLeft} = this.refs.scroller
    if (scrollTop !== this.measurements.scrollTop) {
      this.measurements.scrollTop = scrollTop
      scrollPositionChanged = true
    }
    if (scrollLeft !== this.measurements.scrollLeft) {
      this.measurements.scrollLeft = scrollLeft
      scrollPositionChanged = true
    }
    return scrollPositionChanged
  }

  measureClientDimensions () {
    let clientDimensionsChanged = false
    const {clientHeight, clientWidth} = this.refs.scroller
    if (clientHeight !== this.measurements.clientHeight) {
      this.measurements.clientHeight = clientHeight
      clientDimensionsChanged = true
    }
    if (clientWidth !== this.measurements.clientWidth) {
      this.measurements.clientWidth = clientWidth
      this.getModel().setWidth(clientWidth - this.getGutterContainerWidth(), true)
      clientDimensionsChanged = true
    }
    this.contentWidthOrHeightChanged = false
    return clientDimensionsChanged
  }

  measureCharacterDimensions () {
    this.measurements.lineHeight = this.refs.characterMeasurementLine.getBoundingClientRect().height
    this.measurements.baseCharacterWidth = this.refs.normalWidthCharacterSpan.getBoundingClientRect().width
    this.measurements.doubleWidthCharacterWidth = this.refs.doubleWidthCharacterSpan.getBoundingClientRect().width
    this.measurements.halfWidthCharacterWidth = this.refs.halfWidthCharacterSpan.getBoundingClientRect().width
    this.measurements.koreanCharacterWidth = this.refs.koreanCharacterSpan.getBoundingClientRect().widt

    this.getModel().setDefaultCharWidth(
      this.measurements.baseCharacterWidth,
      this.measurements.doubleWidthCharacterWidth,
      this.measurements.halfWidthCharacterWidth,
      this.measurements.koreanCharacterWidth
    )
  }

  checkForNewLongestLine () {
    const model = this.getModel()
    const longestLineRow = model.getApproximateLongestScreenRow()
    const longestLine = model.screenLineForScreenRow(longestLineRow)
    if (longestLine !== this.previousLongestLine) {
      this.longestLineToMeasure = longestLine
      this.longestLineToMeasureRow = longestLineRow
      this.previousLongestLine = longestLine
      return longestLine
    }
  }

  measureLongestLineWidth (screenLine) {
    this.measurements.longestLineWidth = this.lineNodesByScreenLineId.get(screenLine.id).firstChild.offsetWidth
    this.longestLineToMeasureRow = null
    this.longestLineToMeasure = null
  }

  measureGutterDimensions () {
    this.measurements.lineNumberGutterWidth = this.refs.lineNumberGutter.offsetWidth
  }

  requestHorizontalMeasurement (row, column) {
    if (column === 0) return
    let columns = this.horizontalPositionsToMeasure.get(row)
    if (columns == null) {
      columns = []
      this.horizontalPositionsToMeasure.set(row, columns)
    }
    columns.push(column)
  }

  measureHorizontalPositions () {
    this.horizontalPositionsToMeasure.forEach((columnsToMeasure, row) => {
      columnsToMeasure.sort((a, b) => a - b)

      const screenLine = this.getModel().displayLayer.getScreenLine(row)
      const lineNode = this.lineNodesByScreenLineId.get(screenLine.id)

      if (!lineNode) {
        const error = new Error('Requested measurement of a line that is not currently rendered')
        error.metadata = {row, columnsToMeasure}
        throw error
      }

      const textNodes = this.textNodesByScreenLineId.get(screenLine.id)
      let positionsForLine = this.horizontalPixelPositionsByScreenLineId.get(screenLine.id)
      if (positionsForLine == null) {
        positionsForLine = new Map()
        this.horizontalPixelPositionsByScreenLineId.set(screenLine.id, positionsForLine)
      }

      this.measureHorizontalPositionsOnLine(lineNode, textNodes, columnsToMeasure, positionsForLine)
    })
  }

  measureHorizontalPositionsOnLine (lineNode, textNodes, columnsToMeasure, positions) {
    let lineNodeClientLeft = -1
    let textNodeStartColumn = 0
    let textNodesIndex = 0

    columnLoop:
    for (let columnsIndex = 0; columnsIndex < columnsToMeasure.length; columnsIndex++) {
      while (textNodesIndex < textNodes.length) {
        const nextColumnToMeasure = columnsToMeasure[columnsIndex]
        if (nextColumnToMeasure === 0) {
          positions.set(0, 0)
          continue columnLoop
        }
        if (nextColumnToMeasure >= lineNode.textContent.length) {

        }
        if (positions.has(nextColumnToMeasure)) continue columnLoop
        const textNode = textNodes[textNodesIndex]
        const textNodeEndColumn = textNodeStartColumn + textNode.textContent.length

        if (nextColumnToMeasure <= textNodeEndColumn) {
          let clientPixelPosition
          if (nextColumnToMeasure === textNodeStartColumn) {
            const range = getRangeForMeasurement()
            range.setStart(textNode, 0)
            range.setEnd(textNode, 1)
            clientPixelPosition = range.getBoundingClientRect().left
          } else {
            const range = getRangeForMeasurement()
            range.setStart(textNode, 0)
            range.setEnd(textNode, nextColumnToMeasure - textNodeStartColumn)
            clientPixelPosition = range.getBoundingClientRect().right
          }
          if (lineNodeClientLeft === -1) lineNodeClientLeft = lineNode.getBoundingClientRect().left
          positions.set(nextColumnToMeasure, clientPixelPosition - lineNodeClientLeft)
          continue columnLoop
        } else {
          textNodesIndex++
          textNodeStartColumn = textNodeEndColumn
        }
      }
    }
  }

  pixelTopForScreenRow (row) {
    return row * this.measurements.lineHeight
  }

  pixelLeftForScreenRowAndColumn (row, column) {
    if (column === 0) return 0
    const screenLine = this.getModel().displayLayer.getScreenLine(row)
    return this.horizontalPixelPositionsByScreenLineId.get(screenLine.id).get(column)
  }

  getModel () {
    if (!this.props.model) {
      const TextEditor = require('./text-editor')
      this.props.model = new TextEditor()
      this.observeModel()
    }
    return this.props.model
  }

  observeModel () {
    const {model} = this.props
    const scheduleUpdate = this.scheduleUpdate.bind(this)
    this.disposables.add(model.selectionsMarkerLayer.onDidUpdate(scheduleUpdate))
    this.disposables.add(model.displayLayer.onDidChangeSync(scheduleUpdate))
    this.disposables.add(model.onDidUpdateDecorations(scheduleUpdate))
    this.disposables.add(model.onDidRequestAutoscroll(this.didRequestAutoscroll.bind(this)))
  }

  isVisible () {
    return this.element.offsetWidth > 0 || this.element.offsetHeight > 0
  }

  getBaseCharacterWidth () {
    return this.measurements ? this.measurements.baseCharacterWidth : null
  }

  getScrollTop () {
    if (this.measurements != null) {
      return this.measurements.scrollTop
    }
  }

  getScrollBottom () {
    return this.measurements
      ? this.measurements.scrollTop + this.measurements.clientHeight
      : null
  }

  getScrollLeft () {
    return this.measurements ? this.measurements.scrollLeft : null
  }

  getScrollRight () {
    return this.measurements
      ? this.measurements.scrollLeft + this.measurements.clientWidth
      : null
  }

  getScrollHeight () {
    return this.getModel().getApproximateScreenLineCount() * this.measurements.lineHeight
  }

  getScrollWidth () {
    return this.getContentWidth() + this.getGutterContainerWidth()
  }

  getClientHeight () {
    return this.measurements.clientHeight
  }

  getClientWidth () {
    return this.measurements.clientWidth
  }

  getGutterContainerWidth () {
    return this.measurements.lineNumberGutterWidth
  }

  getContentWidth () {
    if (this.getModel().isSoftWrapped()) {
      return this.getClientWidth() - this.getGutterContainerWidth()
    } else {
      return Math.round(this.measurements.longestLineWidth + this.measurements.baseCharacterWidth)
    }
  }

  getRowsPerTile () {
    return this.props.rowsPerTile || DEFAULT_ROWS_PER_TILE
  }

  tileStartRowForRow (row) {
    return row - (row % this.getRowsPerTile())
  }

  tileIndexForTileStartRow (startRow) {
    return (startRow / this.getRowsPerTile()) % this.getRenderedTileCount()
  }

  getFirstTileStartRow () {
    return this.tileStartRowForRow(this.getFirstVisibleRow())
  }

  getRenderedStartRow () {
    return this.getFirstTileStartRow()
  }

  getRenderedEndRow () {
    return Math.min(
      this.getModel().getApproximateScreenLineCount(),
      this.getFirstTileStartRow() + this.getVisibleTileCount() * this.getRowsPerTile()
    )
  }

  getRenderedTileCount () {
    return Math.ceil((this.getRenderedEndRow() - this.getRenderedStartRow()) / this.getRowsPerTile())
  }

  getFirstVisibleRow () {
    const scrollTop = this.getScrollTop()
    const lineHeight = this.measurements.lineHeight
    return Math.floor(scrollTop / lineHeight)
  }

  getLastVisibleRow () {
    const {scrollerHeight, lineHeight} = this.measurements
    return Math.min(
      this.getModel().getApproximateScreenLineCount() - 1,
      this.getFirstVisibleRow() + Math.ceil(scrollerHeight / lineHeight)
    )
  }

  getVisibleTileCount () {
    return Math.floor((this.getLastVisibleRow() - this.getFirstVisibleRow()) / this.getRowsPerTile()) + 2
  }

  // Ensure the spatial index is populated with rows that are currently
  // visible so we *at least* get the longest row in the visible range.
  populateVisibleRowRange () {
    const endRow = this.getFirstTileStartRow() + this.getVisibleTileCount() * this.getRowsPerTile()
    this.getModel().displayLayer.populateSpatialIndexIfNeeded(Infinity, endRow)
  }

  topPixelPositionForRow (row) {
    return row * this.measurements.lineHeight
  }

  getNextUpdatePromise () {
    if (!this.nextUpdatePromise) {
      this.nextUpdatePromise = new Promise((resolve) => {
        this.resolveNextUpdatePromise = resolve
      })
    }
    return this.nextUpdatePromise
  }
}

class LineNumberGutterComponent {
  constructor (props) {
    this.props = props
    etch.initialize(this)
  }

  update (newProps) {
    if (this.shouldUpdate(newProps)) {
      this.props = newProps
      etch.updateSync(this)
    }
  }

  render () {
    const {
      parentComponent, height, width, lineHeight, startRow, endRow, rowsPerTile,
      maxLineNumberDigits, bufferRows, softWrappedFlags, foldableFlags,
      lineNumberDecorations
    } = this.props

    const renderedTileCount = parentComponent.getRenderedTileCount()
    const children = new Array(renderedTileCount)
    const tileHeight = rowsPerTile * lineHeight + 'px'
    const tileWidth = width + 'px'

    let softWrapCount = 0
    for (let tileStartRow = startRow; tileStartRow < endRow; tileStartRow += rowsPerTile) {
      const tileEndRow = Math.min(endRow, tileStartRow + rowsPerTile)
      const tileChildren = new Array(tileEndRow - tileStartRow)
      for (let row = tileStartRow; row < tileEndRow; row++) {
        const i = row - startRow
        const bufferRow = bufferRows[i]
        const softWrapped = softWrappedFlags[i]
        const foldable = foldableFlags[i]
        let key, lineNumber
        let className = 'line-number'
        if (softWrapped) {
          softWrapCount++
          key = `${bufferRow}-${softWrapCount}`
          lineNumber = '•'
        } else {
          softWrapCount = 0
          key = bufferRow
          lineNumber = (bufferRow + 1).toString()
          if (foldable) className += ' foldable'
        }

        const lineNumberDecoration = lineNumberDecorations[i]
        if (lineNumberDecoration != null) className += ' ' + lineNumberDecoration

        lineNumber = NBSP_CHARACTER.repeat(maxLineNumberDigits - lineNumber.length) + lineNumber

        tileChildren[row - tileStartRow] = $.div({key, className},
          lineNumber,
          $.div({className: 'icon-right'})
        )
      }

      const tileIndex = parentComponent.tileIndexForTileStartRow(tileStartRow)
      const top = tileStartRow * lineHeight

      children[tileIndex] = $.div({
        key: tileIndex,
        style: {
          contain: 'strict',
          overflow: 'hidden',
          position: 'absolute',
          height: tileHeight,
          width: tileWidth,
          willChange: 'transform',
          transform: `translateY(${top}px)`,
          backgroundColor: 'inherit'
        }
      }, ...tileChildren)
    }

    return $.div(
      {
        className: 'gutter line-numbers',
        'gutter-name': 'line-number',
        style: {
          contain: 'strict',
          overflow: 'hidden',
          height: height + 'px',
          width: tileWidth
        }
      },
      ...children
    )
  }

  shouldUpdate (newProps) {
    const oldProps = this.props

    if (oldProps.height !== newProps.height) return true
    if (oldProps.width !== newProps.width) return true
    if (oldProps.lineHeight !== newProps.lineHeight) return true
    if (oldProps.startRow !== newProps.startRow) return true
    if (oldProps.endRow !== newProps.endRow) return true
    if (oldProps.rowsPerTile !== newProps.rowsPerTile) return true
    if (oldProps.maxLineNumberDigits !== newProps.maxLineNumberDigits) return true
    if (!arraysEqual(oldProps.bufferRows, newProps.bufferRows)) return true
    if (!arraysEqual(oldProps.softWrappedFlags, newProps.softWrappedFlags)) return true
    if (!arraysEqual(oldProps.foldableFlags, newProps.foldableFlags)) return true
    if (!arraysEqual(oldProps.lineNumberDecorations, newProps.lineNumberDecorations)) return true
    return false
  }
}

class LinesTileComponent {
  constructor (props) {
    this.props = props
    etch.initialize(this)
  }

  update (newProps) {
    if (this.shouldUpdate(newProps)) {
      this.props = newProps
      etch.updateSync(this)
    }
  }

  render () {
    const {height, width, top} = this.props

    return $.div(
      {
        style: {
          contain: 'strict',
          position: 'absolute',
          height: height + 'px',
          width: width + 'px',
          willChange: 'transform',
          transform: `translateY(${top}px)`,
          backgroundColor: 'inherit'
        }
      },
      this.renderHighlights(),
      this.renderLines()
    )

  }

  renderHighlights () {
    const {top, height, width, lineHeight, highlightDecorations} = this.props

    let children = null
    if (highlightDecorations) {
      const decorationCount = highlightDecorations.length
      children = new Array(decorationCount)
      for (let i = 0; i < decorationCount; i++) {
        const highlightProps = Object.assign(
          {parentTileTop: top, lineHeight},
          highlightDecorations[i]
        )
        children[i] = $(HighlightComponent, highlightProps)
      }
    }

    return $.div(
      {
        style: {
          position: 'absolute',
          contain: 'strict',
          height: height + 'px',
          width: width + 'px'
        },
      },  children
    )
  }

  renderLines () {
    const {
      height, width, top,
      screenLines, lineDecorations, displayLayer,
      lineNodesByScreenLineId, textNodesByScreenLineId,
    } = this.props

    const children = new Array(screenLines.length)
    for (let i = 0, length = screenLines.length; i < length; i++) {
      const screenLine = screenLines[i]
      if (!screenLine) {
        children.length = i
        break
      }
      children[i] = $(LineComponent, {
        key: screenLine.id,
        screenLine,
        lineDecoration: lineDecorations[i],
        displayLayer,
        lineNodesByScreenLineId,
        textNodesByScreenLineId
      })
    }

    return $.div({
      style: {
        position: 'absolute',
        contain: 'strict',
        height: height + 'px',
        width: width + 'px',
      }
    }, children)
  }

  shouldUpdate (newProps) {
    const oldProps = this.props
    if (oldProps.top !== newProps.top) return true
    if (oldProps.height !== newProps.height) return true
    if (oldProps.width !== newProps.width) return true
    if (!arraysEqual(oldProps.screenLines, newProps.screenLines)) return true
    if (!arraysEqual(oldProps.lineDecorations, newProps.lineDecorations)) return true

    if (!oldProps.highlightDecorations && newProps.highlightDecorations) return true
    if (oldProps.highlightDecorations && !newProps.highlightDecorations) return true

    if (oldProps.highlightDecorations && newProps.highlightDecorations) {
      if (oldProps.highlightDecorations.length !== newProps.highlightDecorations.length) return true

      for (let i = 0, length = oldProps.highlightDecorations.length; i < length; i++) {
        const oldHighlight = oldProps.highlightDecorations[i]
        const newHighlight = newProps.highlightDecorations[i]
        if (oldHighlight.decoration.class !== newHighlight.decoration.class) return true
        if (oldHighlight.startPixelLeft !== newHighlight.startPixelLeft) return true
        if (oldHighlight.endPixelLeft !== newHighlight.endPixelLeft) return true
        if (!oldHighlight.screenRange.isEqual(newHighlight.screenRange)) return true
      }
    }

    return false
  }
}

class LineComponent {
  constructor (props) {
    const {displayLayer, screenLine, lineDecoration, lineNodesByScreenLineId, textNodesByScreenLineId} = props
    this.props = props
    this.element = document.createElement('div')
    this.element.className = this.buildClassName()
    lineNodesByScreenLineId.set(screenLine.id, this.element)

    const textNodes = []
    textNodesByScreenLineId.set(screenLine.id, textNodes)

    const {lineText, tagCodes} = screenLine
    let startIndex = 0
    let openScopeNode = document.createElement('span')
    this.element.appendChild(openScopeNode)
    for (let i = 0; i < tagCodes.length; i++) {
      const tagCode = tagCodes[i]
      if (tagCode !== 0) {
        if (displayLayer.isCloseTagCode(tagCode)) {
          openScopeNode = openScopeNode.parentElement
        } else if (displayLayer.isOpenTagCode(tagCode)) {
          const scope = displayLayer.tagForCode(tagCode)
          const newScopeNode = document.createElement('span')
          newScopeNode.className = classNameForScopeName(scope)
          openScopeNode.appendChild(newScopeNode)
          openScopeNode = newScopeNode
        } else {
          const textNode = document.createTextNode(lineText.substr(startIndex, tagCode))
          startIndex += tagCode
          openScopeNode.appendChild(textNode)
          textNodes.push(textNode)
        }
      }
    }

    if (startIndex === 0) {
      const textNode = document.createTextNode(' ')
      this.element.appendChild(textNode)
      textNodes.push(textNode)
    }

    if (lineText.endsWith(displayLayer.foldCharacter)) {
      // Insert a zero-width non-breaking whitespace, so that LinesYardstick can
      // take the fold-marker::after pseudo-element into account during
      // measurements when such marker is the last character on the line.
      const textNode = document.createTextNode(ZERO_WIDTH_NBSP)
      this.element.appendChild(textNode)
      textNodes.push(textNode)
    }
  }

  update (newProps) {
    if (this.props.lineDecoration !== newProps.lineDecoration) {
      this.props = newProps
      this.element.className = this.buildClassName()
    }
  }

  destroy () {
    const {lineNodesByScreenLineId, textNodesByScreenLineId, screenLine} = this.props
    if (lineNodesByScreenLineId.get(screenLine.id) === this.element) {
      lineNodesByScreenLineId.delete(screenLine.id)
      textNodesByScreenLineId.delete(screenLine.id)
    }
  }

  buildClassName () {
    const {lineDecoration} = this.props
    let className = 'line'
    if (lineDecoration != null) className += ' ' + lineDecoration
    return className
  }
}

class HighlightComponent {
  constructor (props) {
    this.props = props
    etch.initialize(this)
  }

  update (props) {
    this.props = props
    etch.updateSync(this)
  }

  render () {
    let {startPixelTop, endPixelTop} = this.props
    const {
      decoration, screenRange, parentTileTop, lineHeight,
      startPixelLeft, endPixelLeft,
    } = this.props
    startPixelTop -= parentTileTop
    endPixelTop -= parentTileTop

    let children
    if (screenRange.start.row === screenRange.end.row) {
      children = $.div({
        className: 'region',
        style: {
          position: 'absolute',
          boxSizing: 'border-box',
          top: startPixelTop + 'px',
          left: startPixelLeft + 'px',
          width: endPixelLeft - startPixelLeft + 'px',
          height: lineHeight + 'px'
        }
      })
    } else {
      children = []
      children.push($.div({
        className: 'region',
        style: {
          position: 'absolute',
          boxSizing: 'border-box',
          top: startPixelTop + 'px',
          left: startPixelLeft + 'px',
          right: 0,
          height: lineHeight + 'px'
        }
      }))

      if (screenRange.end.row - screenRange.start.row > 1) {
        children.push($.div({
          className: 'region',
          style: {
            position: 'absolute',
            boxSizing: 'border-box',
            top: startPixelTop + lineHeight + 'px',
            left: 0,
            right: 0,
            height: endPixelTop - startPixelTop - (lineHeight * 2) + 'px'
          }
        }))
      }

      if (endPixelLeft > 0) {
        children.push($.div({
          className: 'region',
          style: {
            position: 'absolute',
            boxSizing: 'border-box',
            top: endPixelTop - lineHeight + 'px',
            left: 0,
            width: endPixelLeft + 'px',
            height: lineHeight + 'px'
          }
        }))
      }
    }

    const className = 'highlight ' + decoration.class
    return $.div({className}, children)
  }
}

const classNamesByScopeName = new Map()
function classNameForScopeName (scopeName) {
  let classString = classNamesByScopeName.get(scopeName)
  if (classString == null) {
    classString = scopeName.replace(/\.+/g, ' ')
    classNamesByScopeName.set(scopeName, classString)
  }
  return classString
}

let rangeForMeasurement
function getRangeForMeasurement () {
  if (!rangeForMeasurement) rangeForMeasurement = document.createRange()
  return rangeForMeasurement
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0, length = a.length; i < length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function constrainRangeToRows (range, startRow, endRow) {
  if (range.start.row < startRow || range.end.row >= endRow) {
    range = range.copy()
    if (range.start.row < startRow) {
      range.start.row = startRow
      range.start.column = 0
    }
    if (range.end.row >= endRow) {
      range.end.row = endRow
      range.end.column = 0
    }
  }
  return range
}
