import type {
  DominoDocument, MechanismConnection, Piece, Vec2, WireConflict, WireEffect, WireSweepHit,
} from '@/shared/document'

/** Extra berth around every obstacle, in world units. */
export const WIRE_CLEARANCE = 0.18
/** How close the moving strand has to get to a domino centre to knock it. */
export const SWEEP_TOUCH_RADIUS = 0.32
/** Slack assigned to newly drawn pull-wires. Seeded graph links stay taut unless explicit. */
export const NEW_WIRE_SLACK = 0.7
export const MAX_SLACK = 2.2

/** Explicit slack; legacy/plain links without the field are taut graph wires. */
export function wireSlack(wire: MechanismConnection): number {
  return wire.slack ?? 0
}

export interface WireObstacle {
  id: string
  pieceId: string
  label: string
  kind: Piece['kind'] | 'ramp-clip' | 'splitter-arm'
  /** Capsule segment; circles are represented with a === b. */
  a: Vec2
  b: Vec2
  r: number
}

export function v(x: number, y: number): Vec2 { return { x, y } }
export function add(a: Vec2, b: Vec2): Vec2 { return { x: a.x + b.x, y: a.y + b.y } }
export function sub(a: Vec2, b: Vec2): Vec2 { return { x: a.x - b.x, y: a.y - b.y } }
export function scale(a: Vec2, k: number): Vec2 { return { x: a.x * k, y: a.y * k } }
export function dot(a: Vec2, b: Vec2): number { return a.x * b.x + a.y * b.y }
export function len(a: Vec2): number { return Math.hypot(a.x, a.y) }
export function dist(a: Vec2, b: Vec2): number { return Math.hypot(a.x - b.x, a.y - b.y) }

export function roundedWorld(point: Vec2): Vec2 {
  return { x: Math.round(point.x * 100) / 100, y: Math.round(point.y * 100) / 100 }
}

export function pieceAnchor(piece: Piece | undefined): Vec2 {
  return piece ? { x: piece.x, y: piece.y } : { x: 0, y: 0 }
}

/** Full node polyline: endpoint, editable bends, endpoint. */
export function wireNodes(wire: MechanismConnection, pieces: readonly Piece[]): Vec2[] {
  const from = pieces.find(piece => piece.id === wire.from)
  const to = pieces.find(piece => piece.id === wire.to)
  if (!from || !to) return []
  return [pieceAnchor(from), ...(wire.waypoints ?? []).map(roundedWorld), pieceAnchor(to)]
}

function forward(piece: Piece): Vec2 {
  const radians = piece.angle * Math.PI / 180
  return { x: Math.cos(radians), y: Math.sin(radians) }
}

/**
 * Upright dominoes, ramp bodies + their clip buckles and splitter arms are all
 * obstacles a routed cord has to clear. Capsules keep the math uniform.
 */
export function buildWireObstacles(pieces: readonly Piece[]): WireObstacle[] {
  const obstacles: WireObstacle[] = []
  for (const piece of pieces) {
    const c = { x: piece.x, y: piece.y }
    const u = forward(piece)
    if (piece.kind === 'domino') {
      obstacles.push({ id: piece.id, pieceId: piece.id, label: piece.label, kind: 'domino', a: c, b: c, r: 0.34 })
    } else if (piece.kind === 'trigger') {
      obstacles.push({ id: piece.id, pieceId: piece.id, label: piece.label, kind: 'trigger', a: c, b: c, r: 0.42 })
    } else if (piece.kind === 'splitter') {
      obstacles.push({ id: piece.id, pieceId: piece.id, label: piece.label, kind: 'splitter', a: c, b: c, r: 0.55 })
    } else if (piece.kind === 'ramp') {
      obstacles.push({
        id: piece.id, pieceId: piece.id, label: piece.label, kind: 'ramp',
        a: { x: c.x - u.x * 0.8, y: c.y - u.y * 0.8 },
        b: { x: c.x + u.x * 0.8, y: c.y + u.y * 0.8 }, r: 0.46,
      })
      for (const [suffix, sign] of [['in', -1], ['out', 1]] as const) {
        const at = { x: c.x + u.x * 1.04 * sign, y: c.y + u.y * 1.04 * sign }
        obstacles.push({
          id: `${piece.id}-clip-${suffix}`, pieceId: piece.id, label: `${piece.label}卡扣`, kind: 'ramp-clip',
          a: at, b: at, r: 0.24,
        })
      }
    }
  }
  return obstacles
}

