import type { DominoDocument, Piece } from './document'

const domino = (id: string, x: number, y: number, angle: number, label: string): Piece => ({
  id, kind: 'domino', x, y, angle, facing: 'east', label, height: 1.6, width: 0.42,
  fallThreshold: 0.8, friction: 0.55,
})

export function createDefaultDocument(): DominoDocument {
  const pieces: Piece[] = [
    domino('d1', 2, 4.2, 0, '起点'),
    domino('d2', 3.6, 4.2, 0, '03'),
    domino('d3', 5.2, 4.2, 0, '04'),
    domino('d4', 6.8, 4.2, 0, '05'),
    domino('d5', 8.4, 4.2, 0, '06'),
    { ...domino('r1', 10.2, 4.2, 0, '上坡'), kind: 'ramp', width: 1.7, height: 0.45 },
    domino('d6', 12.1, 3.55, -20, '08'),
    { ...domino('s1', 13.7, 3.15, 20, '分岔'), kind: 'splitter', width: 0.75 },
    domino('d7', 15.2, 2.3, 0, '10'),
    domino('d8', 16.8, 2.3, 0, '11'),
    domino('d9', 15.2, 4.05, 0, '12'),
    domino('d10', 16.8, 4.05, 0, '13'),
    { ...domino('t1', 18.4, 2.3, 0, '终点 A'), kind: 'trigger', width: 0.7 },
    // Edge domino sitting inside the slack whip fan of the long pull-wire.
    domino('dEdge', 19.95, 3.3, 0, '边缘牌'),
    { ...domino('t2', 13.3, 1.5, 0, '侧绕铃'), kind: 'trigger', width: 0.7 },
  ]
  return {
    id: 'chainline-starter',
    title: '逆风转角 · 拉线',
    revision: 1,
    updatedAt: Date.now(),
    pieces,
    connections: [
      { id: 'c1', from: 's1', to: 'd7', delay: 0.15, enabled: true },
      { id: 'c2', from: 's1', to: 'd9', delay: 0.15, enabled: true },
      {
        // Long cord from the lower fork arm, around the outer tips of BOTH
        // arms, up the table edge and back to the side bell. The vertical
        // node pair hosts the slack bay that sweeps the edge domino.
        id: 'c3', from: 'd10', to: 't2', delay: 0.15, enabled: true,
        waypoints: [
          { x: 17.7, y: 4.85 },
          { x: 19.2, y: 5.35 },
          { x: 19.2, y: 1.15 },
        ],
        slack: 1.15, slackSide: 1, slackSegment: 2,
      },
    ],
    scene: { gravity: 9.8, friction: 0.62, width: 21, height: 9, showGrid: true },
    startPieceId: 'd1',
  }
}
