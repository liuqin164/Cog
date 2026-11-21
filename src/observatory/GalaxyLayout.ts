function hash32(text: string, salt: number): number {
  let hash = 0x811c9dc5 ^ salt;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function uniform(text: string, salt: number): number {
  return hash32(text, salt) / 0x100000000;
}

export interface GalaxyInput {
  id: string;
  arm: string;
}

export interface GalaxyPoint {
  x: number;
  y: number;
  z: number;
}

export interface GalaxyLayoutOptions {
  radius?: number;
  thickness?: number;
  jitter?: number;
}

const DEFAULTS = { radius: 112, thickness: 15, jitter: 1.15 };
const RADIAL_FALLOFF = 0.78;
const TIGHTNESS = 2.4;
const INNER_RADIUS = 6;

export function galaxyLayout(nodes: GalaxyInput[], options: GalaxyLayoutOptions = {}): Map<string, GalaxyPoint> {
  const { radius, thickness, jitter } = { ...DEFAULTS, ...options };
  const populations = new Map<string, number>();
  for (const node of nodes) populations.set(node.arm, (populations.get(node.arm) ?? 0) + 1);
  const arms = Array.from(populations.keys()).sort((left, right) => {
    const bySize = (populations.get(right) ?? 0) - (populations.get(left) ?? 0);
    return bySize !== 0 ? bySize : left.localeCompare(right);
  });
  const armIndex = new Map(arms.map((arm, index) => [arm, index]));

  const points = new Map<string, GalaxyPoint>();
  for (const node of nodes) {
    const arm = armIndex.get(node.arm) ?? 0;
    const span = radius - INNER_RADIUS;
    const r = INNER_RADIUS + span * Math.pow(uniform(node.id, 0x9e3779b9), RADIAL_FALLOFF);
    const armBase = (arm / Math.max(arms.length, 1)) * Math.PI * 2;
    const theta = armBase + TIGHTNESS * Math.log(r / INNER_RADIUS) + (uniform(node.id, 0x85ebca6b) - 0.5) * jitter;
    const y = (uniform(node.id, 0xc2b2ae35) - 0.5) * 2 * thickness * Math.exp(-r / radius);
    points.set(node.id, { x: r * Math.cos(theta), z: r * Math.sin(theta), y });
  }
  return points;
}

export function armKeyFor(node: { topicPath?: string; topicArm?: string; projectId: string }): string {
  const top = node.topicPath?.split('/')[0]?.trim();
  if (top) return top;
  if (node.topicArm) return node.topicArm;
  return node.projectId;
}

export interface ForceEdge {
  source: string;
  target: string;
  confidence?: number;
}

export interface ForceLayoutOptions {
  iterations?: number;
  springLength?: number;
  springStrength?: number;
  repulsion?: number;
  cutoff?: number;
  gravity?: number;
  damping?: number;
}

const FORCE_DEFAULTS = {
  iterations: 36,
  springLength: 7,
  springStrength: 0.045,
  repulsion: 9,
  cutoff: 16,
  gravity: 0.0015,
  damping: 0.82,
};

export function forceLayout(
  nodes: GalaxyInput[],
  edges: ForceEdge[],
  seeds: Map<string, GalaxyPoint>,
  options: ForceLayoutOptions = {},
): Map<string, GalaxyPoint> {
  const settings = { ...FORCE_DEFAULTS, ...options };
  const ordered = [...nodes].sort((left, right) => left.id.localeCompare(right.id));
  const index = new Map(ordered.map((node, position) => [node.id, position]));
  const count = ordered.length;
  if (count < 2 || edges.length === 0) return new Map(seeds);

  const position = new Float64Array(count * 3);
  for (let node = 0; node < count; node += 1) {
    const seed = seeds.get(ordered[node]!.id) ?? { x: 0, y: 0, z: 0 };
    position[node * 3] = seed.x;
    position[node * 3 + 1] = seed.y;
    position[node * 3 + 2] = seed.z;
  }
  const velocity = new Float64Array(count * 3);
  const force = new Float64Array(count * 3);
  const links: Array<[number, number, number]> = [];
  for (const edge of edges) {
    const source = index.get(edge.source);
    const target = index.get(edge.target);
    if (source === undefined || target === undefined || source === target) continue;
    const confidence = Math.max(0.05, Math.min(1, edge.confidence ?? 1));
    links.push([source, target, confidence]);
  }
  if (!links.length) return new Map(seeds);
  links.sort((left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2]);

  const cell = Math.max(4, settings.cutoff);
  const cutoffSquared = settings.cutoff * settings.cutoff;
  for (let step = 0; step < settings.iterations; step += 1) {
    force.fill(0);
    const cells = new Map<number, number[]>();
    for (let node = 0; node < count; node += 1) {
      const cx = Math.floor(position[node * 3]! / cell);
      const cy = Math.floor(position[node * 3 + 1]! / cell);
      const cz = Math.floor(position[node * 3 + 2]! / cell);
      const key = (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663) ^ Math.imul(cz, 83492791)) >>> 0;
      const bucket = cells.get(key);
      if (bucket) bucket.push(node);
      else cells.set(key, [node]);
    }
    for (let node = 0; node < count; node += 1) {
      const cx = Math.floor(position[node * 3]! / cell);
      const cy = Math.floor(position[node * 3 + 1]! / cell);
      const cz = Math.floor(position[node * 3 + 2]! / cell);
      for (let ox = -1; ox <= 1; ox += 1) {
        for (let oy = -1; oy <= 1; oy += 1) {
          for (let oz = -1; oz <= 1; oz += 1) {
            const key = (Math.imul(cx + ox, 73856093) ^ Math.imul(cy + oy, 19349663) ^ Math.imul(cz + oz, 83492791)) >>> 0;
            const bucket = cells.get(key);
            if (!bucket) continue;
            for (const other of bucket) {
              if (other <= node) continue;
              const dx = position[other * 3]! - position[node * 3]!;
              const dy = position[other * 3 + 1]! - position[node * 3 + 1]!;
              const dz = position[other * 3 + 2]! - position[node * 3 + 2]!;
              const distanceSquared = dx * dx + dy * dy + dz * dz;
              if (distanceSquared > cutoffSquared || distanceSquared < 1e-6) continue;
              const push = settings.repulsion / (distanceSquared + 1);
              force[node * 3] -= dx * push;
              force[node * 3 + 1] -= dy * push;
              force[node * 3 + 2] -= dz * push;
              force[other * 3] += dx * push;
              force[other * 3 + 1] += dy * push;
              force[other * 3 + 2] += dz * push;
            }
          }
        }
      }
    }
    for (const [source, target, confidence] of links) {
      const dx = position[target * 3]! - position[source * 3]!;
      const dy = position[target * 3 + 1]! - position[source * 3 + 1]!;
      const dz = position[target * 3 + 2]! - position[source * 3 + 2]!;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const pull = (distance - settings.springLength) * settings.springStrength * confidence;
      force[source * 3] += (dx / distance) * pull;
      force[source * 3 + 1] += (dy / distance) * pull;
      force[source * 3 + 2] += (dz / distance) * pull;
      force[target * 3] -= (dx / distance) * pull;
      force[target * 3 + 1] -= (dy / distance) * pull;
      force[target * 3 + 2] -= (dz / distance) * pull;
    }
    let meanX = 0;
    let meanY = 0;
    let meanZ = 0;
    for (let node = 0; node < count; node += 1) {
      force[node * 3] -= position[node * 3]! * settings.gravity;
      force[node * 3 + 1] -= position[node * 3 + 1]! * settings.gravity;
      force[node * 3 + 2] -= position[node * 3 + 2]! * settings.gravity;
      velocity[node * 3] = (velocity[node * 3]! + force[node * 3]!) * settings.damping;
      velocity[node * 3 + 1] = (velocity[node * 3 + 1]! + force[node * 3 + 1]!) * settings.damping;
      velocity[node * 3 + 2] = (velocity[node * 3 + 2]! + force[node * 3 + 2]!) * settings.damping;
      position[node * 3] += Math.max(-3, Math.min(3, velocity[node * 3]!));
      position[node * 3 + 1] += Math.max(-3, Math.min(3, velocity[node * 3 + 1]!));
      position[node * 3 + 2] += Math.max(-3, Math.min(3, velocity[node * 3 + 2]!));
      meanX += position[node * 3]!;
      meanY += position[node * 3 + 1]!;
      meanZ += position[node * 3 + 2]!;
    }
    meanX /= count;
    meanY /= count;
    meanZ /= count;
    for (let node = 0; node < count; node += 1) {
      position[node * 3] -= meanX;
      position[node * 3 + 1] -= meanY;
      position[node * 3 + 2] -= meanZ;
    }
  }

  const points = new Map<string, GalaxyPoint>();
  for (let node = 0; node < count; node += 1) {
    points.set(ordered[node]!.id, {
      x: Number(position[node * 3]!.toFixed(4)),
      y: Number(position[node * 3 + 1]!.toFixed(4)),
      z: Number(position[node * 3 + 2]!.toFixed(4)),
    });
  }
  return points;
}
