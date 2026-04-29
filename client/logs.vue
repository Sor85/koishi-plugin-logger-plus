<!--
  日志列表展示组件
  负责渲染日志内容和控制最新日志追踪
-->
<template>
  <div class="logger-container">
    <button class="logger-follow" type="button" @click="toggleFollow">
      {{ isFollowing ? '暂停追踪' : '继续追踪' }}
    </button>
    <div
      ref="logList"
      class="log-list k-text-selectable"
      :style="listStyle"
      @scroll="handleScroll"
    >
      <div
        v-for="(record, index) in logs"
        :key="record.id"
        :class="{ line: true, start: isStart(index) }"
      >
        <code v-html="renderLine(record)"></code>
        <router-link
          class="log-link inline-flex items-center justify-center absolute w-20px h-20px bottom-0 right-0"
          v-if="showLink && store.config && store.packages && record.meta?.paths?.length"
          :to="'/plugins/' + record.meta.paths[0].replace(/\./, '/')"
        >
          <k-icon name="arrow-right"/>
        </router-link>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>

import { Time, store } from '@koishijs/client'
import {} from '@koishijs/plugin-config'
import Logger from 'reggol'
import ansi from 'ansi_up'
import { computed, nextTick, onActivated, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  logs: Logger.Record[],
  showLink?: boolean,
  maxHeight?: string,
  resetFollowOnEnter?: boolean,
}>()

// this package does not have consistent exports in different environments
const converter = new (ansi['default'] || ansi)()
converter.escape_for_html = true

function renderColor(code: number, value: any, decoration = '') {
  return `\u001b[3${code < 8 ? code : '8;5;' + code}${decoration}m${value}\u001b[0m`
}

const showTime = 'yyyy-MM-dd hh:mm:ss'
const logList = ref<HTMLElement | null>(null)
const isFollowing = ref(true)
const isViewingLatest = ref(true)
let lastScrollTop = 0

const listStyle = computed(() => props.maxHeight ? { maxHeight: props.maxHeight } : {})

function scrollToBottom() {
  if (!logList.value) return
  logList.value.scrollTop = logList.value.scrollHeight
  updateViewingLatest()
}

function updateViewingLatest() {
  const element = logList.value
  if (!element) return
  isViewingLatest.value = element.scrollTop + element.clientHeight + 64 >= element.scrollHeight
  lastScrollTop = element.scrollTop
}

function followLatest() {
  isFollowing.value = true
  isViewingLatest.value = true
  nextTick(() => requestAnimationFrame(scrollToBottom))
}

function toggleFollow() {
  if (isFollowing.value) {
    isFollowing.value = false
    return
  }
  followLatest()
}

function handleScroll() {
  const element = logList.value
  if (!element) return
  const previousScrollTop = lastScrollTop
  updateViewingLatest()
  if (element.scrollTop < previousScrollTop) {
    isFollowing.value = false
  } else if (isViewingLatest.value) {
    isFollowing.value = true
  }
}

onMounted(() => {
  requestAnimationFrame(scrollToBottom)
})

onActivated(() => {
  if (props.resetFollowOnEnter) followLatest()
})

watch(() => props.logs.length, async () => {
  await nextTick()
  requestAnimationFrame(() => {
    if (isFollowing.value) scrollToBottom()
    updateViewingLatest()
  })
})

function isStart(index: number) {
  return index > 0 && props.logs[index - 1].id > props.logs[index].id && props.logs[index].name === 'app'
}

function renderLine(record: Logger.Record) {
  const prefix = `[${record.type[0].toUpperCase()}]`
  const space = ' '
  let indent = 3 + space.length, output = ''
  indent += showTime.length + space.length
  output += renderColor(8, Time.template(showTime, new Date(record.timestamp))) + space
  const code = Logger.code(record.name, { colors: 3 })
  const label = renderColor(code, record.name, ';1')
  const padLength = label.length - record.name.length
  output += prefix + space + label.padEnd(padLength) + space
  output += record.content.replace(/\n/g, '\n' + ' '.repeat(indent))
  return converter.ansi_to_html(output)
}

</script>

<style lang="scss" scoped>

.logger-container {
  position: relative;
  height: 100%;
}

.logger-follow {
  position: absolute;
  top: 0.75rem;
  right: 1rem;
  z-index: 1;
  color: var(--terminal-fg);
  background-color: var(--terminal-bg-hover);
  border: 1px solid var(--terminal-separator);
  border-radius: 4px;
  padding: 0.25rem 0.5rem;
  line-height: 1.25rem;
  cursor: pointer;

  &:hover {
    color: var(--terminal-fg-hover);
  }
}

.log-list {
  height: 100%;
  overflow-y: auto;
  color: var(--terminal-fg);
  background-color: var(--terminal-bg);
  padding: 1rem 1rem;

  .line.start {
    margin-top: 1rem;

    &::before {
      content: '';
      position: absolute;
      left: 0;
      right: 0;
      top: -0.5rem;
      border-top: 1px solid var(--terminal-separator);
    }
  }

  .line:first-child {
    margin-top: 0;

    &::before {
      display: none;
    }
  }

  .line {
    padding: 0 0.5rem;
    border-radius: 2px;
    font-size: 14px;
    line-height: 20px;
    white-space: pre-wrap;
    word-break: break-all;
    position: relative;

    &:hover {
      color: var(--terminal-fg-hover);
      background-color: var(--terminal-bg-hover);
    }

    ::selection {
      background-color: var(--terminal-bg-selection);
    }
  }
}

</style>
