export interface PausedLogPosition {
  key: string
  offset: number
}

function getLogLines(element: HTMLElement) {
  return Array.from(element.querySelectorAll<HTMLElement>('[data-log-key]'))
}

function getRelativeOffset(element: HTMLElement, line: HTMLElement) {
  return line.getBoundingClientRect().top - element.getBoundingClientRect().top
}

// 记录当前视口内第一条可见日志及其相对偏移
export function capturePausedLogPosition(element: HTMLElement): PausedLogPosition | undefined {
  if (!element.isConnected) return
  const top = element.getBoundingClientRect().top
  const anchor = getLogLines(element).find(line => line.getBoundingClientRect().bottom >= top)
  const key = anchor?.dataset.logKey
  if (!anchor || !key) return
  return {
    key,
    offset: getRelativeOffset(element, anchor),
  }
}

// 按记录的日志锚点恢复滚动位置，恢复失败时返回 false
export function restorePausedLogPosition(element: HTMLElement, position?: PausedLogPosition) {
  if (!element.isConnected) return false
  if (!position) return false
  const anchor = getLogLines(element).find(line => line.dataset.logKey === position.key)
  if (!anchor) return false
  element.scrollTop += getRelativeOffset(element, anchor) - position.offset
  return true
}
