<template>
  <k-layout>
    <div class="logger-filter">
      <span class="logger-filter-dot"></span>
      <label for="logger-filter-path">过滤</label>
      <select id="logger-filter-path" v-model="selectedPath">
        <option value="">全部插件</option>
        <option v-for="plugin in plugins" :key="plugin.path" :value="plugin.path">
          {{ plugin.label }}
        </option>
      </select>
    </div>
    <logs :key="selectedPath" class="layout-logger" :logs="filteredLogs" show-link reset-follow-on-enter :load-before="!selectedPath"></logs>
  </k-layout>
</template>

<script lang="ts" setup>

import { store } from '@koishijs/client'
import { computed, ref } from 'vue'
import Logs from './logs.vue'

const selectedPath = ref('')

function getPluginLabel(path: string) {
  const entry = findPluginEntry(path, store.config?.plugins)
  if (!entry) return path
  return entry.label || entry.name
}

function findPluginEntry(path: string, plugins: Record<string, any>): { name: string, label?: string } | undefined {
  if (!plugins) return
  for (let key in plugins) {
    if (key.startsWith('$')) continue
    const config = plugins[key]
    if (key.startsWith('~')) key = key.slice(1)
    const name = key.split(':', 1)[0]
    const currentPath = key.includes(':') ? key.slice(name.length + 1) : undefined
    if (currentPath === path) return { name, label: config?.$label }
    if (key.startsWith('group:')) {
      const result = findPluginEntry(path, config)
      if (result) return result
    }
  }
}

const plugins = computed(() => {
  const paths = new Set<string>()
  for (const record of store.logs ?? []) {
    for (const path of record.meta?.paths ?? []) {
      paths.add(path)
    }
  }
  return [...paths]
    .map(path => ({ path, label: getPluginLabel(path) }))
    .sort((left, right) => left.label.localeCompare(right.label))
})

const filteredLogs = computed(() => {
  if (!selectedPath.value) return store.logs ?? []
  return (store.logs ?? []).filter(record => record.meta?.paths?.includes(selectedPath.value))
})

</script>

<style scoped lang="scss">

.logger-filter {
  position: absolute;
  top: 0.75rem;
  left: 1rem;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--terminal-fg);
  background: var(--terminal-bg-hover);
  background: color-mix(in srgb, var(--terminal-bg-hover) 86%, transparent);
  border: 1px solid var(--terminal-separator);
  border-color: color-mix(in srgb, var(--terminal-separator) 70%, var(--terminal-fg));
  border-radius: 999px;
  padding: 0.35rem 0.45rem 0.35rem 0.65rem;
  line-height: 1.25rem;
  box-shadow: 0 10px 28px rgb(0 0 0 / 18%), inset 0 1px 0 rgb(255 255 255 / 8%);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);

  label {
    color: var(--terminal-fg);
    color: color-mix(in srgb, var(--terminal-fg) 78%, transparent);
    font-size: 12px;
    letter-spacing: 0.04em;
  }

  select {
    min-width: 7.5rem;
    max-width: 12rem;
    color: inherit;
    background: var(--terminal-bg);
    background: color-mix(in srgb, var(--terminal-bg) 70%, transparent);
    border: 1px solid transparent;
    border-radius: 999px;
    outline: none;
    padding: 0.15rem 1.5rem 0.15rem 0.6rem;
    cursor: pointer;
    transition: border-color 0.15s ease, background-color 0.15s ease, color 0.15s ease;

    &:hover,
    &:focus-visible {
      color: var(--terminal-fg-hover);
      background: var(--terminal-bg-hover);
      background: color-mix(in srgb, var(--terminal-bg-hover) 72%, var(--terminal-bg));
      border-color: var(--terminal-separator);
    }
  }
}

.logger-filter-dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 999px;
  background: #22c55e;
  background: color-mix(in srgb, var(--terminal-fg-hover) 75%, #22c55e);
  box-shadow: 0 0 12px #22c55e;
  box-shadow: 0 0 12px color-mix(in srgb, var(--terminal-fg-hover) 55%, #22c55e);
}

</style>
