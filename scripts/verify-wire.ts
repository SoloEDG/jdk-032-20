/**
 * Deterministic verification for pull-wire routing, slack sweeping and
 * endpoint-move validation. Bundled + run by scripts/run-verify.mjs.
 */
import { createDefaultDocument } from '../src/shared/defaults'
import { propagate } from '../src/features/simulation/lib/propagate'
import {
  autoRoute, buildWireObstacles, createWireEffect, dist, evaluatePieceMove, validateWire,
  wireNodes, wirePoseAt,
} from '../src/features/mechanisms/lib/wire'
import type { DominoDocument } from '../src/shared/document'

let failures = 0
function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title: string) { console.log(`\n${title}`) }

const doc = createDefaultDocument()
const c3 = doc.connections.find(c => c.id === 'c3')!
check('demo document contains c3 pull-wire', Boolean(c3))

section('1. 一条绕过分岔两臂的线')
const conflicts = validateWire(c3, doc.pieces)
check('c3 whole path (route + resting slack loop) is obstacle-free', conflicts.length === 0,
  conflicts.map(c => c.message).join('; '))

const nodes = wireNodes(c3, doc.pieces)
const xs = nodes.map(n => n.x)
const ys = nodes.map(n => n.y)
check('route swings outside the right tips of both arms (x >= 19)', Math.max(...xs) >= 19)
check('route dips below the lower arm (y >= 5.2)', Math.max(...ys) >= 5.2)
check('route rises above the upper arm (y <= 1.3)', Math.min(...ys) <= 1.3)

// The un-routed straight chord must be exactly the kind of shortcut that
// punches through the upper fork arm — proving the detour is necessary.
const chordWire = { ...c3, waypoints: [] }
const chordConflicts = validateWire(chordWire, doc.pieces)
const upperArmIds = new Set(['d7', 'd8', 't1'])
const lowerArmIds = new Set(['d9'])
check('straight shortcut hits the upper fork arm',
  chordConflicts.some(c => upperArmIds.has(c.pieceId)),
  chordConflicts.map(c => c.pieceId).join(','))
check('authored detour avoids every fork-arm piece',
  !conflicts.some(c => upperArmIds.has(c.pieceId) || lowerArmIds.has(c.pieceId)))

section('2. 松弛段扫倒边缘牌，拉紧后才传动')
const effect = createWireEffect(c3, doc.pieces, 1)
check('wire effect built', Boolean(effect))
const sweptIds = effect!.hits.map(h => h.pieceId)
check('slack sweep hits exactly the edge domino',
  sweptIds.length === 1 && sweptIds[0] === 'dEdge', `hits=[${sweptIds.join(',')}]`)
const edgeHit = effect!.hits.find(h => h.pieceId === 'dEdge')!
check('edge domino is swept mid-whip (progress 0.05..0.9)',
  edgeHit.progress > 0.05 && edgeHit.progress < 0.9, `progress=${edgeHit.progress.toFixed(2)}`)
check('taut arrival is strictly after the sweep finishes',
  effect!.arrival > 1 + effect!.sweepDuration)

const run = propagate(doc)
const edgeFall = run.events.find(e => e.pieceId === 'dEdge' && e.kind === 'fall')
check('propagation records the edge domino fall with wire id + topple',
  Boolean(edgeFall) && edgeFall.wireId === 'c3' && typeof edgeFall.topple === 'number',
  JSON.stringify(edgeFall))
const t2Fire = run.events.find(e => e.pieceId === 't2' && e.kind === 'mechanism')
check('far trigger (侧绕铃) fires after the wire goes taut',
  Boolean(t2Fire) && t2Fire!.time >= effect!.arrival - 1e-6,
  `t2=${t2Fire?.time}, arrival=${effect!.arrival}`)
const d10Fall = run.events.find(e => e.pieceId === 'd10' && e.kind === 'fall')
check('wire starts from the lower-arm terminal domino d10', Boolean(d10Fall))
check('simulation reaches the trigger and completes', run.status === 'complete', run.interruptionReason ?? '')
check('run snapshot carries the wire effect for replay', run.wireEffects.some(fx => fx.connectionId === 'c3'))

