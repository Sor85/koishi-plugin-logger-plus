import test from 'node:test'
import assert from 'node:assert/strict'
import { vOverlayScrollbar } from '../client/overlay-scrollbar'
import type { ScrollbarSource } from '../client/scrollbar-geometry'

class ElementStub extends EventTarget {
  children: ElementStub[] = []
  dataset: Record<string, string> = {}
  style = { setProperty(name: string, value: string) { this[name] = value } } as Record<string, any>
  className = ''
  classList = { add() {}, remove() {}, toggle() {} }
  scrollTop = 8000
  scrollHeight = 10000
  clientHeight = 800
  isConnected = true
  removed = false
  appendChild(child: ElementStub) { this.children.push(child) }
  remove() { this.removed = true }
  getBoundingClientRect() { return { right: 600, top: 0, width: 600, height: 800 } }
}

class PointerStub extends Event {
  constructor(type: string, public clientY: number) { super(type, { cancelable: true }) }
}

test('自绘滑块使用虚拟数据源，拖动期间不受 DOM 高度与实测结果干扰，卸载释放订阅', t => {
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  const body = new ElementStub()
  const document = Object.assign(new EventTarget(), { body, createElement: () => new ElementStub() })
  const window = Object.assign(new EventTarget(), {
    requestAnimationFrame(task: FrameRequestCallback) { frames.set(++frameId, task); return frameId },
    cancelAnimationFrame(id: number) { frames.delete(id) },
    setTimeout: () => 1,
    clearTimeout() {},
  })
  const globals = { window, document, PointerEvent: PointerStub }
  for (const [key, value] of Object.entries(globals)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { configurable: true, value })
    t.after(() => {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    })
  }
  function frame() {
    const tasks = [...frames.values()]
    frames.clear()
    for (const task of tasks) task(0)
  }

  let metrics = { offset: 50, viewport: 10, total: 100, thumbRatio: 0.1 }
  let notify: (() => void) | undefined
  let unsubscribed = false
  const targets: number[] = []
  const source: ScrollbarSource = {
    metrics: () => metrics,
    subscribe(listener) { notify = listener; return () => { unsubscribed = true } },
    scrollTo(progress) { targets.push(progress) },
  }
  const element = new ElementStub()
  const dom = element as unknown as HTMLElement
  vOverlayScrollbar.mounted(dom, { value: { source } })
  frame()
  const overlay = body.children[0]
  const thumb = overlay.children[0]
  const top = Number.parseFloat(overlay.style['--overlay-scrollbar-thumb-top'])
  assert.ok(Math.abs(top - 392) < 1e-6)

  // 正文锚点补偿改变原生 scrollTop/scrollHeight，但阅读记录不变，滑块不能挪动。
  element.scrollTop += 1680
  element.scrollHeight += 1680
  element.dispatchEvent(new Event('scroll'))
  frame()
  assert.equal(Number.parseFloat(overlay.style['--overlay-scrollbar-thumb-top']), top)

  thumb.dispatchEvent(new PointerStub('pointerdown', 400))
  document.dispatchEvent(new PointerStub('pointermove', 300))
  frame()
  const draggedTop = Number.parseFloat(overlay.style['--overlay-scrollbar-thumb-top'])
  const draggedHeight = overlay.style['--overlay-scrollbar-thumb-height']
  assert.ok(Math.abs(draggedTop - (top - 100)) < 1e-6)
  assert.equal(targets.length, 1)

  metrics = { offset: 5, viewport: 0.5, total: 100, thumbRatio: 0.1 }
  notify!()
  frame()
  assert.equal(Number.parseFloat(overlay.style['--overlay-scrollbar-thumb-top']), draggedTop)
  assert.equal(overlay.style['--overlay-scrollbar-thumb-height'], draggedHeight)
  document.dispatchEvent(new PointerStub('pointermove', 200))
  frame()
  assert.ok(targets[1] < targets[0])
  assert.ok(Math.abs(Number.parseFloat(overlay.style['--overlay-scrollbar-thumb-top']) - (top - 200)) < 1e-6)
  document.dispatchEvent(new PointerStub('pointerup', 200))
  frame()
  assert.equal(overlay.style['--overlay-scrollbar-thumb-height'], draggedHeight, '松手后不能突然缩短')
  metrics = { offset: 20, viewport: 20, total: 100, thumbRatio: 0.1 }
  notify!()
  frame()
  assert.equal(overlay.style['--overlay-scrollbar-thumb-height'], draggedHeight, '切换到短日志区不能突然变长')

  vOverlayScrollbar.unmounted(dom)
  assert.equal(unsubscribed, true)
  assert.equal(overlay.removed, true)
  assert.equal(frames.size, 0)

  // 非日志容器仍沿用像素滚动，不受记录坐标适配影响。
  vOverlayScrollbar.mounted(dom, {})
  frame()
  const nativeOverlay = body.children[1]
  const height = Number.parseFloat(nativeOverlay.style['--overlay-scrollbar-thumb-height'])
  const expectedTop = element.scrollTop / (element.scrollHeight - element.clientHeight) * (784 - height)
  assert.ok(Math.abs(Number.parseFloat(nativeOverlay.style['--overlay-scrollbar-thumb-top']) - expectedTop) < 1e-6)
  vOverlayScrollbar.unmounted(dom)
  assert.equal(nativeOverlay.removed, true)
  assert.equal(frames.size, 0)
})
