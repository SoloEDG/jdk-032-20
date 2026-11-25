import { computed, ref, type Ref } from 'vue'
import type { DominoDocument, Vec2, WireConflictState } from '@/shared/document'
import { addConnection, removeConnection, createConnection } from '../lib/connections'
import {
  autoRoute, buildWireObstacles, chooseSlackSide, evaluatePieceMove, roundedWorld,
  validateWire, wireNodes,
} from '../lib/wire'

export function useMechanisms(document: Ref<DominoDocument>, changed: () => void) {
  const fromId = ref('')
  const toId = ref('')
  const message = ref('')
  const messageTone = ref<'ok' | 'error'>('ok')
  // The showcase cord is selected on first load so the tabletop pull-string
  // construction (endpoints / bends / slack bay) is immediately visible.
  const selectedWireId = ref<string | null>('c3')
  const conflict = ref<WireConflictState | null>(null)

  const availableFrom = computed(() => document.value.pieces)
  const availableTo = computed(() => document.value.pieces.filter(piece => piece.id !== fromId.value))
  const selectedWire = computed(() =>
    document.value.connections.find(link => link.id === selectedWireId.value) ?? null)

  function note(text: string, tone: 'ok' | 'error' = 'ok') {
    message.value = text
    messageTone.value = tone
  }

  function selectWire(id: string | null) {
    selectedWireId.value = id
    if (id) conflict.value = null
  }

  function clearConflict() { conflict.value = null }

  function add() {
    if (!fromId.value || !toId.value) return
    if (document.value.connections.some(link => link.from === fromId.value && link.to === toId.value)) {
      note('这两个元件已经连接。', 'error')
      return
    }
    const wire = createConnection(document.value, fromId.value, toId.value)
    document.value = { ...document.value, connections: [...document.value.connections, wire] }
    selectedWireId.value = wire.id
    conflict.value = null
    changed()
    const issues = validateWire(wire, document.value.pieces)
    note(issues.length === 0
      ? '拉线已添加，并已绕开立起的骨牌与坡道卡扣。'
      : '拉线已添加，但局部与障碍过近；请拖动折点或使用自动绕障。',
      issues.length === 0 ? 'ok' : 'error')
  }

  function remove(id: string) {
    document.value = removeConnection(document.value, id)
    if (selectedWireId.value === id) selectedWireId.value = null
    if (conflict.value?.wireId === id) conflict.value = null
    note('机关拉线已移除。')
    changed()
  }

  function toggle(id: string, enabled: boolean) {
    document.value = {
      ...document.value,
      connections: document.value.connections.map(link => link.id === id ? { ...link, enabled } : link),
    }
    changed()
  }

  function patchWire(id: string, patch: (wire: DominoDocument['connections'][number]) => DominoDocument['connections'][number]) {
    document.value = {
      ...document.value,
      connections: document.value.connections.map(link => link.id === id ? patch(link) : link),
    }
    changed()
  }

  function moveVertexLive(wireId: string, index: number, point: Vec2) {
    patchWire(wireId, wire => ({
      ...wire,
      waypoints: (wire.waypoints ?? []).map((item, i) => i === index ? roundedWorld(point) : item),
    }))
  }

  function addVertex(wireId: string, index: number, point: Vec2) {
    const insertAt = Math.max(0, index)
    patchWire(wireId, wire => {
      const waypoints = [...(wire.waypoints ?? [])]
      waypoints.splice(insertAt, 0, roundedWorld(point))
      // Splitting node segment `slackSegment` shifts later bay indices.
      let slackSegment = wire.slackSegment
      if (slackSegment !== undefined) {
        if (slackSegment > insertAt) slackSegment += 1
      }
      return { ...wire, waypoints, slackSegment }
    })
  }

  function removeVertex(wireId: string, index: number) {
    patchWire(wireId, wire => {
      const waypoints = (wire.waypoints ?? []).filter((_, i) => i !== index)
      let slackSegment = wire.slackSegment
      if (slackSegment !== undefined) {
        if (slackSegment === index || slackSegment === index + 1) slackSegment = index
        else if (slackSegment > index + 1) slackSegment -= 1
      }
      return { ...wire, waypoints, slackSegment: slackSegment && slackSegment < waypoints.length + 1 ? slackSegment : undefined }
    })
    note('折点已删除，整条路径已重新检查。')
  }

  function commitVertex(wireId: string, index: number, original: Vec2) {
    const wire = document.value.connections.find(link => link.id === wireId)
    if (!wire) return
    const issues = validateWire(wire, document.value.pieces)
    if (issues.length) {
      patchWire(wireId, item => ({
        ...item,
        waypoints: (item.waypoints ?? []).map((q, i) => i === index ? original : q),
      }))
      conflict.value = { wireId, message: issues[0].message, conflicts: issues, nonce: Date.now() }
      note(`折点会让拉线穿过障碍（${issues[0].message}），已弹回原折点。`, 'error')
      return
    }
    conflict.value = null
    note('折点已更新，整线复检无冲突。')
  }

  function setSlack(wireId: string, slack: number, side?: 1 | -1) {
    patchWire(wireId, wire => ({ ...wire, slack: Math.round(slack * 100) / 100, ...(side ? { slackSide: side } : {}) }))
  }

  let slackEditOrig: { slack?: number; slackSide?: 1 | -1 } | null = null
  function beginSlackEdit() {
    const wire = selectedWire.value
    if (!wire || slackEditOrig) return
    slackEditOrig = { slack: wire.slack, slackSide: wire.slackSide }
  }
  function updateSelectedSlack(slack: number) {
    if (selectedWireId.value) setSlack(selectedWireId.value, slack)
  }
  function commitSelectedSlack() {
    if (selectedWireId.value && slackEditOrig) commitSlack(selectedWireId.value, slackEditOrig)
    slackEditOrig = null
  }

  function commitSlack(wireId: string, original: { slack?: number; slackSide?: 1 | -1 }) {
    const wire = document.value.connections.find(link => link.id === wireId)
    if (!wire) return
    const issues = validateWire(wire, document.value.pieces)
    if (issues.some(issue => issue.part === 'slack')) {
      patchWire(wireId, item => ({ ...item, slack: original.slack, slackSide: original.slackSide }))
      conflict.value = { wireId, message: issues[0].message, conflicts: issues, nonce: Date.now() }
      note(`松弛环会扫进障碍物（${issues[0].message}），余量调整已弹回。`, 'error')
      return
    }
    conflict.value = null
    note('松弛余量已更新；模拟时该段会先扫掠再拉紧。')
  }

  /**
   * Endpoint drag / nudge commit. Re-validates every attached wire against
   * the whole table; on failure the piece (and therefore the endpoint) is
   * restored to its drag-start pose. The connection list — including every
   * neighbouring contact — is never rewritten.
   */
  function commitPieceMove(pieceId: string, original: Vec2) {
    const attached = document.value.connections.filter(link => link.from === pieceId || link.to === pieceId)
    if (!attached.length) return
    const plan = evaluatePieceMove(document.value, pieceId,
      document.value.pieces.find(piece => piece.id === pieceId) ?? original)
    if (!plan.ok) {
      document.value = {
        ...document.value,
        pieces: document.value.pieces.map(piece => piece.id === pieceId ? { ...piece, ...original } : piece),
      }
      changed()
      conflict.value = {
        wireId: plan.wireId ?? attached[0].id, message: plan.reason,
        conflicts: plan.conflicts, nonce: Date.now(),
      }
      note(plan.reason, 'error')
      return
    }
    conflict.value = null
    note(plan.reason || '端点已移动，整条路径复检通过。')
  }

  function autoRouteSelected() {
    const wire = selectedWire.value
    if (!wire) return
    const from = document.value.pieces.find(piece => piece.id === wire.from)
    const to = document.value.pieces.find(piece => piece.id === wire.to)
    if (!from || !to) return
    const obstacles = buildWireObstacles(document.value.pieces)
    const ignore = new Set([wire.from, wire.to])
    const waypoints = autoRoute({ x: from.x, y: from.y }, { x: to.x, y: to.y }, {
      bounds: document.value.scene, obstacles, ignorePieceIds: ignore,
    })
    if (waypoints === null) {
      note('找不到不穿过障碍的绕行路径：端点可能压在站立的骨牌或卡扣上。原线路保留。', 'error')
      return
    }
    let next: typeof wire = { ...wire, waypoints }
    let side = chooseSlackSide(next, document.value.pieces)
    next = { ...next, slackSide: side }
    // If the slack loop cannot be kept clear at the current allowance, shrink
    // only the allowance (never the route) until the whole wire validates.
    for (const candidateSlack of [wire.slack ?? 0.7, 0.55, 0.35, 0]) {
      const trial = { ...next, slack: candidateSlack }
      if (validateWire(trial, document.value.pieces).length === 0) {
        next = trial
        break
      }
    }
    document.value = {
      ...document.value,
      connections: document.value.connections.map(link => link.id === wire.id ? next : link),
    }
    conflict.value = null
    changed()
    note(`已生成绕障路线（${waypoints.length} 个折点），整线复检通过。`)
  }

  /**
   * One-click, non-mutating demonstration of endpoint-move validation:
   * finds a standing piece that a candidate endpoint could not cross, proves
   * the planner rejects it, and reports a nearby clear candidate.
   */
  function endpointSelfCheck() {
    const wire = selectedWire.value
    if (!wire) {
      note('请先在列表或场景中选中一条拉线，再做端点自检。', 'error')
      return
    }
    const targetId = wire.to
    const endpoint = document.value.pieces.find(piece => piece.id === targetId)
    if (!endpoint) return
    // Prefer the nearest blocking piece so the demonstration marker stays
    // next to the endpoint / fork arms rather than at the far chain start.
    const blocker = document.value.pieces
      .filter(piece => piece.id !== wire.from && piece.id !== wire.to)
      .map(piece => ({ piece, plan: evaluatePieceMove(document.value, targetId, { x: piece.x, y: piece.y }) }))
      .filter(entry => !entry.plan.ok)
      .sort((a, b) => Math.hypot(a.piece.x - endpoint.x, a.piece.y - endpoint.y)
        - Math.hypot(b.piece.x - endpoint.x, b.piece.y - endpoint.y))[0]
    if (!blocker) {
      note('当前桌面没有可用于冲突演示的障碍；试着把一条线的端点拖到站立骨牌上。')
      return
    }
    // Search a small ring for a clear candidate to show the pass path too.
    let clearSpot: Vec2 | null = null
    for (const radius of [0.8, 1.2, 1.7]) {
      for (let i = 0; i < 12; i += 1) {
        const angle = i / 12 * Math.PI * 2
        const candidate = { x: endpoint.x + Math.cos(angle) * radius, y: endpoint.y + Math.sin(angle) * radius }
        if (evaluatePieceMove(document.value, targetId, candidate).ok) { clearSpot = candidate; break }
      }
      if (clearSpot) break
    }
    conflict.value = {
      wireId: wire.id, message: blocker.plan.reason, conflicts: blocker.plan.conflicts, nonce: Date.now(),
    }
    note(`【端点自检】若把端点移到「${blocker.piece.label}」处会被拦截并弹回，原连接与相邻触点全部保留。`
      + (clearSpot ? ` 移到 (${clearSpot.x.toFixed(1)}, ${clearSpot.y.toFixed(1)}) 一带则复检通过。` : ''), 'error')
  }

  return {
    fromId, toId, message, messageTone, selectedWireId, selectedWire, conflict,
    availableFrom, availableTo,
    selectWire, clearConflict, add, remove, toggle,
    moveVertexLive, addVertex, removeVertex, commitVertex,
    setSlack, commitSlack, beginSlackEdit, updateSelectedSlack, commitSelectedSlack,
    commitPieceMove, autoRouteSelected, endpointSelfCheck,
    wireNodesFor: (wireId: string) => {
      const wire = document.value.connections.find(link => link.id === wireId)
      return wire ? wireNodes(wire, document.value.pieces) : []
    },
  }
}
