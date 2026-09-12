// 完整 Koishi 开发环境的浏览器验收。无需新增项目依赖：
// npx playwright cli -s=viewport open http://127.0.0.1:5140/logs --browser=chrome
// npx playwright cli -s=viewport run-code --filename=tests/browser/log-viewport.js
// npx playwright cli -s=viewport eval 'window.viewportReport'
// npx playwright cli -s=viewport close
// Firefox 使用独立会话重复执行；测试数据仅存在于浏览器，不写服务端。
async page => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('http://127.0.0.1:5140/logs')
  await page.locator('.log-list').waitFor()
  await page.evaluate(async () => {
    const list = document.querySelector('.log-list')
    // Vue dev 暴露的组件实例只用于向真实组件提供 props；行为通过 DOM 与公开视口接口验收。
    const component = list.__vueParentComponent
    const state = component.setupState
    const wait = () => new Promise(resolve => setTimeout(resolve, 250))
    const anchor = () => {
      const row = [...list.querySelectorAll('[data-log-key]')].find(row => row.getBoundingClientRect().bottom >= list.getBoundingClientRect().top)
      return row && { key: row.dataset.logKey, top: row.getBoundingClientRect().top - list.getBoundingClientRect().top }
    }
    const offset = key => [...list.querySelectorAll('[data-log-key]')].find(row => row.dataset.logKey === key)?.getBoundingClientRect().top - list.getBoundingClientRect().top
    const report = window.viewportReport = []
    const check = (name, actual, expected) => {
      report.push({ name, actual, expected })
      if (typeof actual === 'number' ? !Number.isFinite(actual) || Math.abs(actual - expected) > 1 : actual !== expected) {
        throw new Error(`${name}: ${actual} !== ${expected}`)
      }
    }
    const record = i => ({ id: i + 21, timestamp: 1800000000000 + i, name: 'viewport-check', type: 'info', content: `记录 ${i} ` + '变高日志换行测试 '.repeat(Math.abs(i % 5) * 20), meta: {} })
    await wait()
    component.props.logs = Array.from({ length: 1000 }, (_, i) => record(i))
    state.viewport.followLatest()
    await wait()
    check('追踪贴底', list.scrollHeight - list.clientHeight - list.scrollTop, 0)
    component.props.logs = component.props.logs.concat(Array.from({ length: 20 }, (_, i) => record(1000 + i)))
    await wait()
    check('追加后贴底', list.scrollHeight - list.clientHeight - list.scrollTop, 0)
    list.scrollTop -= 1600
    await wait()
    check('上滚暂停', state.isFollowing, false)
    const paused = anchor()
    component.props.logs = component.props.logs.concat(Array.from({ length: 20 }, (_, i) => record(1020 + i)))
    await wait()
    check('暂停追加保位', offset(paused.key), paused.top)
    await state.viewport.around(() => {
      component.props.logs = Array.from({ length: 20 }, (_, i) => record(-20 + i)).concat(component.props.logs)
    })
    await wait()
    check('前插20条保位', offset(paused.key), paused.top)
    const saved = state.viewport.capture()
    list.scrollTop = 0
    await wait()
    check('锚点已离开窗口', Number.isNaN(offset(saved.key)), true)
    await state.viewport.restore(saved)
    await wait()
    check('窗口外恢复', offset(saved.key), saved.offset)
    window.viewportFixture = { component, wait, anchor, offset, check, resizeBefore: anchor() }
  })
  await page.setViewportSize({ width: 820, height: 720 })
  await page.evaluate(async () => {
    const { component, wait, anchor, offset, check, resizeBefore } = window.viewportFixture
    await wait()
    check('缩窄窗口保位', offset(resizeBefore.key), resizeBefore.top)
    component.props.preservePausedPositionOnReturn = true
    const before = anchor()
    await component.setupState.router.push('/plugins/')
    await wait()
    check('离开后已断开DOM', component.setupState.logList.isConnected, false)
    await component.setupState.router.push('/logs')
    await wait()
    check('跨页返回保位', offset(before.key), before.top)
  })
  await page.locator('.logger-scroll-bottom').click()
  await page.evaluate(async () => {
    const { component, wait, check } = window.viewportFixture
    await wait()
    const list = document.querySelector('.log-list')
    check('按钮恢复追踪', component.setupState.isFollowing, true)
    check('按钮回到底部', list.scrollHeight - list.clientHeight - list.scrollTop, 0)
    component.props.logs = Array.from({ length: 100000 }, (_, i) => ({ id: i + 1, timestamp: 1800000000000 + i, type: 'info', name: 'viewport-scale', content: `十万条验证 ${i}`, meta: {} }))
    component.setupState.viewport.followLatest()
    await wait()
    const count = list.querySelectorAll('[data-log-key]').length
    check('十万条保持虚拟化', count < 200, true)
    check('十万条仍贴底', list.scrollHeight - list.clientHeight - list.scrollTop, 0)
    window.viewportReport.push({ name: '十万条实际DOM行数', actual: count })
  })
  const thumb = page.locator('.overlay-scrollbar__thumb:visible').last()
  const box = await thumb.boundingBox()
  if (!box) throw new Error('未找到自绘滚动条')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, 240, { steps: 15 })
  await page.mouse.up()
  await page.evaluate(async () => {
    const { component, wait, anchor, offset, check } = window.viewportFixture
    await wait()
    const list = document.querySelector('.log-list')
    const top = list.scrollTop
    const before = anchor()
    await wait()
    check('拖拽后暂停', component.setupState.isFollowing, false)
    check('拖拽松手不漂移', list.scrollTop, top)
    check('拖拽锚点不抖动', offset(before.key), before.top)
    check('根容器避让侧栏', document.querySelector('.logger-page').getBoundingClientRect().left >= 64, true)
    check('页面无横向溢出', document.documentElement.scrollWidth <= innerWidth, true)
  })
}