export function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const ab = sub(b, a)
  const denom = dot(ab, ab)
  if (denom < 1e-12) return { ...a }
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / denom))
  return { x: a.x + ab.x * t, y: a.y + ab.y * t }
}

export function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  return dist(p, closestOnSegment(p, a, b))
}

function orientation(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

function onSegment(a: Vec2, b: Vec2, p: Vec2): boolean {
  return Math.min(a.x, b.x) - 1e-9 <= p.x && p.x <= Math.max(a.x, b.x) + 1e-9
    && Math.min(a.y, b.y) - 1e-9 <= p.y && p.y <= Math.max(a.y, b.y) + 1e-9
}

export function segmentsIntersect(p1: Vec2, p2: Vec2, p3: Vec2, p4: Vec2): boolean {
  const d1 = orientation(p3, p4, p1)
  const d2 = orientation(p3, p4, p2)
  const d3 = orientation(p1, p2, p3)
  const d4 = orientation(p1, p2, p4)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true
  if (Math.abs(d1) < 1e-9 && onSegment(p3, p4, p1)) return true
  if (Math.abs(d2) < 1e-9 && onSegment(p3, p4, p2)) return true
  if (Math.abs(d3) < 1e-9 && onSegment(p1, p2, p3)) return true
  if (Math.abs(d4) < 1e-9 && onSegment(p1, p2, p4)) return true
  return false
}

/** Minimum distance between two capsules' centre segments. */
export function segmentSegmentDistance(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  if (segmentsIntersect(a, b, c, d)) return 0
  return Math.min(
    pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b),
  )
}

function segmentHitsObstacle(a: Vec2, b: Vec2, obstacle: WireObstacle): boolean {
  return segmentSegmentDistance(a, b, obstacle.a, obstacle.b) <= obstacle.r + WIRE_CLEARANCE
}

/** Closest approximate world point of an obstacle to a route segment (for markers). */
function conflictPoint(a: Vec2, b: Vec2, obstacle: WireObstacle): Vec2 {
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  const onObstacle = closestOnSegment(mid, obstacle.a, obstacle.b)
  const onRoute = closestOnSegment(onObstacle, a, b)
  // Marker sits on the obstacle edge facing the route.
  const away = sub(onObstacle, onRoute)
  const d = len(away)
  if (d < 1e-6) return onObstacle
  return { x: onObstacle.x - away.x / d * obstacle.r, y: onObstacle.y - away.y / d * obstacle.r }
}

/** Test every polyline segment against obstacles (endpoint pieces ignored). */
export function validateNodes(
  nodes: readonly Vec2[],
  obstacles: readonly WireObstacle[],
  ignorePieceIds: ReadonlySet<string> = new Set(),
): WireConflict[] {
  const conflicts: WireConflict[] = []
  if (nodes.length < 2) return conflicts
  for (let i = 0; i < nodes.length - 1; i += 1) {
    const a = nodes[i]
    const b = nodes[i + 1]
    for (const obstacle of obstacles) {
      if (ignorePieceIds.has(obstacle.pieceId)) continue
      if (!segmentHitsObstacle(a, b, obstacle)) continue
      conflicts.push({
        segmentIndex: i, part: 'route', obstacleId: obstacle.id, pieceId: obstacle.pieceId,
        label: obstacle.label, at: conflictPoint(a, b, obstacle),
        message: `第 ${i + 1} 段穿过${obstacle.kind === 'ramp-clip' ? '坡道卡扣' : `「${obstacle.label}」`}`,
      })
    }
  }
  return conflicts
}

export interface SlackBay {
  index: number
  a: Vec2
  b: Vec2
  length: number
  u: Vec2
  normal: Vec2
  mid: Vec2
  side: 1 | -1
  height: number
  restApex: Vec2
}

export function slackHeightFor(length: number, slack: number): number {
  if (length < 1e-6) return 0
  const extra = Math.max(0, slack)
  return Math.sqrt(Math.max(0, (length + extra) ** 2 - length ** 2)) / 2
}

