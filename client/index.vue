<template>
  <k-layout>
    <div class="logger-filter">
      <label for="logger-filter-path">插件</label>
      <select id="logger-filter-path" v-model="selectedPath">
        <option value="">全部插件</option>
        <option v-for="plugin in plugins" :key="plugin.path" :value="plugin.path">
          {{ plugin.label }}
        </option>
      </select>
    </div>
    <logs class="layout-logger" :logs="filteredLogs" show-link reset-follow-on-enter></logs>
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
  z-index: 1;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--terminal-fg);
  background-color: var(--terminal-bg-hover);
  border: 1px solid var(--terminal-separator);
  border-radius: 4px;
  padding: 0.25rem 0.5rem;
  line-height: 1.25rem;

  select {
    color: inherit;
    background: transparent;
    border: none;
    outline: none;
  }
}

</style>
