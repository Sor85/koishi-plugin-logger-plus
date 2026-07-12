<template>
  <div class="date-picker">
    <button
      :id="id"
      class="date-picker-trigger"
      type="button"
      :tabindex="tabindex"
      :aria-expanded="open"
      @click="emit('update:open', !open)"
    >
      <span>{{ modelValue || '选择日期' }}</span>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/>
      </svg>
    </button>
    <div v-if="open" class="date-picker-content">
      <div class="date-picker-header">
        <button type="button" aria-label="上个月" @click="shiftMonth(-1)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
        </button>
        <strong>{{ calendarTitle }}</strong>
        <button type="button" aria-label="下个月" @click="shiftMonth(1)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
        </button>
      </div>
      <div class="date-picker-weekdays">
        <span v-for="weekday in weekdays" :key="weekday">{{ weekday }}</span>
      </div>
      <div class="date-picker-grid">
        <button
          v-for="day in calendarDays"
          :key="day.key"
          :class="{ muted: !day.currentMonth, today: day.date === todayDate, selected: day.date === modelValue }"
          type="button"
          @click="select(day.date)"
        >{{ day.day }}</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  id: string
  modelValue: string
  open: boolean
  tabindex?: number
}>()

const emit = defineEmits<{
  (name: 'update:modelValue', value: string): void
  (name: 'update:open', value: boolean): void
}>()

const visibleMonth = ref(props.modelValue ? parseDate(props.modelValue) : new Date())
const weekdays = ['一', '二', '三', '四', '五', '六', '日']
const todayDate = formatDate(new Date())

const calendarTitle = computed(() => `${visibleMonth.value.getFullYear()} 年 ${visibleMonth.value.getMonth() + 1} 月`)
const calendarDays = computed(() => {
  const year = visibleMonth.value.getFullYear()
  const month = visibleMonth.value.getMonth()
  const firstDay = new Date(year, month, 1)
  const start = new Date(year, month, 1 - (firstDay.getDay() + 6) % 7)
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)
    return {
      key: formatDate(date),
      date: formatDate(date),
      day: date.getDate(),
      currentMonth: date.getMonth() === month,
    }
  })
})

watch(() => props.modelValue, (value) => {
  if (value) visibleMonth.value = parseDate(value)
})

function formatDate(date: Date) {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parseDate(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function shiftMonth(offset: number) {
  visibleMonth.value = new Date(visibleMonth.value.getFullYear(), visibleMonth.value.getMonth() + offset, 1)
}

function select(date: string) {
  emit('update:modelValue', date)
  emit('update:open', false)
}
</script>

<style scoped lang="scss">
.date-picker {
  position: relative;
  display: inline-flex;
}

.date-picker-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  box-sizing: border-box;
  min-width: 7.5rem;
  max-width: 12rem;
  height: 1.65rem;
  color: inherit;
  background: color-mix(in srgb, var(--terminal-bg) 70%, transparent);
  border: 1px solid transparent;
  border-radius: 0.55rem;
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

  svg {
    flex: 0 0 auto;
    width: 0.9rem;
    height: 0.9rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.65;
  }
}

.date-picker-content {
  position: absolute;
  top: calc(100% + 0.4rem);
  right: 0;
  z-index: 3;
  width: 16.5rem;
  color: var(--terminal-fg);
  background: var(--terminal-bg-hover);
  border: 1px solid var(--terminal-separator);
  border-radius: 0.75rem;
  padding: 0.65rem;
  box-shadow: 0 10px 30px rgb(0 0 0 / 35%);
}

.date-picker-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.55rem;

  strong {
    font-size: 0.85rem;
    font-weight: 500;
  }

  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    color: inherit;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 0.45rem;
    cursor: pointer;

    &:hover,
    &:focus-visible {
      background: color-mix(in srgb, var(--terminal-bg) 72%, transparent);
      border-color: var(--terminal-separator);
      outline: none;
    }
  }

  svg {
    width: 0.9rem;
    height: 0.9rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
}

.date-picker-weekdays,
.date-picker-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 0.2rem;
}

.date-picker-weekdays {
  margin-bottom: 0.25rem;
  color: color-mix(in srgb, var(--terminal-fg) 55%, transparent);
  font-size: 0.7rem;
  text-align: center;
}

.date-picker-grid button {
  aspect-ratio: 1;
  color: inherit;
  background: transparent;
  border: 0;
  border-radius: 0.4rem;
  font: inherit;
  font-size: 0.78rem;
  cursor: pointer;

  &:hover,
  &:focus-visible {
    background: color-mix(in srgb, var(--terminal-bg) 72%, transparent);
    outline: none;
  }

  &.muted {
    color: color-mix(in srgb, var(--terminal-fg) 35%, transparent);
  }

  &.today {
    box-shadow: inset 0 0 0 1px var(--terminal-separator);
  }

  &.selected {
    color: var(--terminal-bg);
    background: var(--terminal-fg-hover);
  }
}
</style>