export function resolveSlackBay(
  nodes: readonly Vec2[], slack: number, side: 1 | -1 = 1, explicit?: number,
): SlackBay | null {
  if (nodes.length < 2) return null
  let index = -1
  if (explicit !== undefined && explicit >= 0 && explicit < nodes.length - 1) index = explicit
  if (index < 0) {
    let best = -1
    for (let i = 0; i < nodes.length - 1; i += 1) {
      const l = dist(nodes[i], nodes[i + 1])
      if (l > best) { best = l; index = i }
    }
  }
  if (index < 0) return null
  const a = nodes[index]
  const b = nodes[index + 1]
  const length = dist(a, b)
  if (length < 1e-6) return null
  const u = scale(sub(b, a), 1 / length)
  const normal = { x: -u.y, y: u.x }
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  const height = slackHeightFor(length, slack)
  return {
    index, a, b, length, u, normal, mid, side, height,
    restApex: { x: mid.x + normal.x * side * height, y: mid.y + normal.y * side * height },
  }
}

/** Keyframed whip: rest loop -> straight -> lash through to the far side -> settle. */
function whipFactor(progress: number): number {
  const p = Math.max(0, Math.min(1, progress))
  const keys: Array<[number, number]> = [[0, 1], [0.42, 0], [0.78, -0.32], [1, 0]]
  for (let i = 0; i < keys.length - 1; i += 1) {
    const [p0, k0] = keys[i]
    const [p1, k1] = keys[i + 1]
    if (p <= p1) {
      const t = p1 === p0 ? 0 : (p - p0) / (p1 - p0)
      return k0 + (k1 - k0) * t
    }
  }
  return 0
}

export function apexAt(bay: SlackBay, progress: number): Vec2 {
  const k = whipFactor(progress)
  const offset = bay.side * bay.height * k
  return { x: bay.mid.x + bay.normal.x * offset, y: bay.mid.y + bay.normal.y * offset }
}

/** Convert a dragged apex position into slack length + bulge side. */
export function slackFromApexPoint(bay: SlackBay, point: Vec2): { slack: number; side: 1 | -1 } {
  const signed = dot(sub(point, bay.mid), bay.normal)
  const side: 1 | -1 = signed < 0 ? -1 : 1
  const h = Math.abs(signed)
  const slack = Math.max(0, Math.min(MAX_SLACK, 2 * Math.sqrt((bay.length / 2) ** 2 + h ** 2) - bay.length))
  return { slack: Math.round(slack * 100) / 100, side }
}

export function sweepSeconds(slack: number): number {
  const s = Math.max(0, slack)
  if (s <= 0.02) return 0
  return Math.round((0.26 + s * 0.4) * 100) / 100
}

/** Validate fixed route plus the resting slack loop against obstacles. */
export function validateWire(wire: MechanismConnection, pieces: readonly Piece[]): WireConflict[] {
  const nodes = wireNodes(wire, pieces)
  if (nodes.length < 2) return []
  const ignore = new Set([wire.from, wire.to])
  const obstacles = buildWireObstacles(pieces)
  const conflicts = validateNodes(nodes, obstacles, ignore)
  const slack = wireSlack(wire)
  if (slack > 0.02) {
    const bay = resolveSlackBay(nodes, slack, wire.slackSide ?? 1, wire.slackSegment)
    if (bay && bay.height > 0.05) {
      for (const [a, b] of [[bay.a, bay.restApex], [bay.restApex, bay.b]] as const) {
        for (const obstacle of obstacles) {
          if (ignore.has(obstacle.pieceId)) continue
          if (!segmentHitsObstacle(a, b, obstacle)) continue
          conflicts.push({
            segmentIndex: bay.index, part: 'slack', obstacleId: obstacle.id, pieceId: obstacle.pieceId,
            label: obstacle.label, at: conflictPoint(a, b, obstacle),
            message: `松弛环会压住「${obstacle.label}」`,
          })
        }
      }
    }
  }
  return conflicts
}

