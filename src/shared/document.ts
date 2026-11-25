export type PieceKind = 'domino' | 'ramp' | 'splitter' | 'trigger'
export type Axis = 'north' | 'east' | 'south' | 'west'

export interface Vec2 { x: number; y: number }

export interface Piece {
  id: string
  kind: PieceKind
  x: number
  y: number
  angle: number
  facing: Axis
  label: string
  height: number
  width: number
  fallThreshold: number
  friction: number
}

export interface MechanismConnection {
  id: string
  from: string
  to: string
  delay: number
  enabled: boolean
  /** Editable bend vertices in tabletop world coordinates. */
  waypoints?: Vec2[]
  /** Extra cord length reserved as slack (world units). The slack bay bulges into a loop. */
  slack?: number
  /** Which side of the slack segment the rest loop bulges toward. */
  slackSide?: 1 | -1
  /** Explicit node-pair index hosting the slack bay; defaults to the longest segment. */
  slackSegment?: number
}

export interface WireConflict {
  /** Node-pair index of the polyline segment that crosses an obstacle. */
  segmentIndex: number
  /** 'route' is a fixed path segment, 'slack' is the resting slack loop. */
  part: 'route' | 'slack'
  obstacleId: string
  pieceId: string
  label: string
  /** Closest world point on the blocking obstacle. */
  at: Vec2
  message: string
}

/** A rejected endpoint/vertex commit kept on screen until the next edit. */
export interface WireConflictState {
  wireId: string
  message: string
  conflicts: WireConflict[]
  nonce: number
}

export interface WireSweepHit {
  pieceId: string
  /** 0..1 through the whip animation. */
  progress: number
  /** Simulation time at which the strand first touches the domino. */
  time: number
  at: Vec2
  /** Signed topple direction in degrees in the piece's local frame. */
  topple: number
}

export interface WireEffect {
  connectionId: string
  fromPieceId: string
  toPieceId: string
  /** Source event time. */
  start: number
  /** Seconds needed to take up the slack. */
  sweepDuration: number
  /** Time at which the pull reaches the far endpoint (slack + mechanism delay). */
  arrival: number
  /** Full validated node polyline snapshot, world coordinates. */
  nodes: Vec2[]
  slack: number
  slackSide: 1 | -1
  slackSegment: number
  hits: WireSweepHit[]
}

export interface SceneSettings {
  gravity: number
  friction: number
  width: number
  height: number
  showGrid: boolean
}

export interface DominoDocument {
  id: string
  title: string
  revision: number
  updatedAt: number
  pieces: Piece[]
  connections: MechanismConnection[]
  scene: SceneSettings
  startPieceId: string
}

export interface SimulationEvent {
  id: string
  pieceId: string
  time: number
  causeId: string | null
  kind: 'trigger' | 'fall' | 'mechanism' | 'interrupted'
  detail: string
  /** Set when the event is caused by a pull-wire (sweep or taut pull). */
  wireId?: string
  /** Signed topple angle (degrees, piece-local) for fall playback. */
  topple?: number
}

export interface SimulationRun {
  id: string
  documentId: string
  revision: number
  startedAt: number
  startPieceId: string
  status: 'complete' | 'interrupted' | 'empty'
  events: SimulationEvent[]
  interruptedPieceId: string | null
  interruptionReason: string | null
  duration: number
  /** Per-wire slack/sweep/taut geometry used by simulation and replay rendering. */
  wireEffects: WireEffect[]
}