// Replay pose is a pure function of time: during the sweep the apex moves and
// the edge domino event sits inside the sweep window.
const poseBefore = wirePoseAt(effect!, effect!.start - 0.1)
const poseSweep = wirePoseAt(effect!, effect!.start + effect!.sweepDuration * 0.5)
const poseTaut = wirePoseAt(effect!, effect!.start + effect!.sweepDuration + 0.05)
check('replay pose transitions wind -> sweep -> taut',
  poseBefore.state === 'wind' && poseSweep.state === 'sweep' && poseTaut.state === 'taut')
check('sweep apex actually travels',
  Boolean(poseSweep.apex) && dist(poseBefore.apex!, poseSweep.apex!) > 0.2)

section('3. 端点移动复检：非法移动保留原连接并指出冲突')
const beforeJson = JSON.stringify(doc)
const adjacentBefore = JSON.stringify(doc.connections.filter(c => c.id === 'c1' || c.id === 'c2'))

// 3a. Drop the far endpoint onto an upright upper-arm domino.
const bad = evaluatePieceMove(doc, 't2', { x: 15.2, y: 2.3 })
check('endpoint onto d7 is rejected', bad.ok === false && bad.conflicts.length > 0)
check('conflict names the blocking arm piece', bad.conflicts.some(c => c.pieceId === 'd7'),
  bad.conflicts.map(c => c.pieceId).join(','))
check('rejection message states the original connection is kept', bad.reason.includes('保留原连接'))
// Controller semantics: when !ok it must not apply the candidate. Document
// untouched here because evaluatePieceMove is pure; assert that explicitly.
check('pure planner does not mutate the document', JSON.stringify(doc) === beforeJson)
check('adjacent fork contacts c1/c2 survive untouched',
  JSON.stringify(doc.connections.filter(c => c.id === 'c1' || c.id === 'c2')) === adjacentBefore)
check('c1/c2 remain valid links',
  validateWire(doc.connections[0], doc.pieces).length === 0
  && validateWire(doc.connections[1], doc.pieces).length === 0)

// 3b. Move the endpoint to a clear tabletop spot: whole path re-check passes.
const good = evaluatePieceMove(doc, 't2', { x: 12.4, y: 1.9 })
check('endpoint to clear position passes full path re-check', good.ok, good.reason)

// 3c. Moving an endpoint into a sealed/obstacle-embedded goal makes the
//     auto-router return null too — "only through obstacles" case.
const obstacles = buildWireObstacles(doc.pieces)
const noRoute = autoRoute({ x: 13.3, y: 1.5 }, { x: 16.8, y: 2.3 }, {
  bounds: doc.scene, obstacles, ignorePieceIds: new Set(['t2', 't1']),
})
check('auto-router refuses a goal embedded in d8/t1 cluster', noRoute === null)
const detour = autoRoute({ x: 16.8, y: 4.05 }, { x: 13.3, y: 1.5 }, {
  bounds: doc.scene, obstacles, ignorePieceIds: new Set(['d10', 't2']),
})
check('auto-router finds a detour for the same endpoints in clear space',
  Array.isArray(detour) && detour.length >= 1)
if (detour) {
  const routed: DominoDocument['connections'][number] = { ...c3, waypoints: detour, slack: 0, slackSegment: undefined }
  check('auto-routed waypoints validate clean', validateWire(routed, doc.pieces).length === 0,
    validateWire(routed, doc.pieces).map(c => c.message).join('; '))
}

section('4. 确定性（模拟与回放可重复）')
const again = propagate(createDefaultDocument())
check('two propagations yield identical event timing',
  JSON.stringify(run.events.map(e => [e.pieceId, e.time, e.detail]))
  === JSON.stringify(again.events.map(e => [e.pieceId, e.time, e.detail])))
check('wire effects are deterministic',
  JSON.stringify(run.wireEffects) === JSON.stringify(again.wireEffects))

console.log(failures === 0 ? '\nALL WIRE CHECKS PASSED\n' : `\n${failures} CHECK(S) FAILED\n`)
if (failures) process.exit(1)