function computeSweepHits(
  wire: MechanismConnection, pieces: readonly Piece[], nodes: readonly Vec2[],
): WireSweepHit[] {
  const slack = wireSlack(wire)
  const bay = resolveSlackBay(nodes, slack, wire.slackSide ?? 1, wire.slackSegment)
  if (!bay || bay.height < 0.05) return []
  const excluded = new Set([wire.from, wire.to])
  const candidates = pieces.filter(piece => piece.kind === 'domino' && !excluded.has(piece.id))
  const STEPS = 64
  const hits: WireSweepHit[] = []
  for (const piece of candidates) {
    const center = { x: piece.x, y: piece.y }
    let found: { progress: number; at: Vec2 } | null = null
    for (let step = 0; step <= STEPS; step += 1) {
      const progress = step / STEPS
      const apex = apexAt(bay, progress)
      const d1 = pointSegmentDistance(center, bay.a, apex)
      const d2 = pointSegmentDistance(center, apex, bay.b)
      const nearest = d1 <= d2
        ? closestOnSegment(center, bay.a, apex)
        : closestOnSegment(center, apex, bay.b)
      if (Math.min(d1, d2) <= SWEEP_TOUCH_RADIUS) {
        found = { progress, at: nearest }
        break
      }
    }
    if (!found) continue
    // Push direction: from the touching strand into the domino centre,
    // expressed in the domino's local frame to pick a topple sign.
    const push = sub(center, found.at)
    const radians = piece.angle * Math.PI / 180
    const localX = push.x * Math.cos(radians) + push.y * Math.sin(radians)
    const topple = (Math.abs(localX) < 0.08 ? (wire.slackSide ?? 1) : Math.sign(localX)) * 74
    hits.push({
      pieceId: piece.id, progress: found.progress, time: 0,
      at: roundedWorld(found.at), topple,
    })
  }
  hits.sort((a, b) => a.progress - b.progress || a.pieceId.localeCompare(b.pieceId))
  return hits
}

/** Build the deterministic sweep/taut effect record for one wire firing. */
export function createWireEffect(
  wire: MechanismConnection, pieces: readonly Piece[], start: number,
): WireEffect | null {
  const nodes = wireNodes(wire, pieces)
  if (nodes.length < 2) return null
  const slack = wireSlack(wire)
  const side = wire.slackSide ?? 1
  const duration = sweepSeconds(slack)
  const delay = wire.delay ?? 0.15
  const hits = computeSweepHits(wire, pieces, nodes).map(hit => ({
    ...hit,
    time: Math.round((start + hit.progress * duration) * 1000) / 1000,
  }))
  const bay = resolveSlackBay(nodes, slack, side, wire.slackSegment)
  return {
    connectionId: wire.id,
    fromPieceId: wire.from,
    toPieceId: wire.to,
    start: Math.round(start * 1000) / 1000,
    sweepDuration: duration,
    arrival: Math.round((start + duration + delay) * 1000) / 1000,
    nodes: nodes.map(roundedWorld),
    slack, slackSide: side,
    slackSegment: bay?.index ?? wire.slackSegment ?? -1,
    hits,
  }
}

export type WirePoseState = 'pending' | 'wind' | 'sweep' | 'taut' | 'done'

export interface WirePose {
  state: WirePoseState
  progress: number
  apex?: Vec2
  pulse?: Vec2
  tautFraction: number
}

function pointAlongPolyline(nodes: readonly Vec2[], fraction: number): Vec2 | undefined {
  if (nodes.length < 2) return nodes[0]
  const total = nodes.slice(1).reduce((sum, p, i) => sum + dist(p, nodes[i]), 0)
  let remaining = Math.max(0, Math.min(1, fraction)) * total
  for (let i = 0; i < nodes.length - 1; i += 1) {
    const a = nodes[i]
    const b = nodes[i + 1]
    const l = dist(a, b)
    if (remaining <= l || i === nodes.length - 2) {
      const t = l < 1e-9 ? 0 : Math.min(1, remaining / l)
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    }
    remaining -= l
  }
  return nodes[nodes.length - 1]
}

