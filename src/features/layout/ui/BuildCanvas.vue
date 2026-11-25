<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { AlertTriangle, Crosshair, MousePointer2 } from '@lucide/vue'
import type {
  DominoDocument, MechanismConnection, Piece, PieceKind, SimulationRun, Vec2, WireConflict, WireConflictState, WireEffect,
} from '@/shared/document'
import {
  apexAt, buildWireObstacles, resolveSlackBay, roundedWorld, validateWire, wireNodes, wirePoseAt, wireSlack,
  type SlackBay,
} from '@/features/mechanisms/lib/wire'

const props = defineProps<{
  document: DominoDocument; activeTool: PieceKind | null; selectedId: string | null
  run: SimulationRun | null; focusPieceId: string | null; time: number
  selectedWireId: string | null; conflict: WireConflictState | null
}>()
const emit = defineEmits<{
  place: [PieceKind, number, number]; select: [string | null]; move: [string, number, number]
  'commit-piece': [string, Vec2]
  'select-wire': [string | null]
  'wire-vertex-move': [string, number, Vec2]
  'wire-vertex-add': [string, number, Vec2]
  'wire-vertex-remove': [string, number]
  'wire-vertex-commit': [string, number, Vec2]
  'wire-slack': [string, number, 1 | -1]
  'wire-slack-commit': [string, { slack?: number; slackSide?: 1 | -1 }]
}>()

const svg = ref<SVGSVGElement | null>(null)
const view = { width: 1040, height: 510, margin: 35 }

/* ---------------- time-aware simulation / replay state ---------------- */

const timedFallen = computed(() => {
  if (!props.run) return new Set<string>()
  const t = props.time ?? 0
  return new Set(props.run.events.filter(event => event.kind === 'fall' && event.time <= t + 1e-6).map(event => event.pieceId))
})

function toppleAngle(pieceId: string): number {
  if (!props.run) return 0
  const event = props.run.events.find(item => item.pieceId === pieceId && item.kind === 'fall')
  if (!event) return 0
  const since = props.time - event.time
  if (since <= 0) return 0
  const progress = Math.min(1, since / 0.42)
  const eased = 1 - (1 - progress) ** 3
  return (event.topple ?? 76) * eased
}

const fxList = computed(() => props.run?.wireEffects ?? [])

/* ---------------- coordinate mapping ---------------- */

function worldPoint(event: PointerEvent) {
  const svgEl = svg.value
  if (!svgEl) return { x: 0, y: 0 }
  // getScreenCTM accounts for viewBox aspect-ratio letterboxing and any
  // max-height clamping, unlike a naive bounding-rect比例 mapping.
  const ctm = svgEl.getScreenCTM()
  let svgX: number
  let svgY: number
  if (ctm) {
    const point = svgEl.createSVGPoint()
    point.x = event.clientX
    point.y = event.clientY
    const local = point.matrixTransform(ctm.inverse())
    svgX = local.x
    svgY = local.y
  } else {
    const bounds = svgEl.getBoundingClientRect()
    svgX = (event.clientX - bounds.left) / bounds.width * view.width
    svgY = (event.clientY - bounds.top) / bounds.height * view.height
  }
  return {
    x: Math.max(0, Math.min(props.document.scene.width,
      (svgX - view.margin) / (view.width - view.margin * 2) * props.document.scene.width)),
    y: Math.max(0, Math.min(props.document.scene.height,
      (svgY - view.margin) / (view.height - view.margin * 2) * props.document.scene.height)),
  }
}

function pxX(x: number) { return view.margin + x / props.document.scene.width * (view.width - view.margin * 2) }
function pxY(y: number) { return view.margin + y / props.document.scene.height * (view.height - view.margin * 2) }
function pieceById(id: string) { return props.document.pieces.find(piece => piece.id === id) }

