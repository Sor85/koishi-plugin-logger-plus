import { Context, store } from '@koishijs/client'
import { watch } from 'vue'
import {} from 'koishi-plugin-logger-plus'
import Logs from './index.vue'
import Settings from './settings.vue'
import { trimLogRecords } from './log-record'
import { liveLogTrimLimit } from './live-log-trim'
import './index.scss'
import './overlay-scrollbar.scss'
import './icons'

import 'virtual:uno.css'

const LIVE_LOG_LIMIT = 1000
// 暂停浏览期间放宽到这个上限：用户正在读的那一段不能被裁掉，缓冲也不能就此无限增长
const LIVE_LOG_HELD_LIMIT = 5000

export default (ctx: Context) => {
  watch(() => store.logs?.length, () => {
    if (store.logs) trimLogRecords(store.logs, liveLogTrimLimit(LIVE_LOG_LIMIT, LIVE_LOG_HELD_LIMIT))
  }, { flush: 'sync' })

  ctx.page({
    path: '/logs',
    name: '日志',
    icon: 'activity:logs',
    order: 0,
    authority: 4,
    fields: ['logs'],
    component: Logs,
  })

  ctx.slot({
    type: 'plugin-details',
    component: Settings,
    order: -800,
  })
}