/** Pure time -> wire pose, shared by simulation visuals and replay scrubbing. */
export function wirePoseAt(fx: WireEffect, time: number): WirePose {
  const bay = resolveSlackBay(fx.nodes, fx.slack, fx.slackSide, fx.slackSegment)
  if (time < fx.start - 0.25) return { state: 'pending', progress: 0, tautFraction: 0, apex: bay?.restApex }
  if (time < fx.start) return { state: 'wind', progress: 0, tautFraction: 0, apex: bay?.restApex }
  if (time < fx.start + fx.sweepDuration) {
    const progress = (time - fx.start) / fx.sweepDuration
    return { state: 'sweep', progress, tautFraction: 0, apex: bay ? apexAt(bay, progress) : undefined }
  }
  const delay = Math.max(0.001, fx.arrival - fx.start - fx.sweepDuration)
  const tautFraction = Math.max(0, Math.min(1, (time - fx.start - fx.sweepDuration) / delay))
  // Tension pulse runs from the slack bay toward the far endpoint.
  const tail = fx.slackSegment >= 0 ? fx.nodes.slice(fx.slackSegment + 1) : fx.nodes
  const pulse = pointAlongPolyline(tail, tautFraction)
  if (time < fx.arrival) return { state: 'taut', progress: 1, tautFraction, pulse }
  return { state: 'done', progress: 1, tautFraction: 1, pulse: fx.nodes[fx.nodes.length - 1] }
}

/* ------------------------------------------------------------------ */
/* Auto routing (grid A* + line-of-sight simplification)              */
/* ------------------------------------------------------------------ */

export interface RouteBounds { width: number; height: number }

export interface RouteOptions {
  bounds: RouteBounds
  obstacles: readonly WireObstacle[]
  ignorePieceIds: ReadonlySet<string>
  step?: number
}

function pointBlocked(
  p: Vec2, obstacles: readonly WireObstacle[], ignore: ReadonlySet<string>, inflate = 0,
): WireObstacle | null {
  for (const obstacle of obstacles) {
    if (ignore.has(obstacle.pieceId)) continue
    if (segmentSegmentDistance(p, p, obstacle.a, obstacle.b) <= obstacle.r + WIRE_CLEARANCE + inflate) {
      return obstacle
    }
  }
  return null
}

/**
 * Find an obstacle-free detour from start to goal. Returns null when the
 * endpoints themselves are embedded in an obstacle or no grid route exists —
 * callers must then keep the previous connection and report the conflict.
 */
export function autoRoute(start: Vec2, goal: Vec2, options: RouteOptions): Vec2[] | null {
  const step = options.step ?? 0.22
  const ignore = options.ignorePieceIds
  const obstacles = options.obstacles
  if (pointBlocked(start, obstacles, ignore)) return null
  if (pointBlocked(goal, obstacles, ignore)) return null

  const minX = 0.3
  const minY = 0.3
  const maxX = options.bounds.width - 0.3
  const maxY = options.bounds.height - 0.3
  const nx = Math.max(2, Math.floor((maxX - minX) / step))
  const ny = Math.max(2, Math.floor((maxY - minY) / step))
  const gx = (ix: number) => minX + ix * step
  const gy = (iy: number) => minY + iy * step
  const id = (ix: number, iy: number) => iy * (nx + 1) + ix
  const total = (nx + 1) * (ny + 1)

  const blocked = new Uint8Array(total)
  for (let iy = 0; iy <= ny; iy += 1) {
    for (let ix = 0; ix <= nx; ix += 1) {
      const p = { x: gx(ix), y: gy(iy) }
      // Slight inflation keeps grid centres honest; LOS checks use full clearance.
      if (pointBlocked(p, obstacles, ignore, step * 0.18)) blocked[id(ix, iy)] = 1
    }
  }

  const nearestFreeCell = (p: Vec2): { ix: number; iy: number } | null => {
    const cx = Math.max(0, Math.min(nx, Math.round((p.x - minX) / step)))
    const cy = Math.max(0, Math.min(ny, Math.round((p.y - minY) / step)))
    if (!blocked[id(cx, cy)]) return { ix: cx, iy: cy }
    for (let radius = 1; radius <= 10; radius += 1) {
      for (let dy = -radius; dy <= radius; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue
          const ix = cx + dx
          const iy = cy + dy
          if (ix < 0 || iy < 0 || ix > nx || iy > ny) continue
          if (!blocked[id(ix, iy)]) return { ix, iy }
        }
      }
    }
    return null
  }

  const s = nearestFreeCell(start)
  const g = nearestFreeCell(goal)
  if (!s || !g) return null

  // A* with binary-ish array buckets; grids are small (~4k cells).
  const open = new Set<number>([id(s.ix, s.iy)])
  const came = new Int32Array(total).fill(-1)
  const gScore = new Float64Array(total).fill(Infinity)
  const fScore = new Float64Array(total).fill(Infinity)
  const startId = id(s.ix, s.iy)
  const goalId = id(g.ix, g.iy)
  gScore[startId] = 0
  fScore[startId] = Math.hypot(s.ix - g.ix, s.iy - g.iy)

  const decode = (key: number) => ({ ix: key % (nx + 1), iy: Math.floor(key / (nx + 1)) })
  const neighbours: Array<[number, number, number]> = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
  ]

  let found = false
  let guard = 0
  while (open.size && guard < total * 4) {
    guard += 1
    let current = -1
    let best = Infinity
    for (const key of open) {
      if (fScore[key] < best) { best = fScore[key]; current = key }
    }
    if (current === goalId) { found = true; break }
    open.delete(current)
    const { ix, iy } = decode(current)
    for (const [dx, dy, cost] of neighbours) {
      const jx = ix + dx
      const jy = iy + dy
      if (jx < 0 || jy < 0 || jx > nx || jy > ny) continue
      const next = id(jx, jy)
      if (blocked[next]) continue
      // No corner cutting through diagonally touching obstacles.
      if (dx !== 0 && dy !== 0 && (blocked[id(ix + dx, iy)] || blocked[id(ix, iy + dy)])) continue
      const tentative = gScore[current] + cost * step
      if (tentative >= gScore[next]) continue
      came[next] = current
      gScore[next] = tentative
      fScore[next] = tentative + Math.hypot(jx - g.ix, jy - g.iy) * step
      open.add(next)
    }
  }
  if (!found) return null

  const cellPath: Vec2[] = []
  let cursor = goalId
  while (cursor !== -1) {
    const { ix, iy } = decode(cursor)
    cellPath.push({ x: gx(ix), y: gy(iy) })
    if (cursor === startId) break
    cursor = came[cursor]
  }
  cellPath.reverse()
  cellPath[0] = { ...start }
  cellPath[cellPath.length - 1] = { ...goal }

  // String-pull: keep only points that cannot be removed without a collision.
  const simplified: Vec2[] = [cellPath[0]]
  let anchor = 0
  while (anchor < cellPath.length - 1) {
    let farthest = anchor + 1
    for (let probe = cellPath.length - 1; probe > anchor + 1; probe -= 1) {
      if (validateNodes([cellPath[anchor], cellPath[probe]], obstacles, ignore).length === 0) {
        farthest = probe
        break
      }
    }
    simplified.push(cellPath[farthest])
    anchor = farthest
  }
  return simplified.slice(1, -1).map(roundedWorld)
}

