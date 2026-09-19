<template>
  <div class="option-select">
    <button
      :id="id"
      class="option-select-trigger"
      type="button"
      role="combobox"
      :style="minWidth ? { minWidth } : undefined"
      :tabindex="tabindex"
      :aria-label="ariaLabel"
      :aria-expanded="open"
      aria-haspopup="listbox"
      @click="emit('update:open', !open)"
    >
      <span>{{ selectedLabel }}</span>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m7 10 5 5 5-5"/>
      </svg>
    </button>
    <div v-if="open" v-overlay-scrollbar class="option-select-content" role="listbox">
      <button
        v-for="option in allOptions"
        :key="option.value"
        type="button"
        role="option"
        :aria-selected="option.value === modelValue"
        :class="{ selected: option.value === modelValue }"
        @click="select(option.value)"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m5 12 4 4L19 6"/>
        </svg>
        <span>{{ option.label }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { vOverlayScrollbar } from './overlay-scrollbar'

const props = defineProps<{
  id: string
  modelValue: string
  open: boolean
  options: Array<{ value: string, label: string }>
  emptyLabel: string
  minWidth?: string
  tabindex?: number
  ariaLabel?: string
}>()

const emit = defineEmits<{
  (name: 'update:modelValue', value: string): void
  (name: 'update:open', value: boolean): void
}>()

const allOptions = computed(() => [{ value: '', label: props.emptyLabel }, ...props.options])
const selectedLabel = computed(() => allOptions.value.find(option => option.value === props.modelValue)?.label || props.emptyLabel)

function select(value: string) {
  emit('update:modelValue', value)
  emit('update:open', false)
}
</script>

<style scoped lang="scss">
.option-select {
  position: relative;
  display: inline-flex;
}

.option-select-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  box-sizing: border-box;
  width: max-content;
  min-width: 7.5rem;
  max-width: 22rem;
  height: 1.65rem;
  color: inherit;
  background: color-mix(in srgb, var(--terminal-bg) 70%, transparent);
  border: 1px solid transparent;
  border-radius: 999px;
  padding: 0 0.6rem;
  font: inherit;
  cursor: pointer;

  &:hover,
  &:focus-visible,
  &[aria-expanded="true"] {
    color: var(--terminal-fg-hover);
    background: color-mix(in srgb, var(--terminal-bg-hover) 72%, var(--terminal-bg));
    border-color: var(--terminal-separator);
    outline: none;
  }

  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  svg {
    flex: 0 0 auto;
    width: 0.9rem;
    height: 0.9rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.55;
  }
}

// 下拉列表用 overlay 自绘滚动条：原生轨道底色比菜单更深，会在菜单右侧留下一条竖带。
// 宽度按内容撑开，插件名不再截断，因此也不能再靠滚动条占位挤压文字。
.option-select-content {
  position: absolute;
  top: calc(100% + 0.4rem);
  left: 0;
  z-index: 3;
  width: max-content;
  min-width: 12rem;
  max-height: 14rem;
  overflow-y: auto;
  color: var(--terminal-fg);
  background: var(--terminal-bg-hover);
  border: 1px solid var(--terminal-separator);
  border-radius: 0.65rem;
  padding: 0.25rem;
  box-shadow: 0 10px 30px rgb(0 0 0 / 35%);

  button {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    width: 100%;
    color: inherit;
    background: transparent;
    border: 0;
    border-radius: 0.4rem;
    // 右侧留出自绘滑块的宽度，滑块不会压在插件名末尾
    padding: 0.35rem 0.75rem 0.35rem 0.5rem;
    font: inherit;
    font-size: 0.8rem;
    line-height: 1.15rem;
    text-align: left;
    cursor: pointer;

    &:hover,
    &:focus-visible,
    &.selected {
      color: var(--terminal-fg-hover);
      background: color-mix(in srgb, var(--terminal-bg) 72%, transparent);
      outline: none;
    }

    svg {
      flex: 0 0 auto;
      width: 0.8rem;
      height: 0.8rem;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
      opacity: 0;
    }

    &.selected svg {
      opacity: 1;
    }

    span {
      white-space: nowrap;
    }
  }
}
</style>
