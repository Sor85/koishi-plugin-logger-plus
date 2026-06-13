const edgeGap = 8
const overlayInset = 0
const overlayWidth = 10
const minThumbHeight = 28
const hideDelay = 680

interface OverlayScrollbarState {
  element: HTMLElement
  overlay: HTMLDivElement
  thumb: HTMLDivElement
  resizeObserver?: ResizeObserver
  mutationObserver?: MutationObserver
  frame: number
  hideTimer: number
  hovering: boolean
  focused: boolean
  dragging: boolean
  dragStartY: number
  dragStartScrollTop: number
  trackHeight: number
  thumbHeight: number
  cleanup: Array<() => void>
}

export interface OverlayScrollbarOptions {
  hideOnNarrow?: boolean
}

interface OverlayScrollbarBinding<Value> {
  value?: Value
}

interface OverlayScrollbarDirective<Element, Value> {
  mounted(element: Element, binding: OverlayScrollbarBinding<Value>): void
  updated(element: Element, binding: OverlayScrollbarBinding<Value>): void
  unmounted(element: Element): void
}

const states = new WeakMap<HTMLElement, OverlayScrollbarState>()

function addListener(
  target: EventTarget,
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: AddEventListenerOptions,
) {
  target.addEventListener(type, listener, options)
  return () => target.removeEventListener(type, listener, options)
}

function setVisible(state: OverlayScrollbarState, visible: boolean) {
  state.overlay.classList.toggle('is-visible', visible)
}

function clearHideTimer(state: OverlayScrollbarState) {
  if (!state.hideTimer) return
  window.clearTimeout(state.hideTimer)
  state.hideTimer = 0
}

function stopEvent(event: Event) {
  event.stopPropagation()
}

function scheduleHide(state: OverlayScrollbarState) {
  clearHideTimer(state)
  state.hideTimer = window.setTimeout(() => {
    if (state.hovering || state.focused || state.dragging) return
    setVisible(state, false)
    state.overlay.classList.remove('is-wide')
  }, hideDelay)
}

function updateScrollbar(state: OverlayScrollbarState) {
  state.frame = 0
  const { element, overlay } = state
  const rect = element.getBoundingClientRect()
  const trackHeight = Math.max(0, rect.height - edgeGap * 2)
  const maxScrollTop = element.scrollHeight - element.clientHeight
  const isUsable = element.isConnected && rect.width > 0 && trackHeight > 0 && maxScrollTop > 1

  if (!isUsable) {
    setVisible(state, false)
    overlay.classList.remove('is-wide')
    return
  }

  state.trackHeight = trackHeight
  state.thumbHeight = Math.max(minThumbHeight, trackHeight * element.clientHeight / element.scrollHeight)
  const maxThumbTop = Math.max(0, trackHeight - state.thumbHeight)
  const thumbTop = maxScrollTop ? element.scrollTop / maxScrollTop * maxThumbTop : 0

  overlay.style.left = `${Math.round(rect.right - overlayWidth - overlayInset)}px`
  overlay.style.top = `${Math.round(rect.top + edgeGap)}px`
  overlay.style.height = `${Math.round(trackHeight)}px`
  overlay.style.setProperty('--overlay-scrollbar-thumb-top', `${thumbTop}px`)
  overlay.style.setProperty('--overlay-scrollbar-thumb-height', `${state.thumbHeight}px`)
}

function scheduleUpdate(state: OverlayScrollbarState) {
  if (state.frame) return
  state.frame = window.requestAnimationFrame(() => updateScrollbar(state))
}

function showScrollbar(state: OverlayScrollbarState) {
  clearHideTimer(state)
  scheduleUpdate(state)
  setVisible(state, true)
}

function showScrollbarBriefly(state: OverlayScrollbarState) {
  showScrollbar(state)
  scheduleHide(state)
}

function updateDraggedScrollTop(state: OverlayScrollbarState, clientY: number) {
  const maxScrollTop = state.element.scrollHeight - state.element.clientHeight
  const maxThumbTop = Math.max(1, state.trackHeight - state.thumbHeight)
  const delta = clientY - state.dragStartY
  state.element.scrollTop = state.dragStartScrollTop + delta / maxThumbTop * maxScrollTop
}

function stopDragging(state: OverlayScrollbarState) {
  state.dragging = false
  state.thumb.classList.remove('is-dragging')
  state.overlay.classList.remove('is-wide')
  scheduleHide(state)
}