function pieceColor(piece: Piece) {
  if (piece.id === props.run?.interruptedPieceId) return '#e88b69'
  if (timedFallen.value.has(piece.id)) return '#89c5a5'
  if (piece.kind === 'ramp') return '#8ca6a0'
  if (piece.kind === 'splitter') return '#e6bd68'
  if (piece.kind === 'trigger') return '#df8d70'
  return '#ead8b5'
}
function eventTime(pieceId: string) {
  const event = props.run?.events.find(item => item.pieceId === pieceId)
  if (!event || event.time > props.time + 1e-6) return ''
  return event.time.toFixed(2)
}

/* ---------------- piece dragging (endpoints reuse this) ---------------- */

let dragging: string | null = null
let dragOrig: Vec2 | null = null

function down(event: PointerEvent, piece: Piece) {
  event.stopPropagation()
  dragging = piece.id
  dragOrig = { x: piece.x, y: piece.y }
  emit('select', piece.id)
  ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
}
function move(event: PointerEvent) {
  if (!dragging) return
  const point = worldPoint(event)
  emit('move', dragging, point.x, point.y)
}
function up() {
  if (dragging && dragOrig) {
    const id = dragging
    const current = pieceById(id)
    if (current && Math.hypot(current.x - dragOrig.x, current.y - dragOrig.y) > 0.001) {
      emit('commit-piece', id, dragOrig)
    }
  }
  dragging = null
  dragOrig = null
}
function boardClick(event: PointerEvent) {
  if (dragging) return
  const point = worldPoint(event)
  if (props.activeTool) emit('place', props.activeTool, point.x, point.y)
  else { emit('select', null); emit('select-wire', null) }
}

/* ---------------- wire selection + path geometry ---------------- */

const selectedWire = computed(() =>
  props.document.connections.find(wire => wire.id === props.selectedWireId) ?? null)
const selectedNodes = computed<Vec2[]>(() =>
  selectedWire.value ? wireNodes(selectedWire.value, props.document.pieces) : [])
const selectedSlack = computed(() => selectedWire.value ? wireSlack(selectedWire.value) : 0)
const selectedBay = computed<SlackBay | null>(() =>
  selectedWire.value
    ? resolveSlackBay(selectedNodes.value, selectedSlack.value, selectedWire.value.slackSide ?? 1, selectedWire.value.slackSegment)
    : null)
const selectedIssues = computed<WireConflict[]>(() =>
  selectedWire.value ? validateWire(selectedWire.value, props.document.pieces) : [])

/** Persistent rejection markers plus live-drag validation markers. */
const liveMarkers = computed<WireConflict[]>(() => selectedIssues.value)
const storedMarkers = computed<WireConflict[]>(() => props.conflict?.conflicts ?? [])

const clipMarkers = computed(() =>
  buildWireObstacles(props.document.pieces).filter(obstacle => obstacle.kind === 'ramp-clip'))

function plainPathD(wire: MechanismConnection): string {
  const nodes = wireNodes(wire, props.document.pieces)
  if (!nodes.length) return ''
  return nodes.map((p, i) => `${i === 0 ? 'M' : 'L'} ${pxX(p.x).toFixed(1)} ${pxY(p.y).toFixed(1)}`).join(' ')
}

function cordPathFromNodes(nodes: readonly Vec2[], bay: SlackBay | null, apexOverride?: Vec2): string {
  if (!nodes.length) return ''
  let d = `M ${pxX(nodes[0].x).toFixed(1)} ${pxY(nodes[0].y).toFixed(1)}`
  for (let i = 1; i < nodes.length; i += 1) {
    if (bay && i === bay.index + 1) {
      const apex = apexOverride ?? bay.restApex
      d += ` L ${pxX(apex.x).toFixed(1)} ${pxY(apex.y).toFixed(1)}`
    }
    d += ` L ${pxX(nodes[i].x).toFixed(1)} ${pxY(nodes[i].y).toFixed(1)}`
  }
  return d
}
function cordPathD(wire: MechanismConnection): string {
  const nodes = wireNodes(wire, props.document.pieces)
  const bay = resolveSlackBay(nodes, wireSlack(wire), wire.slackSide ?? 1, wire.slackSegment)
  return cordPathFromNodes(nodes, wireSlack(wire) > 0.02 ? bay : null)
}
function pointsAttr(points: readonly Vec2[]): string {
  return points.map(p => `${pxX(p.x).toFixed(1)},${pxY(p.y).toFixed(1)}`).join(' ')
}

