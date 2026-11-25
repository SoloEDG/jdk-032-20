import type { DominoDocument, MechanismConnection } from '@/shared/document'
import { stableId } from '@/shared/time'
import { autoRoute, buildWireObstacles, NEW_WIRE_SLACK } from './wire'

export function availableTargets(document: DominoDocument, from: string) {
  const used = new Set(document.connections.filter(link => link.from === from).map(link => link.to))
  return document.pieces.filter(piece => piece.id !== from && !used.has(piece.id))
}

/** Build a pull-wire with an initial obstacle-free route when one exists. */
export function createConnection(document: DominoDocument, from: string, to: string): MechanismConnection {
  const fromPiece = document.pieces.find(piece => piece.id === from)
  const toPiece = document.pieces.find(piece => piece.id === to)
  const id = stableId('wire')
  const base: MechanismConnection = { id, from, to, delay: 0.15, enabled: true, slack: NEW_WIRE_SLACK, waypoints: [] }
  if (!fromPiece || !toPiece) return base
  const obstacles = buildWireObstacles(document.pieces)
  const ignorePieceIds = new Set([from, to])
  const waypoints = autoRoute({ x: fromPiece.x, y: fromPiece.y }, { x: toPiece.x, y: toPiece.y }, {
    bounds: document.scene, obstacles, ignorePieceIds,
  })
  return { ...base, waypoints: waypoints ?? [] }
}

export function addConnection(document: DominoDocument, from: string, to: string): DominoDocument {
  if (!document.pieces.some(piece => piece.id === from) || !document.pieces.some(piece => piece.id === to)) return document
  if (document.connections.some(link => link.from === from && link.to === to)) return document
  const connection = createConnection(document, from, to)
  return { ...document, connections: [...document.connections, connection] }
}

export function removeConnection(document: DominoDocument, id: string): DominoDocument {
  return { ...document, connections: document.connections.filter(link => link.id !== id) }
}
