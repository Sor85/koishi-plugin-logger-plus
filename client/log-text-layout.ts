import type { LogTextLayout } from './log-height-estimator'

/** 仅在清单提交或排版变化时读取几何；不用逐条测文字、创建隐藏日志或完整模拟浏览器排版。 */
export function readLogTextLayout(element: HTMLElement | null): LogTextLayout {
  if (!element?.isConnected) return { columns: 100, lineHeight: 20, separatorHeight: 16 }
  const listStyle = getComputedStyle(element)
  const line = element.querySelector<HTMLElement>('.line')
  const code = line?.querySelector<HTMLElement>('code')
  const lineStyle = line ? getComputedStyle(line) : listStyle
  const codeStyle = code ? getComputedStyle(code) : lineStyle
  const number = (value: string, fallback = 0) => Number.parseFloat(value) || fallback
  const rem = number(getComputedStyle(document.documentElement).fontSize, 16)
  const fontSize = code
    ? number(codeStyle.fontSize, 14)
    : number(listStyle.getPropertyValue('--logger-font-size'), 14)
  const rowPadding = line
    ? number(lineStyle.paddingLeft) + number(lineStyle.paddingRight)
    : 3.5 * rem
  const width = element.clientWidth - number(listStyle.paddingLeft) - number(listStyle.paddingRight) - rowPadding
  return {
    columns: Math.max(1, Math.floor(width / (fontSize * 0.6))),
    lineHeight: number(lineStyle.lineHeight, number(listStyle.getPropertyValue('--logger-line-height'), 20)),
    separatorHeight: rem,
  }
}