const addHandles = computed(() => {
  const nodes = selectedNodes.value
  const wire = selectedWire.value
  if (!wire) return []
  const handles: Array<{ x: number; y: number; segmentIndex: number }> = []
  for (let i = 0; i < nodes.length - 1; i += 1) {
    handles.push({ x: (nodes[i].x + nodes[i + 1].x) / 2, y: (nodes[i].y + nodes[i + 1].y) / 2, segmentIndex: i })
  }
  return handles
})

function selectWirePointer(event: PointerEvent, wire: MechanismConnection) {
  event.stopPropagation()
  emit('select-wire', wire.id)
}
function endpointPointerDown(event: PointerEvent, wire: MechanismConnection, pieceId: string) {
  const piece = pieceById(pieceId)
  if (!piece) return
  emit('select-wire', wire.id)
  down(event, piece)
}

/* ---------------- vertex / slack handle dragging (window listeners) ---------------- */

type VertexDrag = { wireId: string; index: number; orig: Vec2 }
let vertexDrag: VertexDrag | null = null

function onVertexMove(event: PointerEvent) {
  if (!vertexDrag) return
  emit('wire-vertex-move', vertexDrag.wireId, vertexDrag.index, worldPoint(event))
}
function onVertexUp() {
  const drag = vertexDrag
  vertexDrag = null
  window.removeEventListener('pointermove', onVertexMove)
  window.removeEventListener('pointerup', onVertexUp)
  if (!drag) return
  const wire = props.document.connections.find(item => item.id === drag.wireId)
  const current = wire?.waypoints?.[drag.index]
  if (current && Math.hypot(current.x - drag.orig.x, current.y - drag.orig.y) > 0.001) {
    emit('wire-vertex-commit', drag.wireId, drag.index, drag.orig)
  }
}
function vertexPointerDown(event: PointerEvent, wire: MechanismConnection, index: number) {
  event.stopPropagation()
  event.preventDefault()
  const orig = wire.waypoints?.[index]
  if (!orig) return
  vertexDrag = { wireId: wire.id, index, orig: { ...orig } }
  window.addEventListener('pointermove', onVertexMove)
  window.addEventListener('pointerup', onVertexUp)
}
function vertexDoubleClick(event: MouseEvent, wireId: string, index: number) {
  event.stopPropagation()
  emit('wire-vertex-remove', wireId, index)
}
function addHandlePointerDown(event: PointerEvent, wire: MechanismConnection, segmentIndex: number, point: Vec2) {
  event.stopPropagation()
  event.preventDefault()
  emit('wire-vertex-add', wire.id, segmentIndex, point)
  // The inserted waypoint takes index === segmentIndex (see controller splice).
  vertexDrag = { wireId: wire.id, index: segmentIndex, orig: roundedWorld(point) }
  window.addEventListener('pointermove', onVertexMove)
  window.addEventListener('pointerup', onVertexUp)
}

