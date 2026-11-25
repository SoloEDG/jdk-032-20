<script setup lang="ts">
import { computed } from 'vue'
import { Cable, CirclePlus, GitBranch, Route, ShieldCheck, X } from '@lucide/vue'
import type { DominoDocument } from '@/shared/document'
import { availableTargets } from '../lib/connections'
import { validateWire, wireSlack } from '../lib/wire'

const props = defineProps<{
  document: DominoDocument; fromId: string; toId: string; message: string
  messageTone?: 'ok' | 'error'; selectedWireId: string | null
}>()
const emit = defineEmits<{
  'update:fromId': [string]; 'update:toId': [string]; add: []
  remove: [string]; toggle: [string, boolean]; 'select-wire': [string | null]
  'auto-route': []; 'self-check': []
  'update-slack': [number]; 'slack-begin': []; 'slack-commit': []
}>()
const sourceTargets = (from: string) => availableTargets(props.document, from)
const allPieces = computed(() => props.document.pieces)
const selectedWire = computed(() =>
  props.document.connections.find(link => link.id === props.selectedWireId) ?? null)
const selectedSlack = computed(() => selectedWire.value ? wireSlack(selectedWire.value) : 0)

function statusOf(linkId: string) {
  const link = props.document.connections.find(item => item.id === linkId)
  if (!link) return { invalid: false, title: '' }
  const issues = validateWire(link, props.document.pieces)
  return { invalid: issues.length > 0, title: issues[0]?.message ?? '整线复检无冲突' }
}
function onSlackInput(event: Event) {
  emit('update-slack', Number((event.target as HTMLInputElement).value))
}
</script>

<template>
  <section class="mechanism-panel">
    <div class="section-kicker"><span>03 / LINK</span><h2>机关拉线</h2></div>
    <div class="link-summary"><GitBranch :size="15" /><span>{{ document.connections.length }} 条拉线 · 选中后可在桌面编辑</span></div>
    <div v-if="document.connections.length" class="connection-list">
      <div v-for="link in document.connections" :key="link.id" class="connection-row"
        :class="{ selected: selectedWireId === link.id }" @click="emit('select-wire', link.id)">
        <button class="connection-toggle" :class="{ active: link.enabled }" :aria-label="link.enabled ? '停用连线' : '启用连线'"
          :aria-pressed="link.enabled" @click.stop="emit('toggle', link.id, !link.enabled)"><span></span></button>
        <span class="connection-status" :class="statusOf(link.id).invalid ? 'bad' : 'clear'" :title="statusOf(link.id).title"></span>
        <span class="connection-names" :title="statusOf(link.id).title">{{ document.pieces.find(piece => piece.id === link.from)?.label }} <i>→</i> {{ document.pieces.find(piece => piece.id === link.to)?.label }}</span>
        <button class="remove-link" :aria-label="'删除连线 ' + link.id" @click.stop="emit('remove', link.id)"><X :size="14" /></button>
      </div>
    </div>

    <div v-if="selectedWire" class="wire-editor-panel">
      <div class="wire-editor-title"><Cable :size="13" /> 桌面拉线编辑</div>
      <label class="field-label slack-field">松弛余量 <span class="slack-value mono">{{ selectedSlack.toFixed(2) }}m</span>
        <input type="range" min="0" max="1.8" step="0.05" :value="selectedSlack"
          @pointerdown="emit('slack-begin')" @keydown="emit('slack-begin')"
          @input="onSlackInput" @change="emit('slack-commit')" />
      </label>
      <div class="wire-editor-actions">
        <button type="button" @click="emit('auto-route')"><Route :size="13" /> 自动绕障</button>
        <button type="button" @click="emit('self-check')"><ShieldCheck :size="13" /> 端点移动自检</button>
      </div>
      <p class="wire-edit-hint">拖动金色端点移动所锚定的元件，松手复检整条路径；拖动方形折点塑形，双击折点删除；拖动菱形调整松弛环。非法移动会弹回并保留原连接。</p>
    </div>

    <div class="connection-builder">
      <div class="builder-title"><Cable :size="14" /> 新建连接</div>
      <label class="field-label">输出机关 / 起点
        <select :value="fromId" @change="emit('update:fromId', ($event.target as HTMLSelectElement).value)">
          <option value="">选择起点</option>
          <option v-for="piece in allPieces" :key="piece.id" :value="piece.id">{{ piece.label }}</option>
        </select>
      </label>
      <label class="field-label">接收元件 / 终点
        <select :value="toId" @change="emit('update:toId', ($event.target as HTMLSelectElement).value)">
          <option value="">选择终点</option>
          <option v-for="piece in sourceTargets(fromId)" :key="piece.id" :value="piece.id">{{ piece.label }}</option>
        </select>
      </label>
      <button class="add-connection" :disabled="!fromId || !toId" @click="emit('add')"><CirclePlus :size="15" /> 添加并自动绕障</button>
    </div>
    <p v-if="message" class="module-message" :class="messageTone" role="status">{{ message }}</p>
  </section>
</template>
