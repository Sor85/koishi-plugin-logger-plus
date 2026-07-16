import { Context, store } from '@koishijs/client'
import { watch } from 'vue'
import {} from 'koishi-plugin-logger-plus'
import Logs from './index.vue'
import Settings from './settings.vue'
import { trimLogRecords } from './log-record'
import './index.scss'
import './overlay-scrollbar.scss'
import './icons'

import 'virtual:uno.css'

const LIVE_LOG_LIMIT = 1000

export default (ctx: Context) => {
  watch(() => store.logs?.length, () => {
    if (store.logs) trimLogRecords(store.logs, LIVE_LOG_LIMIT)
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