type SlackDrag = { wireId: string; origSlack: number; origSide: 1 | -1 }
let slackDrag: SlackDrag | null = null
function onSlackMove(event: PointerEvent) {
  if (!slackDrag) return
  const wire = props.document.connections.find(item => item.id === slackDrag!.wireId)
  if (!wire) return
  const nodes = wireNodes(wire, props.document.pieces)
  const bay = resolveSlackBay(nodes, 0, wire.slackSide ?? 1, wire.slackSegment)
  if (!bay) return
  const { slack, side } = (() => {
    const signed = ((p: Vec2) => (p.x - bay.mid.x) * bay.normal.x + (p.y - bay.mid.y) * bay.normal.y)(worldPoint(event))
    const h = Math.abs(signed)
    const slackValue = Math.max(0, Math.min(2.2, 2 * Math.sqrt((bay.length / 2) ** 2 + h ** 2) - bay.length))
    return { slack: Math.round(slackValue * 100) / 100, side: (signed < 0 ? -1 : 1) as 1 | -1 }
  })()
  emit('wire-slack', slackDrag.wireId, slack, side)
}
function onSlackUp() {
  const drag = slackDrag
  slackDrag = null
  window.removeEventListener('pointermove', onSlackMove)
  window.removeEventListener('pointerup', onSlackUp)
  if (drag) emit('wire-slack-commit', drag.wireId, { slack: drag.origSlack, slackSide: drag.origSide })
}
function apexPointerDown(event: PointerEvent, wire: MechanismConnection) {
  event.stopPropagation()
  event.preventDefault()
  slackDrag = { wireId: wire.id, origSlack: wire.slack ?? 0, origSide: wire.slackSide ?? 1 }
  window.addEventListener('pointermove', onSlackMove)
  window.addEventListener('pointerup', onSlackUp)
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onVertexMove)
  window.removeEventListener('pointerup', onVertexUp)
  window.removeEventListener('pointermove', onSlackMove)
  window.removeEventListener('pointerup', onSlackUp)
})

/* ---------------- simulation / replay wire FX ---------------- */

function fxD(fx: WireEffect): string {
  const pose = wirePoseAt(fx, props.time)
  const bay = resolveSlackBay(fx.nodes, fx.slack, fx.slackSide, fx.slackSegment)
  const apex = pose.state === 'sweep' || pose.state === 'wind' ? pose.apex : undefined
  return cordPathFromNodes(fx.nodes, bay, apex)
}
function fxState(fx: WireEffect) { return wirePoseAt(fx, props.time).state }
function fxPulse(fx: WireEffect): Vec2 | undefined { return wirePoseAt(fx, props.time).pulse }
function fxTrailD(fx: WireEffect): string {
  const pose = wirePoseAt(fx, props.time)
  if (pose.state !== 'sweep' || !pose.apex) return ''
  const bay = resolveSlackBay(fx.nodes, fx.slack, fx.slackSide, fx.slackSegment)
  if (!bay) return ''
  const trail: Vec2[] = []
  for (let p = 0; p <= pose.progress + 1e-6; p += 0.04) trail.push(apexAt(bay, Math.min(p, pose.progress)))
  trail.push(pose.apex)
  return trail.map((p, i) => `${i === 0 ? 'M' : 'L'} ${pxX(p.x).toFixed(1)} ${pxY(p.y).toFixed(1)}`).join(' ')
}
function hitVisible(hitTime: number) { return props.time + 1e-6 >= hitTime }
function flashRadius(arrival: number): number {
  const since = props.time - arrival
  if (since < 0 || since > 0.7) return 0
  return 8 + since / 0.7 * 18
}
function flashOpacity(arrival: number): number {
  const since = props.time - arrival
  if (since < 0 || since > 0.7) return 0
  return (1 - since / 0.7) * 0.85
}
/** Completed pull glows briefly, then yields back to the editable cord. */
function fxDoneOpacity(fx: WireEffect): number {
  const since = props.time - fx.arrival
  if (since < 0.25) return 0.85
  return Math.max(0, 0.85 * (1 - (since - 0.25) / 0.65))
}

function markerKey(conflict: WireConflict, index: number) { return `${conflict.obstacleId}-${conflict.segmentIndex}-${index}` }

