export type TacticalRole = 'assault' | 'support' | 'flanker' | 'guard'

export type TacticalAgent = {
  team: number
  hp: number
  maxHp: number
  alive: boolean
  speed: number
  role: TacticalRole
  phase: number
  mesh: { position: { x: number; z: number } }
}

export type TacticalTarget = TacticalAgent & { mesh: TacticalAgent['mesh'] }

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

/**
 * Selects a visible-enough opposing combatant using distance, remaining health,
 * and target stability. This is a browser-side port of faction-combat concepts,
 * not a runtime dependency on the original Unity C# project.
 */
export function selectTacticalTarget(
  agent: TacticalAgent,
  candidates: TacticalAgent[],
): TacticalAgent | null {
  let selected: TacticalAgent | null = null
  let bestScore = Number.POSITIVE_INFINITY

  for (const candidate of candidates) {
    if (!candidate.alive || candidate === agent || candidate.team === agent.team) continue
    const dx = candidate.mesh.position.x - agent.mesh.position.x
    const dz = candidate.mesh.position.z - agent.mesh.position.z
    const distance = Math.hypot(dx, dz)
    if (distance > 42) continue

    const healthRatio = clamp(candidate.hp / Math.max(1, candidate.maxHp), 0, 1)
    const score = distance + healthRatio * 3.5
    if (score < bestScore) {
      bestScore = score
      selected = candidate
    }
  }

  return selected
}

/** Returns a normalized tactical movement vector and preferred engagement range. */
export function getTacticalMovement(
  agent: TacticalAgent,
  target: TacticalAgent,
  nowSeconds: number,
) {
  const dx = target.mesh.position.x - agent.mesh.position.x
  const dz = target.mesh.position.z - agent.mesh.position.z
  const distance = Math.max(0.001, Math.hypot(dx, dz))
  const forwardX = dx / distance
  const forwardZ = dz / distance

  const preferredRange = agent.role === 'support' ? 12 : agent.role === 'guard' ? 9.5 : agent.role === 'flanker' ? 7 : 5.8
  let moveX = 0
  let moveZ = 0

  if (distance > preferredRange + 1.8) {
    moveX += forwardX
    moveZ += forwardZ
  } else if (distance < preferredRange - 1.8) {
    moveX -= forwardX
    moveZ -= forwardZ
  }

  if (agent.role === 'flanker' && distance < 25) {
    const side = Math.sin(nowSeconds * 0.55 + agent.phase) >= 0 ? 1 : -1
    moveX += (-forwardZ) * side * 0.72
    moveZ += forwardX * side * 0.72
  } else if (agent.role === 'support' && distance < 18) {
    const side = Math.sin(nowSeconds * 0.32 + agent.phase) >= 0 ? 1 : -1
    moveX += (-forwardZ) * side * 0.22
    moveZ += forwardX * side * 0.22
  }

  const magnitude = Math.hypot(moveX, moveZ)
  if (magnitude > 1) {
    moveX /= magnitude
    moveZ /= magnitude
  }

  return { x: moveX, z: moveZ, distance, preferredRange }
}

/** Role-aware firing distance keeps support units back and assault units aggressive. */
export function getTacticalFireRange(role: TacticalRole) {
  if (role === 'support') return 34
  if (role === 'guard') return 27
  if (role === 'flanker') return 29
  return 23
}