/** Pick the slack side whose resting loop clears more obstacles. */
export function chooseSlackSide(
  wire: MechanismConnection, pieces: readonly Piece[],
): 1 | -1 {
  const score = (side: 1 | -1) => validateWire({ ...wire, slackSide: side }, pieces).length
  return score(1) <= score(-1) ? 1 : -1
}

/* ------------------------------------------------------------------ */
/* Endpoint-move commit planning                                       */
/* ------------------------------------------------------------------ */

export interface EndpointCommitPlan {
  ok: boolean
  wireId?: string
  reason: string
  conflicts: WireConflict[]
}

/**
 * Re-check every wire attached to a moved endpoint piece against the whole
 * table. Callers apply the candidate only when ok; otherwise the previous
 * document (connection list and neighbouring contacts included) must survive.
 */
export function evaluatePieceMove(
  document: DominoDocument, pieceId: string, candidate: Vec2,
): EndpointCommitPlan {
  const attached = document.connections.filter(wire => wire.from === pieceId || wire.to === pieceId)
  if (!attached.length) return { ok: true, reason: '', conflicts: [] }
  const pieces = document.pieces.map(piece => piece.id === pieceId ? { ...piece, ...roundedWorld(candidate) } : piece)
  for (const wire of attached) {
    const conflicts = validateWire(wire, pieces)
    if (conflicts.length) {
      const from = document.pieces.find(piece => piece.id === wire.from)
      const to = document.pieces.find(piece => piece.id === wire.to)
      return {
        ok: false, wireId: wire.id, conflicts,
        reason: `端点移动后整条拉线「${from?.label ?? wire.from} → ${to?.label ?? wire.to}」复检未过：${conflicts[0].message}。已保留原连接，相邻触点未改动。`,
      }
    }
  }
  return { ok: true, reason: '端点已移动，整条路径复检通过。', conflicts: [] }
}
