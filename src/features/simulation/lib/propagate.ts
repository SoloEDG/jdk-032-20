import type { DominoDocument, Piece, SimulationEvent, WireEffect } from '@/shared/document'
import { nextContact } from '@/features/layout/lib/geometry'
import { createWireEffect } from '@/features/mechanisms/lib/wire'

interface Scheduled {
  pieceId: string
  time: number
  causeId: string | null
  detail: string
  viaWire?: string
  wireAction?: 'sweep' | 'pull'
  topple?: number
}

export function propagate(document: DominoDocument) {
  const queue: Scheduled[] = [{ pieceId: document.startPieceId, time: 0, causeId: null, detail: '手动触发' }]
  const fallen = new Set<string>()
  const events: SimulationEvent[] = []
  const wireEffects: WireEffect[] = []
  let interruptedPieceId: string | null = null
  let interruptionReason: string | null = null
  let reachedTrigger = false

  /**
   * A wire only acts after its slack whip has played out: the slack strand
   * sweeps dominoes along the way, then the cord goes taut and the far
   * endpoint is scheduled. Geometry is snapshotted into a WireEffect so the
   * replay can redraw the exact sweep.
   */
  function dispatchWires(source: Piece, sourceEvent: SimulationEvent, time: number) {
    for (const link of document.connections.filter(item => item.from === source.id && item.enabled)) {
      const effect = createWireEffect(link, document.pieces, time)
      if (effect) wireEffects.push(effect)
      for (const hit of effect?.hits ?? []) {
        queue.push({
          pieceId: hit.pieceId, time: hit.time, causeId: sourceEvent.id,
          detail: '松弛段扫击', viaWire: link.id, wireAction: 'sweep', topple: hit.topple,
        })
      }
      queue.push({
        pieceId: link.to, time: (effect?.arrival ?? time + link.delay), causeId: sourceEvent.id,
        detail: effect && effect.sweepDuration > 0.02 ? '拉线拉紧后传动' : '机关连线',
        viaWire: link.id, wireAction: 'pull',
      })
    }
  }

  const eventCap = Math.max(80, document.pieces.length * 6 + document.connections.length * 6)

  while (queue.length && events.length < eventCap) {
    queue.sort((a, b) => a.time - b.time || a.pieceId.localeCompare(b.pieceId) || (a.causeId ?? '').localeCompare(b.causeId ?? ''))
    const next = queue.shift()!
    const piece = document.pieces.find(item => item.id === next.pieceId)
    if (!piece || fallen.has(piece.id)) continue

    if (piece.kind === 'trigger') {
      const event: SimulationEvent = {
        id: `event-${events.length + 1}`, pieceId: piece.id, time: next.time,
        causeId: next.causeId, kind: 'mechanism',
        detail: next.viaWire ? `触发器响应 · ${next.detail}` : `触发器响应 · ${next.detail}`,
        wireId: next.viaWire,
      }
      events.push(event)
      reachedTrigger = true
      dispatchWires(piece, event, next.time)
      continue
    }

    fallen.add(piece.id)
    const event: SimulationEvent = {
      id: `event-${events.length + 1}`, pieceId: piece.id, time: next.time,
      causeId: next.causeId,
      kind: piece.kind === 'splitter' ? 'mechanism' : 'fall',
      detail: piece.kind === 'splitter' ? `分岔展开 · ${next.detail}`
        : piece.kind === 'ramp' ? `坡道传递 · ${next.detail}`
        : next.wireAction === 'sweep' ? `拉线扫倒 · ${next.detail}`
        : `受力倒下 · ${next.detail}`,
      wireId: next.viaWire,
      topple: next.topple,
    }
    events.push(event)

    dispatchWires(piece, event, next.time)

    const available = document.pieces.filter(item => !fallen.has(item.id) && item.id !== piece.id)
    const surfaceGrip = (document.scene.friction + piece.friction) / 2
    const reachScale = (0.94 + surfaceGrip * 0.35) * (1.25 - piece.fallThreshold * 0.25)
    let target: Piece | null = null
    if (piece.kind === 'ramp') {
      target = available.filter(item => item.x > piece.x && Math.abs(item.y - piece.y) < 2.1)
        .sort((a, b) => a.x - b.x || a.id.localeCompare(b.id))[0] ?? null
    } else {
      target = nextContact(piece, available, reachScale)
    }
    if (target) {
      const separation = Math.hypot(piece.x - target.x, piece.y - target.y)
      const speed = Math.max(1.8, piece.height * document.scene.gravity / 2) * (0.75 + surfaceGrip * 0.5)
      const travel = Math.max(0.24, separation / speed)
      queue.push({
        pieceId: target.id, time: next.time + travel, causeId: event.id,
        detail: piece.kind === 'splitter' ? '分岔臂接触' : piece.kind === 'ramp' ? '坡面末端接触' : '相邻接触',
      })
    }

    const hasConnection = document.connections.some(link => link.from === piece.id && link.enabled)
    // A domino swept away by a slack strand is a collateral effect: if it
    // reaches nothing that is not a broken chain link and must not set the
    // interruption marker.
    if (!target && !hasConnection && next.wireAction !== 'sweep' && interruptedPieceId === null) {
      interruptedPieceId = piece.id
      interruptionReason = '倒下方向内没有可触达的元件，链路在此停止。'
      events.push({
        id: `event-${events.length + 1}`, pieceId: piece.id, time: next.time + 0.05,
        causeId: event.id, kind: 'interrupted', detail: interruptionReason,
      })
    }
  }

  return {
    events,
    wireEffects,
    interruptedPieceId,
    interruptionReason,
    reachedTrigger,
    status: events.length === 0 ? 'empty' as const
      : interruptedPieceId || !reachedTrigger ? 'interrupted' as const : 'complete' as const,
    duration: events.at(-1)?.time ?? 0,
  }
}