function slackLabelAttrs(bay: SlackBay): { x: number; y: number; anchor: 'start' | 'middle' | 'end' } {
  // Vertical bay (the showcase): sit just past the top node, clear of the
  // fan and the edge domino. Other orientations: float above the apex and
  // clamp inside the svg so the label never clips at a table edge.
  if (Math.abs(bay.u.y) > 0.8) {
    const point = { x: bay.b.x + bay.u.x * 0.55, y: bay.b.y + bay.u.y * 0.55 }
    return { x: pxX(point.x), y: pxY(point.y) - 5, anchor: 'middle' }
  }
  const ax = pxX(bay.restApex.x)
  const ay = pxY(bay.restApex.y)
  if (ax > view.width - 72) return { x: ax - 12, y: ay - 12, anchor: 'end' }
  if (ax < 92) return { x: ax + 12, y: ay - 12, anchor: 'start' }
  return { x: ax, y: ay - 12, anchor: 'middle' }
}
</script>

<template>
  <section class="stage-panel" aria-label="骨牌构筑场景">
    <div class="stage-toolbar">
      <div class="stage-mode"><MousePointer2 :size="15" /><span>{{ activeTool ? '点击空位添加元件' : selectedWireId ? '拉线编辑：拖端点 / 折点 / 松弛环' : '编辑场景 · 点击金线编辑拉线' }}</span></div>
      <div class="stage-readout"><span class="readout-dot"></span>{{ document.pieces.length }} 件元件 <span class="readout-sep">·</span> {{ document.connections.length }} 条拉线 <span class="readout-sep">·</span> {{ document.scene.width }} × {{ document.scene.height }} 桌面</div>
    </div>
    <Transition name="toast">
      <div v-if="conflict" :key="conflict.nonce" class="wire-conflict-toast" role="alert">
        <AlertTriangle :size="15" />
        <span>{{ conflict.message }}</span>
      </div>
    </Transition>
    <svg ref="svg" class="stage-svg" :viewBox="`0 0 ${view.width} ${view.height}`" role="img"
      aria-label="可编辑的多米诺与拉线场景。拖动骨牌或拉线端点，移动后会复检整条路径。" @pointerup="up" @pointercancel="up"
      @pointermove="move" @pointerdown="boardClick">
      <defs>
        <pattern id="draft-grid" width="24" height="24" patternUnits="userSpaceOnUse">
          <path d="M 24 0 L 0 0 0 24" fill="none" stroke="#3c5048" stroke-width=".65" opacity=".6" />
          <circle cx="0" cy="0" r="1" fill="#b9c3a5" opacity=".3" />
        </pattern>
        <pattern id="draft-fine" width="6" height="6" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r=".65" fill="#758376" opacity=".35" />
        </pattern>
        <filter id="piece-shadow" x="-30%" y="-30%" width="160%" height="180%">
          <feDropShadow dx="1" dy="3" stdDeviation="2" flood-color="#101a17" flood-opacity=".38" />
        </filter>
      </defs>
      <rect x="0" y="0" :width="view.width" :height="view.height" rx="12" class="board-bg" />
      <rect :x="view.margin" :y="view.margin" :width="view.width-view.margin*2" :height="view.height-view.margin*2" rx="7" class="board-surface" />
      <rect :x="view.margin" :y="view.margin" :width="view.width-view.margin*2" :height="view.height-view.margin*2" rx="7" fill="url(#draft-fine)" pointer-events="none" />
      <path v-if="document.scene.showGrid" :d="`M ${view.margin} ${view.height/2} H ${view.width-view.margin} M ${view.width/2} ${view.margin} V ${view.height-view.margin}`" class="center-guide" pointer-events="none" />

      <!-- Unselected pull-wires -->
      <g v-for="wire in document.connections.filter(item => item.id !== selectedWireId)" :key="`wire-${wire.id}`">
        <path :d="plainPathD(wire)" class="wire-hit" fill="none" @pointerdown="selectWirePointer($event, wire)">
          <title>选择拉线 {{ pieceById(wire.from)?.label }} → {{ pieceById(wire.to)?.label }}</title>
        </path>
        <path :d="cordPathD(wire)" :class="['wire-cord', 'compact', { disabled: !wire.enabled }]" fill="none" pointer-events="none" />
        <circle v-for="(p, i) in wireNodes(wire, document.pieces)" :key="i" :cx="pxX(p.x)" :cy="pxY(p.y)" r="2.6" class="wire-anchor-dot" :class="{ disabled: !wire.enabled }" pointer-events="none" />
      </g>

      <!-- Pieces -->
      <g v-for="piece in document.pieces" :key="piece.id" class="scene-piece"
        :class="{ selected: selectedId === piece.id, focused: focusPieceId === piece.id, fallen: timedFallen.has(piece.id) }"
        :transform="`translate(${pxX(piece.x)} ${pxY(piece.y)}) rotate(${piece.angle}) rotate(${toppleAngle(piece.id).toFixed(2)} 0 12)`"
        :tabindex="0" role="button" :aria-label="`${piece.label}，${piece.x.toFixed(1)}，${piece.y.toFixed(1)}`" :aria-pressed="selectedId === piece.id"
        @pointerdown="down($event, piece)" @keydown.enter.stop="emit('select', piece.id)" @keydown.space.stop.prevent="emit('select', piece.id)">
        <ellipse v-if="piece.kind === 'domino'" cx="0" cy="7" rx="15" ry="8" class="piece-ground-shadow" />
        <rect v-if="piece.kind === 'domino'" x="-9" y="-20" width="18" height="39" rx="4" :fill="pieceColor(piece)" class="domino-body" filter="url(#piece-shadow)" />
        <path v-else-if="piece.kind === 'ramp'" d="M-24 10 L22 10 L22 -10 Z" :fill="pieceColor(piece)" class="ramp-body" filter="url(#piece-shadow)" />
        <path v-else-if="piece.kind === 'splitter'" d="M0-13 L13 0 L0 13 L-13 0 Z" :fill="pieceColor(piece)" class="splitter-body" filter="url(#piece-shadow)" />
        <circle v-else r="11" :fill="pieceColor(piece)" class="trigger-body" filter="url(#piece-shadow)" />
        <line v-if="piece.kind === 'domino'" x1="0" y1="-15" x2="0" y2="14" class="domino-mark" />
        <circle v-if="piece.id === document.startPieceId" cy="-28" r="4" class="start-marker" />
        <circle v-if="piece.id === run?.interruptedPieceId" cy="-34" r="7" class="failure-marker" />
        <text y="32" text-anchor="middle" class="piece-label">{{ piece.label }}</text>
        <text v-if="eventTime(piece.id)" y="44" text-anchor="middle" class="piece-time">{{ eventTime(piece.id) }}s</text>
        <rect v-if="selectedId === piece.id || focusPieceId === piece.id" x="-18" y="-28" width="36" height="55" rx="8" class="selection-ring" />
      </g>

      <!-- Ramp clip buckles: routing obstacles, drawn in world coordinates -->
      <g class="clip-layer" pointer-events="none">
        <g v-for="clip in clipMarkers" :key="clip.id">
          <rect :x="pxX(clip.a.x) - 3.4" :y="pxY(clip.a.y) - 3.4" width="6.8" height="6.8" rx="1.6" class="clip-marker" />
          <title>坡道卡扣 · 布线障碍</title>
        </g>
      </g>

      <!-- Selected wire editor -->
      <g v-if="selectedWire && selectedNodes.length >= 2" class="wire-editor">
        <!-- Slack sweep fan -->
        <g v-if="selectedBay && selectedSlack > 0.02" pointer-events="none">
          <polygon :points="pointsAttr([selectedBay.a, apexAt(selectedBay, 0.78), selectedBay.b])" class="slack-fan lash" />
          <polygon :points="pointsAttr([selectedBay.a, selectedBay.restApex, selectedBay.b])" class="slack-fan rest" />
          <line :x1="pxX(selectedBay.a.x)" :y1="pxY(selectedBay.a.y)" :x2="pxX(selectedBay.b.x)" :y2="pxY(selectedBay.b.y)" class="slack-base" />
          <text :x="slackLabelAttrs(selectedBay).x" :y="slackLabelAttrs(selectedBay).y"
            :text-anchor="slackLabelAttrs(selectedBay).anchor" class="slack-label">松弛 {{ selectedSlack.toFixed(2) }}m</text>
        </g>

        <!-- Cord casing + fibre -->
        <path :d="cordPathD(selectedWire)" class="wire-casing" fill="none" pointer-events="none" />
        <path :d="cordPathD(selectedWire)" :class="['wire-cord', 'selected', { invalid: selectedIssues.length > 0, disabled: !selectedWire.enabled }]" fill="none" pointer-events="none" />

        <!-- Segment add-bend handles -->
        <g v-for="handle in addHandles" :key="`add-${handle.segmentIndex}`" class="wire-add-handle"
          @pointerdown="addHandlePointerDown($event, selectedWire, handle.segmentIndex, handle)">
          <circle :cx="pxX(handle.x)" :cy="pxY(handle.y)" r="9" class="add-hit" />
          <circle :cx="pxX(handle.x)" :cy="pxY(handle.y)" r="4.2" class="add-dot" />
          <path :d="`M ${pxX(handle.x) - 2.4} ${pxY(handle.y)} H ${pxX(handle.x) + 2.4} M ${pxX(handle.x)} ${pxY(handle.y) - 2.4} V ${pxY(handle.y) + 2.4}`" class="add-plus" />
          <title>拖动添加折点</title>
        </g>

        <!-- Editable bend vertices -->
        <g v-for="(point, index) in selectedNodes.slice(1, -1)" :key="`vertex-${index}`" class="wire-vertex-handle"
          @pointerdown="vertexPointerDown($event, selectedWire, index)" @dblclick="vertexDoubleClick($event, selectedWire.id, index)">
          <circle :cx="pxX(point.x)" :cy="pxY(point.y)" r="11" fill="transparent" />
          <rect :x="pxX(point.x) - 5" :y="pxY(point.y) - 5" width="10" height="10" rx="2.5" class="vertex-box" />
          <title>拖动折点塑形 · 双击删除</title>
        </g>

        <!-- Slack apex handle -->
        <g v-if="selectedBay && selectedSlack > 0.02" class="wire-apex-handle" @pointerdown="apexPointerDown($event, selectedWire)">
          <rect :x="pxX(selectedBay.restApex.x) - 6" :y="pxY(selectedBay.restApex.y) - 6" width="12" height="12" rx="3"
            :transform="`rotate(45 ${pxX(selectedBay.restApex.x)} ${pxY(selectedBay.restApex.y)})`" class="apex-box" />
          <title>拖动调整松弛余量</title>
        </g>

        <!-- Two endpoints: dragging moves the anchored piece and re-checks the whole path -->
        <g class="wire-endpoint-handle" @pointerdown="endpointPointerDown($event, selectedWire, selectedWire.from)">
          <circle :cx="pxX(selectedNodes[0].x)" :cy="pxY(selectedNodes[0].y)" r="12" fill="transparent" />
          <circle :cx="pxX(selectedNodes[0].x)" :cy="pxY(selectedNodes[0].y)" r="6.5" class="endpoint-ring" />
          <circle :cx="pxX(selectedNodes[0].x)" :cy="pxY(selectedNodes[0].y)" r="2.4" class="endpoint-core" />
          <title>起点 · 拖动移动端点，松手复检整条路径</title>
        </g>
        <g class="wire-endpoint-handle" @pointerdown="endpointPointerDown($event, selectedWire, selectedWire.to)">
          <circle :cx="pxX(selectedNodes[selectedNodes.length - 1].x)" :cy="pxY(selectedNodes[selectedNodes.length - 1].y)" r="12" fill="transparent" />
          <circle :cx="pxX(selectedNodes[selectedNodes.length - 1].x)" :cy="pxY(selectedNodes[selectedNodes.length - 1].y)" r="6.5" class="endpoint-ring" />
          <circle :cx="pxX(selectedNodes[selectedNodes.length - 1].x)" :cy="pxY(selectedNodes[selectedNodes.length - 1].y)" r="2.4" class="endpoint-core" />
          <title>终点 · 拖到障碍上会被拦截并保留原连接</title>
        </g>
      </g>

      <!-- Simulation / replay wire action layer -->
      <g v-if="run" class="wire-fx-layer" pointer-events="none">
        <g v-for="fx in fxList" :key="`fx-${fx.connectionId}`">
          <path v-if="fxState(fx) === 'sweep'" :d="fxTrailD(fx)" class="wire-sweep-trail" fill="none" />
          <path :d="fxD(fx)" :class="['wire-fx-cord', fxState(fx)]"
            :style="fxState(fx) === 'done' ? { opacity: fxDoneOpacity(fx) } : undefined" fill="none" />
          <circle v-for="(hit, i) in fx.hits.filter(hit => hitVisible(hit.time))" :key="`hit-${i}`"
            :cx="pxX(hit.at.x)" :cy="pxY(hit.at.y)" r="4.5" class="wire-hit-spark" />
          <circle v-if="fxPulse(fx) && fxState(fx) === 'taut'"
            :cx="pxX(fxPulse(fx)!.x)" :cy="pxY(fxPulse(fx)!.y)" r="4.2" class="wire-pull-pulse" />
          <circle v-if="flashRadius(fx.arrival) > 0" :cx="pxX(fx.nodes[fx.nodes.length - 1].x)" :cy="pxY(fx.nodes[fx.nodes.length - 1].y)"
            :r="flashRadius(fx.arrival)" :opacity="flashOpacity(fx.arrival)" class="wire-arrival-flash" fill="none" />
        </g>
      </g>

      <!-- Conflict markers: live validation + stored rejection -->
      <g class="conflict-layer" pointer-events="none">
        <g v-for="(conflict, index) in liveMarkers" :key="`live-${markerKey(conflict, index)}`">
          <circle :cx="pxX(conflict.at.x)" :cy="pxY(conflict.at.y)" r="9" class="conflict-badge live" />
          <text :x="pxX(conflict.at.x)" :y="pxY(conflict.at.y) + 3.6" text-anchor="middle" class="conflict-mark">!</text>
        </g>
        <g v-if="conflict" :key="'stored-' + conflict.nonce">
          <g v-for="(item, index) in storedMarkers" :key="'stored-' + markerKey(item, index)">
            <circle :cx="pxX(item.at.x)" :cy="pxY(item.at.y)" r="11" class="conflict-badge stored" />
            <circle :cx="pxX(item.at.x)" :cy="pxY(item.at.y)" r="16" class="conflict-ring" />
            <text :x="pxX(item.at.x)" :y="pxY(item.at.y) + 4" text-anchor="middle" class="conflict-mark">!</text>
          </g>
        </g>
      </g>

      <g v-if="focusPieceId" class="focus-reticle" pointer-events="none">
        <circle :cx="pxX(pieceById(focusPieceId)?.x ?? 0)" :cy="pxY(pieceById(focusPieceId)?.y ?? 0)" r="25" />
        <circle :cx="pxX(pieceById(focusPieceId)?.x ?? 0)" :cy="pxY(pieceById(focusPieceId)?.y ?? 0)" r="32" />
      </g>
      <g class="board-scale" pointer-events="none"><path d="M 0 0 H 80 M 0 0 V -5 M 80 0 V -5" /><text x="40" y="15" text-anchor="middle">2 M</text></g>
    </svg>
    <div class="stage-footer"><span><Crosshair :size="13" /> 桌面定位 · 金线绕开立牌与卡扣</span><span>拖动摆放 <kbd>↑ ↓ ← →</kbd> 微调 <kbd>Shift</kbd> 加速</span></div>
  </section>
</template>
