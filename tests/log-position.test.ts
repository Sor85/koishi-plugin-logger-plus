import test from 'node:test'
import assert from 'node:assert/strict'
import { capturePausedLogPosition, restorePausedLogPosition } from '../client/log-position'

interface FakeLine {
  dataset: {
    logKey?: string
  }
  offsetTop: number
  offsetHeight: number
  rectTop: number
  rectBottom: number
  getBoundingClientRect(): Pick<DOMRect, 'top' | 'bottom'>
}

class FakeLogList {
  scrollTop = 0
  isConnected = true

  constructor(private lines: FakeLine[], private rectTop = 0) {}

  querySelectorAll() {
    return this.lines
  }

  getBoundingClientRect() {
    return { top: this.rectTop }
  }
}

function line(logKey: string, offsetTop: number, rectTop = offsetTop): FakeLine {
  return {
    dataset: { logKey },
    offsetTop,
    offsetHeight: 20,
    rectTop,
    rectBottom: rectTop + 20,
    getBoundingClientRect() {
      return { top: this.rectTop, bottom: this.rectBottom }
    },
  }
}

test('恢复暂停位置时保持同一条可见日志的视口偏移不变', () => {
  const before = new FakeLogList([
    line('1:1', 0, -65),
    line('2:2', 20, -45),
    line('3:3', 40, -25),
    line('4:4', 60, -5),
  ])
  before.scrollTop = 65

  const position = capturePausedLogPosition(before as unknown as HTMLElement)

  assert.deepEqual(position, { key: '4:4', offset: -5 })

  const after = new FakeLogList([
    line('1:1', 0, -65),
    line('2:2', 20, -45),
    line('3:3', 90, 25),
    line('4:4', 120, 55),
  ])
  after.scrollTop = 65

  assert.equal(restorePausedLogPosition(after as unknown as HTMLElement, position), true)
  assert.equal(after.scrollTop, 125)
})

test('恢复暂停位置时忽略滚动容器自身坐标变化', () => {
  const before = new FakeLogList([
    line('1:1', 0, 35),
    line('2:2', 20, 55),
    line('3:3', 40, 75),
    line('4:4', 60, 95),
  ], 100)
  before.scrollTop = 65

  const position = capturePausedLogPosition(before as unknown as HTMLElement)

  assert.deepEqual(position, { key: '4:4', offset: -5 })

  const after = new FakeLogList([
    line('1:1', 100, 95),
    line('2:2', 120, 115),
    line('3:3', 140, 135),
    line('4:4', 160, 155),
  ], 160)
  after.scrollTop = 65

  assert.equal(restorePausedLogPosition(after as unknown as HTMLElement, position), true)
  assert.equal(after.scrollTop, 65)
})

test('找不到暂停锚点时不改变滚动位置', () => {
  const after = new FakeLogList([
    line('1:1', 0),
    line('2:2', 20),
  ])
  after.scrollTop = 30

  assert.equal(restorePausedLogPosition(after as unknown as HTMLElement, { key: '4:4', offset: -5 }), false)
  assert.equal(after.scrollTop, 30)
})

test('已离开 DOM 时不记录暂停位置', () => {
  const element = new FakeLogList([
    line('1:1', 0),
  ])
  element.isConnected = false

  assert.equal(capturePausedLogPosition(element as unknown as HTMLElement), undefined)
})