function createOverlay() {
  const overlay = document.createElement('div')
  overlay.className = 'overlay-scrollbar__overlay'
  const thumb = document.createElement('div')
  thumb.className = 'overlay-scrollbar__thumb'
  overlay.appendChild(thumb)
  // 挂到 body，避免被日志滚动容器裁剪；真实滚动仍由原元素负责。
  document.body.appendChild(overlay)
  return { overlay, thumb }
}

function applyScrollbarOptions(
  state: OverlayScrollbarState,
  binding: OverlayScrollbarBinding<OverlayScrollbarOptions | undefined>,
) {
  const { overlay } = state
  overlay.classList.toggle('is-hidden-on-narrow', Boolean(binding.value?.hideOnNarrow))
}

export const vOverlayScrollbar: OverlayScrollbarDirective<HTMLElement, OverlayScrollbarOptions | undefined> = {
  mounted(element, binding) {
    if (typeof window === 'undefined' || typeof document === 'undefined') return

    const { overlay, thumb } = createOverlay()
    const state: OverlayScrollbarState = {
      element,
      overlay,
      thumb,
      frame: 0,
      hideTimer: 0,
      hovering: false,
      focused: false,
      dragging: false,
      dragStartY: 0,
      dragStartScrollTop: 0,
      trackHeight: 0,
      thumbHeight: 0,
      cleanup: [],
    }

    states.set(element, state)
    element.dataset.overlayScrollbar = 'true'
    applyScrollbarOptions(state, binding)

    const enter = () => {
      state.hovering = true
      showScrollbar(state)
    }
    const leave = () => {
      state.hovering = false
      scheduleHide(state)
    }
    const focusIn = () => {
      state.focused = true
      showScrollbar(state)
    }
    const focusOut = () => {
      state.focused = false
      scheduleHide(state)
    }
    const scroll = () => {
      showScrollbarBriefly(state)
    }
    const update = () => scheduleUpdate(state)
    const pointerDown = (event: Event) => {
      if (!(event instanceof PointerEvent)) return
      event.preventDefault()
      event.stopPropagation()
      state.dragging = true
      state.dragStartY = event.clientY
      state.dragStartScrollTop = element.scrollTop
      thumb.classList.add('is-dragging')
      overlay.classList.add('is-visible', 'is-wide')
      scheduleUpdate(state)
    }
    const pointerMove = (event: Event) => {
      if (!state.dragging) return
      if (!(event instanceof PointerEvent)) return
      event.preventDefault()
      updateDraggedScrollTop(state, event.clientY)
      scheduleUpdate(state)
    }
    const pointerUp = () => {
      if (!state.dragging) return
      stopDragging(state)
    }
    const thumbEnter = () => {
      state.hovering = true
      showScrollbar(state)
      overlay.classList.add('is-wide')
    }
    const thumbLeave = () => {
      state.hovering = false
      if (!state.dragging) overlay.classList.remove('is-wide')
      scheduleHide(state)
    }

    state.cleanup.push(
      addListener(element, 'mouseenter', enter),
      addListener(element, 'mouseleave', leave),
      addListener(element, 'focusin', focusIn),
      addListener(element, 'focusout', focusOut),
      addListener(element, 'scroll', scroll, { passive: true }),
      addListener(window, 'resize', update),
      addListener(window, 'scroll', update, { capture: true, passive: true }),
      addListener(thumb, 'pointerdown', pointerDown),
      addListener(thumb, 'click', stopEvent),
      addListener(thumb, 'mouseenter', thumbEnter),
      addListener(thumb, 'mouseleave', thumbLeave),
      addListener(document, 'pointermove', pointerMove),
      addListener(document, 'pointerup', pointerUp),
      addListener(document, 'pointercancel', pointerUp),
    )

    if (typeof ResizeObserver !== 'undefined') {
      state.resizeObserver = new ResizeObserver(update)
      state.resizeObserver.observe(element)
    }

    if (typeof MutationObserver !== 'undefined') {
      state.mutationObserver = new MutationObserver(update)
      state.mutationObserver.observe(element, { childList: true, subtree: true, characterData: true })
    }

    scheduleUpdate(state)
  },
  updated(element, binding) {
    const state = states.get(element)
    if (!state) return
    applyScrollbarOptions(state, binding)
    scheduleUpdate(state)
  },
  unmounted(element) {
    const state = states.get(element)
    if (!state) return
    states.delete(element)
    delete element.dataset.overlayScrollbar
    clearHideTimer(state)
    if (state.frame) window.cancelAnimationFrame(state.frame)
    state.resizeObserver?.disconnect()
    state.mutationObserver?.disconnect()
    for (const cleanup of state.cleanup) cleanup()
    state.overlay.remove()
  },
}
