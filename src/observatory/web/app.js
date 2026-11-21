import * as THREE from './three.bundle.js';

const STAR_ROLES = [
  { id: 'rule', label: '规矩', color: '#e0b25e' },
  { id: 'soul', label: '灵魂', color: '#c9a7f0' },
  { id: 'promise', label: '承诺', color: '#e5857e' },
  { id: 'intent', label: '意图', color: '#7fd6a8' },
  { id: 'experience', label: '经历', color: '#6ea8fe' },
  { id: 'ordinary', label: '普通', color: '#9aa8bd' },
];
const ROLE_COLOR = Object.fromEntries(STAR_ROLES.map((role) => [role.id, role.color]));
const ROLE_LABEL = Object.fromEntries(STAR_ROLES.map((role) => [role.id, role.label]));
const RULE_KINDS = new Set(['rule', 'constraint', 'prohibition', 'policy', 'boundary', 'workflow_rule']);
const SOUL_KINDS = new Set(['identity', 'persona', 'belief']);
const PROMISE_KINDS = new Set(['commitment', 'promise', 'commitments', 'promises']);
const INTENT_KINDS = new Set(['intention', 'intent', 'plan', 'planning', 'goal', 'goals', 'task']);
const EXPERIENCE_TYPES = new Set(['episode', 'action', 'raw_event', 'event', 'cluster', 'correction']);

function roleOf(node) {
  if (node.role && ROLE_COLOR[node.role]) return node.role;
  const kind = String(node.memoryKind || (node.type === 'memoryKind' ? node.label : '') || '').trim().toLowerCase();
  if (RULE_KINDS.has(kind)) return 'rule';
  if (node.type === 'belief' || SOUL_KINDS.has(kind)) return 'soul';
  if (PROMISE_KINDS.has(kind)) return 'promise';
  if (INTENT_KINDS.has(kind)) return 'intent';
  if (EXPERIENCE_TYPES.has(node.type)) return 'experience';
  return 'ordinary';
}

const colorFor = (node) => ROLE_COLOR[roleOf(node)];
const SERIES_COLORS = ['#6ea8fe', '#5fd0b4', '#e0b25e', '#e5857e', '#9b8cf0', '#7fc7cf', '#b8c9a0', '#f0a3c8'];
const DEMO_SOURCE = 'demo';
const MOBILE_L1_LIMIT = 3000;

const state = {
  demo: false,
  nodeIndex: new Map(),
  view: 'starmap',
  projectId: null,
  agent: null,
  snapshot: null,
  timeline: null,
  recalls: null,
  soul: null,
  soulLoading: false,
  soulError: null,
  credentials: null,
  credentialsLoading: false,
  credentialsError: null,
  health: null,
  healthLoading: false,
  healthError: null,
  selectedNode: null,
  selectedNeighbors: new Set(),
  hiddenRoles: new Set(),
  selectedDay: null,
  range: null,
  lodCap: 2,
  mobile: matchMedia('(max-width: 900px)').matches,
  reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
};

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
};
const num = (value) => Number(value ?? 0).toLocaleString('zh-CN');
function soulTokens(text) {
  let units = 0;
  for (const char of String(text ?? '')) units += /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]/u.test(char) ? 1 : 0.25;
  return Math.ceil(units);
}
const stamp = (ms) => (ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—');

function api(path, params = {}) {
  const url = new URL(`./${path.replace(/^\//, '')}`, location.href);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') url.searchParams.set(key, value);
  }
  return fetch(url, { headers: { accept: 'application/json' } }).then(async (response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
    return body;
  });
}

const WRITE_TOKEN_KEY = 'observatory-write-token';
let writeToken = sessionStorage.getItem(WRITE_TOKEN_KEY) || null;

async function postJson(path, body) {
  // Out-of-band by design: the owner pastes the token from `<dataDir>/observatory-token`, so no
  // HTTP route hands the long-lived write token to any local GET (#308).
  if (!writeToken) throw new Error('没有写入令牌：把数据目录下 observatory-token 的内容粘贴到凭据或 Soul 页的令牌框。');
  const url = new URL(`./${path.replace(/^\//, '')}`, location.href);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      'x-observatory-token': writeToken,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 403 && data.error === 'invalid_observatory_token') {
    throw new Error('写入令牌不对：重新粘贴数据目录下 observatory-token 的内容。');
  }
  if (!response.ok) throw new Error(data.message || data.error || `HTTP ${response.status}`);
  return data;
}

const map = {
  ready: false,
  needsFrame: true,
  fallback: false,
  layers: {},
  groups: { 0: [], 1: [], 2: [] },
  adjacency: new Map(),
  edgeList: [],
  focus: null,
  interacting: false,
};

function webglAvailable() {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

function spriteTexture(inner, outer) {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, `rgba(255,255,255,${inner})`);
  gradient.addColorStop(0.28, `rgba(255,255,255,${inner * 0.36})`);
  gradient.addColorStop(1, `rgba(255,255,255,${outer})`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function ringTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = 'rgba(242,193,78,0.95)';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 7, 0, Math.PI * 2);
  ctx.stroke();
  return new THREE.CanvasTexture(canvas);
}

const POINT_VERTEX = `
  attribute float size;
  attribute float weight;
  varying vec3 vColor;
  varying float vWeight;
  varying float vDepth;
  void main() {
    vColor = color;
    vWeight = weight;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDepth = -mv.z;
    gl_PointSize = clamp(size * (480.0 / -mv.z), 1.0, 48.0);
    gl_Position = projectionMatrix * mv;
  }`;
const POINT_FRAGMENT = `
  uniform sampler2D uSprite;
  uniform float uFade;
  uniform float uFogDensity;
  varying vec3 vColor;
  varying float vWeight;
  varying float vDepth;
  void main() {
    float alpha = texture2D(uSprite, gl_PointCoord).a;
    float fog = exp(-uFogDensity * uFogDensity * vDepth * vDepth);
    gl_FragColor = vec4(vColor, alpha * vWeight * uFade * fog);
  }`;

function lodBands() {
  return state.mobile
    ? { 1: [430, 250], 2: [0, -1] }
    : { 1: [560, 300], 2: [170, 95] };
}

function lodFade(lod, distance) {
  if (lod > state.lodCap) return 0;
  if (lod === 0) return 1;
  const [starts, full] = lodBands()[lod];
  if (distance <= full) return 1;
  if (distance >= starts) return 0;
  const t = (starts - distance) / (starts - full);
  return t * t * (3 - 2 * t);
}

function initMap() {
  if (map.ready) return;
  const canvas = $('map');
  if (!webglAvailable()) {
    initMap2d(canvas);
    return;
  }
  try {
    map.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch {
    const replacement = canvas.cloneNode(false);
    canvas.replaceWith(replacement);
    initMap2d(replacement);
    return;
  }
  map.renderer.setClearAlpha(0);
  map.scene = new THREE.Scene();
  map.scene.fog = new THREE.FogExp2(0x05070d, 0.0016);
  map.camera = new THREE.PerspectiveCamera(55, 1, 1, 4000);
  map.camera.position.set(0, 132, 138);
  map.sprite = spriteTexture(0.9, 0);
  map.controls = new THREE.OrbitControls(map.camera, canvas);
  map.controls.enableDamping = true;
  map.controls.dampingFactor = 0.075;
  map.controls.rotateSpeed = 0.6;
  map.controls.zoomSpeed = 0.9;
  map.controls.minDistance = 10;
  map.controls.maxDistance = 900;
  map.controls.autoRotate = !state.reducedMotion && !state.mobile;
  map.controls.autoRotateSpeed = 0.28;
  map.controls.addEventListener('change', () => { map.needsFrame = true; });
  map.controls.addEventListener('start', () => { map.controls.autoRotate = false; map.interacting = true; });
  map.controls.addEventListener('end', () => { map.interacting = false; });

  map.dust = dustPoints();
  map.scene.add(map.dust);
  map.nebula = nebulaClouds();
  map.scene.add(map.nebula);
  map.marker = new THREE.Sprite(new THREE.SpriteMaterial({
    map: ringTexture(), depthTest: false, transparent: true, opacity: 0.95,
  }));
  map.marker.visible = false;
  map.scene.add(map.marker);
  map.edges = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3)),
    new THREE.LineBasicMaterial({ color: 0x607a9b, transparent: true, opacity: 0.16, depthWrite: false }),
  );
  map.edges.frustumCulled = false;
  map.scene.add(map.edges);
  map.edgeHighlight = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3)),
    new THREE.LineBasicMaterial({ color: 0xf2c14e, transparent: true, opacity: 0.95, depthWrite: false }),
  );
  map.edgeHighlight.frustumCulled = false;
  map.scene.add(map.edgeHighlight);

  new ResizeObserver(() => { resizeMap(); applyWeights(); }).observe(canvas.parentElement);
  bindMapEvents(canvas);
  map.ready = true;
  window.__cogmemObservatory = map;
  resizeMap();
  requestAnimationFrame(frame);
}

function bindMapEvents(canvas) {
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', () => { $('hovercard').classList.remove('on'); });
  canvas.addEventListener('click', onCanvasClick);
  canvas.addEventListener('keydown', onKeyDown);
}

function nebulaClouds() {
  const group = new THREE.Group();
  const colors = [0x315c8a, 0x5b3f8a, 0x1f6f78];
  for (let index = 0; index < colors.length; index += 1) {
    const material = new THREE.SpriteMaterial({
      map: spriteTexture(0.12, 0),
      color: colors[index],
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const cloud = new THREE.Sprite(material);
    const angle = (index / colors.length) * Math.PI * 2;
    cloud.position.set(Math.cos(angle) * 58, (index - 1) * 11, Math.sin(angle) * 58);
    cloud.scale.setScalar(160 + index * 36);
    group.add(cloud);
  }
  return group;
}

function dustPoints() {
  const count = state.mobile || state.reducedMotion ? 0 : 2600;
  const positions = new Float32Array(Math.max(count, 1) * 3);
  let seed = 0x2f6e2b1;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let index = 0; index < count; index += 1) {
    const r = 200 + rand() * 900;
    const theta = rand() * Math.PI * 2;
    const phi = Math.acos(2 * rand() - 1);
    positions[index * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[index * 3 + 1] = r * Math.cos(phi) * 0.7;
    positions[index * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return new THREE.Points(geometry, new THREE.PointsMaterial({
    color: 0x8fa6c8, size: 1.6, sizeAttenuation: true, transparent: true, opacity: 0.45,
    depthWrite: false, blending: THREE.AdditiveBlending,
  }));
}

function initMap2d(canvas) {
  map.fallback = true;
  const ctx = canvas.getContext('2d');
  const stars = [];
  let seed = 0x2f6e2b1;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const count = state.mobile || state.reducedMotion ? 90 : 220;
  for (let index = 0; index < count; index += 1) {
    stars.push({ x: rand(), y: rand(), size: 0.4 + rand() * 1.4, alpha: 0.15 + rand() * 0.5 });
  }
  map.map2d = {
    ctx,
    width: 1,
    height: 1,
    scale: 2.6,
    minScale: 0.6,
    maxScale: 24,
    centerX: 0,
    centerZ: 0,
    rotation: 0,
    stars,
    pointers: new Map(),
    panning: null,
    pinch: null,
    dragged: false,
  };
  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    map.map2d.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (map.map2d.pointers.size === 2) {
      const [left, right] = [...map.map2d.pointers.values()];
      map.map2d.pinch = { distance: Math.hypot(left.x - right.x, left.y - right.y), scale: map.map2d.scale };
    } else {
      map.map2d.panning = { x: event.clientX, y: event.clientY };
      map.map2d.dragged = false;
    }
  });
  canvas.addEventListener('pointermove', (event) => {
    if (map.map2d.pointers.has(event.pointerId)) map.map2d.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (map.map2d.pinch && map.map2d.pointers.size === 2) {
      const [left, right] = [...map.map2d.pointers.values()];
      const distance = Math.hypot(left.x - right.x, left.y - right.y);
      if (distance > 0) map.map2d.scale = Math.max(map.map2d.minScale, Math.min(map.map2d.maxScale, map.map2d.pinch.scale * distance / map.map2d.pinch.distance));
      map.needsFrame = true;
      return;
    }
    if (!map.map2d.panning) return;
    const dx = event.clientX - map.map2d.panning.x;
    const dy = event.clientY - map.map2d.panning.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) map.map2d.dragged = true;
    map.map2d.centerX -= dx / map.map2d.scale;
    map.map2d.centerZ -= dy / map.map2d.scale;
    map.map2d.panning = { x: event.clientX, y: event.clientY };
    map.needsFrame = true;
  });
  const release = (event) => {
    map.map2d.pointers.delete(event.pointerId);
    if (map.map2d.pointers.size < 2) map.map2d.pinch = null;
    map.map2d.panning = null;
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    map.map2d.scale = Math.max(map.map2d.minScale, Math.min(map.map2d.maxScale, map.map2d.scale * Math.exp(-event.deltaY * 0.0012)));
    map.needsFrame = true;
  }, { passive: false });
  map.ready = true;
  bindMapEvents(canvas);
  new ResizeObserver(() => resizeMap()).observe(canvas.parentElement);
  window.__cogmemObservatory = map;
  resizeMap();
  requestAnimationFrame(frame);
}

function resizeMap2d(width, height) {
  const canvas = $('map');
  const devicePixelRatio = Math.min(window.devicePixelRatio || 1, state.mobile ? 1.5 : 2);
  canvas.width = Math.max(1, Math.round(width * devicePixelRatio));
  canvas.height = Math.max(1, Math.round(height * devicePixelRatio));
  map.map2d.ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  map.map2d.width = width;
  map.map2d.height = height;
  map.map2d.minScale = Math.min(width, height) / 260;
  map.map2d.scale = Math.max(map.map2d.scale, map.map2d.minScale);
  map.needsFrame = true;
}

function frame2d() {
  if (!map.ready) return;
  const idle = state.mobile || state.reducedMotion || state.selectedNode;
  if (!idle || map.needsFrame) draw2d();
  if (!idle && !state.reducedMotion) {
    map.map2d.rotation += 0.0009;
    map.needsFrame = true;
  }
}

function project2d(x, y, z) {
  const view = map.map2d;
  const cosine = Math.cos(view.rotation);
  const sine = Math.sin(view.rotation);
  const dx = x - view.centerX;
  const dz = z - view.centerZ;
  return {
    x: view.width / 2 + (dx * cosine - dz * sine) * view.scale,
    y: view.height / 2 + (dx * sine + dz * cosine) * view.scale,
    depth: y,
  };
}

function nearestNode2d(clientX, clientY, limit = 14) {
  const rect = $('map').getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  let best = null;
  let bestDistance = limit * limit * 4;
  for (const lod of visibleGroups()) {
    for (const node of map.groups[lod]) {
      const screen = project2d(node.x, node.y, node.z);
      const dx = screen.x - x;
      const dy = screen.y - y;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) { bestDistance = distance; best = node; }
    }
  }
  return best;
}

function weightFor(node) {
  let weight = 1;
  if (state.hiddenRoles.has(roleOf(node))) weight *= 0.06;
  if (state.range && node.occurredAt) {
    const day = new Date(node.occurredAt).toISOString().slice(0, 10);
    if (day < state.range[0] || day > state.range[1]) weight *= 0.12;
  }
  if (state.selectedNode) {
    if (node.id === state.selectedNode.id) weight *= 1;
    else if (state.selectedNeighbors.has(node.id)) weight *= 0.85;
    else weight *= 0.05;
  }
  return weight;
}

function draw2d() {
  const view = map.map2d;
  const ctx = view.ctx;
  ctx.clearRect(0, 0, view.width, view.height);
  const glow = ctx.createRadialGradient(view.width * 0.55, view.height * 0.45, 10, view.width * 0.55, view.height * 0.45, Math.max(view.width, view.height) * 0.8);
  glow.addColorStop(0, 'rgba(37,58,92,0.28)');
  glow.addColorStop(0.45, 'rgba(28,34,66,0.16)');
  glow.addColorStop(1, 'rgba(5,7,13,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, view.width, view.height);
  for (const star of view.stars) {
    ctx.globalAlpha = star.alpha;
    ctx.fillStyle = '#8fa6c8';
    ctx.fillRect(star.x * view.width, star.y * view.height, star.size, star.size);
  }
  ctx.globalAlpha = 1;

  ctx.beginPath();
  for (const edge of map.edgeList) {
    const source = project2d(edge.sourceNode.x, edge.sourceNode.y, edge.sourceNode.z);
    const target = project2d(edge.targetNode.x, edge.targetNode.y, edge.targetNode.z);
    ctx.moveTo(source.x, source.y);
    ctx.lineTo(target.x, target.y);
  }
  ctx.strokeStyle = state.selectedNode ? 'rgba(96,122,155,0.05)' : 'rgba(96,122,155,0.18)';
  ctx.lineWidth = 1;
  ctx.stroke();

  if (state.selectedNode) {
    ctx.beginPath();
    for (const edge of map.edgeList) {
      if (edge.source !== state.selectedNode.id && edge.target !== state.selectedNode.id) continue;
      const source = project2d(edge.sourceNode.x, edge.sourceNode.y, edge.sourceNode.z);
      const target = project2d(edge.targetNode.x, edge.targetNode.y, edge.targetNode.z);
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);
    }
    ctx.strokeStyle = 'rgba(242,193,78,0.8)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }

  const ordered = [];
  for (const lod of visibleGroups()) for (const node of map.groups[lod]) ordered.push(node);
  ordered.sort((left, right) => right.z - left.z);
  for (const node of ordered) {
    const weight = weightFor(node);
    if (weight < 0.02) continue;
    const screen = project2d(node.x, node.y, node.z);
    const radius = Math.max(1.2, Math.sqrt(pointSizeFor(node)) * (state.mobile ? 0.55 : 0.75));
    ctx.globalAlpha = Math.min(1, weight * 0.9);
    ctx.fillStyle = colorFor(node);
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
    ctx.fill();
    if (state.selectedNode?.id === node.id) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#f2c14e';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, radius + 5, 0, Math.PI * 2);
      ctx.stroke();
    } else if (state.selectedNeighbors.has(node.id)) {
      ctx.globalAlpha = 0.8;
      ctx.strokeStyle = 'rgba(242,193,78,0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, radius + 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  map.needsFrame = false;
}

function pointSizeFor(node) {
  const support = Math.log10(1 + Math.max(0, node.support)) * 2.1;
  const degree = Math.log10(1 + Math.max(0, node.degree ?? 0)) * 2.4;
  const activation = Math.min(Math.max(node.activation ?? 0, 0), 1) * 2.4;
  const base = node.lod === 2 ? 1.5 : 3.2;
  const size = Math.min(Math.max(base + support + degree + activation, 1.5), 14);
  return state.mobile ? size * 0.5 : size;
}

function buildMap(snapshot) {
  initMap();
  map.groups = { 0: [], 1: [], 2: [] };
  for (const node of snapshot.nodes) map.groups[node.lod].push(node);
  state.mobileDropped = 0;
  if (state.mobile && map.groups[1].length > MOBILE_L1_LIMIT) {
    state.mobileDropped = map.groups[1].length - MOBILE_L1_LIMIT;
    map.groups[1] = map.groups[1].slice(0, MOBILE_L1_LIMIT);
  }
  const nodeIndex = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const visible = new Set([...map.groups[0], ...map.groups[1], ...map.groups[2]].map((node) => node.id));
  map.adjacency = new Map();
  map.edgeList = [];
  for (const edge of snapshot.edges ?? []) {
    if (!visible.has(edge.source) || !visible.has(edge.target)) continue;
    const source = nodeIndex.get(edge.source);
    const target = nodeIndex.get(edge.target);
    if (!source || !target) continue;
    map.edgeList.push({ ...edge, sourceNode: source, targetNode: target });
    const left = map.adjacency.get(edge.source) ?? new Set();
    left.add(edge.target);
    map.adjacency.set(edge.source, left);
    const right = map.adjacency.get(edge.target) ?? new Set();
    right.add(edge.source);
    map.adjacency.set(edge.target, right);
  }

  if (map.fallback) {
    map.map2d.snapshot = snapshot;
    map.map2d.nodes = snapshot.nodes.filter((node) => visible.has(node.id));
    map.needsFrame = true;
    updateMapStats();
    return;
  }

  for (const lod of [0, 1, 2]) {
    if (map.layers[lod]) { map.scene.remove(map.layers[lod]); map.layers[lod].geometry.dispose(); }
  }

  for (const lod of [0, 1, 2]) {
    const nodes = map.groups[lod];
    const count = Math.max(nodes.length, 1);
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const weights = new Float32Array(count);
    const tint = new THREE.Color();
    nodes.forEach((node, index) => {
      positions[index * 3] = node.x;
      positions[index * 3 + 1] = node.y;
      positions[index * 3 + 2] = node.z;
      tint.set(colorFor(node));
      colors[index * 3] = tint.r;
      colors[index * 3 + 1] = tint.g;
      colors[index * 3 + 2] = tint.b;
      sizes[index] = pointSizeFor(node);
      weights[index] = 1;
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('weight', new THREE.BufferAttribute(weights, 1));
    const material = new THREE.ShaderMaterial({
      uniforms: { uSprite: { value: map.sprite }, uFade: { value: 1 }, uFogDensity: { value: 0.0032 } },
      vertexShader: POINT_VERTEX,
      fragmentShader: POINT_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.visible = nodes.length > 0;
    map.scene.add(points);
    map.layers[lod] = points;
  }
  const allEdges = new Float32Array(map.edgeList.length * 6);
  map.edgeList.forEach((edge, index) => {
    allEdges.set([edge.sourceNode.x, edge.sourceNode.y, edge.sourceNode.z, edge.targetNode.x, edge.targetNode.y, edge.targetNode.z], index * 6);
  });
  map.edges.geometry.setAttribute('position', new THREE.BufferAttribute(allEdges, 3));
  map.edges.geometry.computeBoundingSphere();
  applyWeights();
  map.needsFrame = true;
  updateMapStats();
}

function resizeMap() {
  const canvas = $('map');
  const width = canvas.clientWidth || canvas.parentElement.clientWidth;
  const height = canvas.clientHeight || canvas.parentElement.clientHeight;
  if (!width || !height) return;
  if (map.fallback) { resizeMap2d(width, height); return; }
  map.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, state.mobile ? 1.5 : 2));
  map.renderer.setSize(width, height, false);
  map.camera.aspect = width / height;
  map.camera.updateProjectionMatrix();
  updateProjection();
  map.needsFrame = true;
}

function frame() {
  requestAnimationFrame(frame);
  if (!map.ready) return;
  if (map.fallback) { frame2d(); return; }
  if (map.onDemandIdle === undefined) map.onDemandIdle = state.mobile || state.reducedMotion;
  const focusing = updateFocus();
  const damping = map.controls.update();
  if (map.onDemandIdle && !map.needsFrame && !damping && !focusing) return;
  applyLodBands();
  updateProjection();
  map.renderer.render(map.scene, map.camera);
  map.needsFrame = false;
}

function updateFocus() {
  if (!map.focus) return false;
  const progress = Math.min(1, (performance.now() - map.focus.started) / map.focus.duration);
  const ease = progress * progress * (3 - 2 * progress);
  map.controls.target.lerpVectors(map.focus.fromTarget, map.focus.toTarget, ease);
  map.camera.position.lerpVectors(map.focus.fromPosition, map.focus.toPosition, ease);
  map.needsFrame = true;
  if (progress >= 1) map.focus = null;
  return true;
}

function updateProjection() {
  map.camera.updateMatrixWorld();
  map.camera.matrixWorldInverse.copy(map.camera.matrixWorld).invert();
  map.projection = new THREE.Matrix4()
    .multiplyMatrices(map.camera.projectionMatrix, map.camera.matrixWorldInverse)
    .elements;
}

function applyLodBands() {
  const distance = map.camera.position.distanceTo(map.controls.target);
  let changed = false;
  for (const lod of [0, 1, 2]) {
    const layer = map.layers[lod];
    if (!layer) continue;
    const fade = map.groups[lod].length ? lodFade(lod, distance) : 0;
    if (layer.material.uniforms.uFade.value !== fade) {
      layer.material.uniforms.uFade.value = fade;
      changed = true;
    }
    const visible = fade > 0.02;
    if (layer.visible !== visible) {
      layer.visible = visible;
      changed = true;
    }
  }
  if (changed) updateMapStats();
}

function applyWeights() {
  for (const lod of [0, 1, 2]) {
    const layer = map.layers[lod];
    if (!layer) continue;
    const weights = layer.geometry.attributes.weight;
    map.groups[lod].forEach((node, index) => {
      weights.array[index] = weightFor(node);
    });
    weights.needsUpdate = true;
  }
  if (map.edges) map.edges.material.opacity = state.selectedNode ? 0.04 : 0.16;
  map.needsFrame = true;
}

function visibleGroups() {
  if (map.fallback) {
    return [0, 1, 2].filter((lod) => map.groups[lod].length > 0 && lod <= state.lodCap && !(state.mobile && lod === 2));
  }
  const distance = map.camera.position.distanceTo(map.controls.target);
  return [0, 1, 2].filter((lod) => map.groups[lod].length > 0 && lodFade(lod, distance) > 0.02);
}

function projectToScreen(x, y, z) {
  if (map.fallback) return project2d(x, y, z);
  const matrix = map.projection;
  const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  if (w <= 0) return null;
  const ndcX = (matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12]) / w;
  const ndcY = (matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]) / w;
  const canvas = $('map');
  return { x: (ndcX * 0.5 + 0.5) * canvas.clientWidth, y: (-ndcY * 0.5 + 0.5) * canvas.clientHeight };
}

function nearestNode(clientX, clientY, limit = 14) {
  if (map.fallback) return nearestNode2d(clientX, clientY, limit);
  if (!map.projection) return null;
  const rect = $('map').getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  let best = null;
  let bestDistance = limit * limit * 4;
  for (const lod of visibleGroups()) {
    const nodes = map.groups[lod];
    const positions = map.layers[lod].geometry.attributes.position.array;
    for (let index = 0; index < nodes.length; index += 1) {
      const screen = projectToScreen(positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]);
      if (!screen) continue;
      const dx = screen.x - x;
      const dy = screen.y - y;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) { bestDistance = distance; best = nodes[index]; }
    }
  }
  return best;
}

let hoverPending = 0;
function onPointerMove(event) {
  if (hoverPending) return;
  hoverPending = window.setTimeout(() => {
    hoverPending = 0;
    const node = nearestNode(event.clientX, event.clientY);
    const card = $('hovercard');
    if (!node) { card.classList.remove('on'); return; }
    const rect = $('map').getBoundingClientRect();
    card.innerHTML = '';
    card.append(el('span', { class: 't', text: node.label || node.id }));
    card.append(el('span', {
      class: 's',
      text: `${ROLE_LABEL[roleOf(node)]} · ${node.type}${node.status && node.status !== 'active' ? ` · ${node.status}` : ''} · ${num(node.degree ?? 0)} 条连边 · 证据 ${num(node.evidenceTotal)}`,
    }));
    card.classList.add('on');
    card.style.left = `${Math.min(event.clientX - rect.left + 14, rect.width - 240)}px`;
    card.style.top = `${Math.max(event.clientY - rect.top - 12, 8)}px`;
  }, 50);
}

function selectNode(node, options = {}) {
  state.selectedNode = node;
  state.selectedNeighbors = new Set(node ? [node.id, ...(map.adjacency.get(node.id) ?? [])] : []);
  if (map.marker) {
    map.marker.visible = Boolean(node);
    if (node) map.marker.position.set(node.x, node.y, node.z);
  }
  if (!node) clearHighlight();
  else {
    drawHighlight(node, state.selectedNeighbors);
    focusNode(node);
  }
  applyWeights();
  map.needsFrame = true;
  if (!node) { renderPanel(); return; }
  if (options.fromSnapshot && state.demo) {
    const detail = demoDetail(node);
    renderPanel({ node, detail });
    return;
  }
  if (options.fromSnapshot) {
    renderPanel({ node, detail: 'loading' });
    api(`node/${encodeURIComponent(node.id)}`, { project: state.projectId, agent: state.agent })
      .then((detail) => {
        if (state.selectedNode !== node) return;
        const neighborIds = new Set(state.selectedNeighbors);
        for (const edge of detail.neighbors || []) {
          const other = edge.source === node.id ? edge.target : edge.source;
          if (state.nodeIndex.has(other)) neighborIds.add(other);
        }
        state.selectedNeighbors = neighborIds;
        drawHighlight(node, neighborIds);
        applyWeights();
        renderPanel({ node, detail });
      })
      .catch((error) => renderPanel({ node, error: error.message }));
  }
}

function demoDetail(node) {
  const neighbours = (state.snapshot.nodes ?? [])
    .filter((item) => item.id !== node.id && item.topicPath && item.topicPath === node.topicPath)
    .slice(0, 3);
  return {
    ...node,
    status: 'active',
    summary: `（虚构演示条目，不对应任何真实记忆）${node.label}`,
    evidenceTotal: 2,
    evidenceReturned: 1,
    evidence: [{
      eventId: `evt-demo-${node.id.replace(/[^\w]/g, '-')}`,
      drilldown: `cogmem memory show --event evt-demo --project ${state.projectId} --before 2 --after 2 --json`,
    }],
    neighbors: neighbours.map((item) => ({ source: node.id, relation: 'RELATED_TO', target: item.id, confidence: 0.5, evidenceEventIds: [] })),
  };
}

function focusNode(node) {
  if (map.fallback) {
    const target = map.map2d;
    target.centerX = node.x;
    target.centerZ = node.z;
    target.scale = Math.max(target.scale, target.minScale * 2.2);
    map.needsFrame = true;
    return;
  }
  map.controls.autoRotate = false;
  const toTarget = new THREE.Vector3(node.x, node.y, node.z);
  const offset = map.camera.position.clone().sub(map.controls.target);
  offset.setLength(Math.max(30, Math.min(offset.length(), 72)));
  map.focus = {
    fromTarget: map.controls.target.clone(),
    toTarget,
    fromPosition: map.camera.position.clone(),
    toPosition: toTarget.clone().add(offset),
    started: performance.now(),
    duration: 420,
  };
}

function drawHighlight(node, neighbors) {
  state.selectedNeighbors = new Set(neighbors);
  if (map.fallback) { map.needsFrame = true; return; }
  const points = [];
  for (const edge of map.edgeList) {
    if (edge.source !== node.id && edge.target !== node.id) continue;
    points.push(edge.sourceNode.x, edge.sourceNode.y, edge.sourceNode.z, edge.targetNode.x, edge.targetNode.y, edge.targetNode.z);
  }
  const geometry = map.edgeHighlight.geometry;
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3));
  geometry.computeBoundingSphere();
  map.needsFrame = true;
}

function clearHighlight() {
  state.selectedNeighbors = new Set();
  if (map.edgeHighlight) {
    map.edgeHighlight.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
  }
  map.needsFrame = true;
}

function onCanvasClick(event) {
  if (map.fallback && map.map2d.dragged) { map.map2d.dragged = false; return; }
  const node = nearestNode(event.clientX, event.clientY);
  if (!node) { selectNode(null); return; }
  selectNode(node, { fromSnapshot: true });
}

function onKeyDown(event) {
  const canvas = $('map');
  if (map.fallback) {
    const pan = (dx, dy) => {
      map.map2d.centerX -= dx / map.map2d.scale;
      map.map2d.centerZ -= dy / map.map2d.scale;
      map.needsFrame = true;
    };
    if (event.key === 'ArrowLeft') { pan(24, 0); event.preventDefault(); }
    else if (event.key === 'ArrowRight') { pan(-24, 0); event.preventDefault(); }
    else if (event.key === 'ArrowUp') { pan(0, 24); event.preventDefault(); }
    else if (event.key === 'ArrowDown') { pan(0, -24); event.preventDefault(); }
    else if (event.key === '+' || event.key === '=') { map.map2d.scale *= 1.15; map.needsFrame = true; event.preventDefault(); }
    else if (event.key === '-' || event.key === '_') { map.map2d.scale /= 1.15; map.needsFrame = true; event.preventDefault(); }
    else if (event.key === 'Enter') {
      const rect = canvas.getBoundingClientRect();
      const node = nearestNode(rect.left + rect.width / 2, rect.top + rect.height / 2, 60);
      if (node) selectNode(node, { fromSnapshot: true });
      event.preventDefault();
    } else if (event.key === 'Escape') selectNode(null);
    return;
  }
  const rotate = (dx, dy) => {
    map.controls.autoRotate = false;
    const offset = map.camera.position.clone();
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta -= dx;
    spherical.phi = Math.min(Math.max(spherical.phi - dy, 0.12), Math.PI - 0.12);
    map.camera.position.setFromSpherical(spherical);
    map.camera.lookAt(map.controls.target);
    map.needsFrame = true;
  };
  if (event.key === 'ArrowLeft') { rotate(0.12, 0); event.preventDefault(); }
  else if (event.key === 'ArrowRight') { rotate(-0.12, 0); event.preventDefault(); }
  else if (event.key === 'ArrowUp') { rotate(0, 0.1); event.preventDefault(); }
  else if (event.key === 'ArrowDown') { rotate(0, -0.1); event.preventDefault(); }
  else if (event.key === '+' || event.key === '=') { map.camera.position.multiplyScalar(0.9); map.needsFrame = true; event.preventDefault(); }
  else if (event.key === '-' || event.key === '_') { map.camera.position.multiplyScalar(1.1); map.needsFrame = true; event.preventDefault(); }
  else if (event.key === 'Enter') {
    const rect = canvas.getBoundingClientRect();
    const node = nearestNode(rect.left + rect.width / 2, rect.top + rect.height / 2, 60);
    if (node) selectNode(node, { fromSnapshot: true });
    event.preventDefault();
  } else if (event.key === 'Escape') { selectNode(null); }
}

function updateMapStats() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const bands = visibleGroups();
  const shown = bands.reduce((sum, lod) => sum + map.groups[lod].length, 0);
  const caps = [];
  if (state.mobileDropped) caps.push(`移动端 L1 只画最活跃的 ${num(MOBILE_L1_LIMIT)} 个（省略 ${num(state.mobileDropped)}）`);
  if (snapshot.truncation) caps.push(`快照上限 ${num(snapshot.truncation.limit)}`);
  const mode = map.fallback ? '2D 降级' : '3D';
  $('map-stats').textContent = `${mode} · ${num(shown)} / ${num(snapshot.nodes.length)} 节点 · ${num(map.edgeList.length)} / ${num(snapshot.counts.edgesTotal)} 边 · LOD ${bands.map((lod) => `L${lod}`).join('+') || '无'}`
    + (caps.length ? ` · ${caps.join(' · ')}` : '');
}

/* ---------------------------------------------------------------- timeline */

function renderTimeline() {
  const host = $('view-timeline');
  host.innerHTML = '';
  const timeline = state.timeline;
  if (!timeline || !timeline.histogram.days.length) {
    host.append(emptyState(
      '这段时间里没有事件',
      '账本里没有落在这个项目与范围内的记录。换一个项目或智能体范围，或者回到星图看已编译的记忆。',
    ));
    return;
  }
  const days = timeline.histogram.days;
  const series = timeline.histogram.series;
  const width = 1000;
  const height = 300;
  const pad = { top: 16, right: 16, bottom: 34, left: 46 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const max = Math.max(1, ...series.flatMap((item) => item.counts));
  const step = plotWidth / days.length;
  const barWidth = Math.max(1, step - 0.6);
  const yFor = (value) => pad.top + plotHeight - (value / max) * plotHeight;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('class', 'chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `按天的事件分布，共 ${num(days.length)} 天`);

  for (let tick = 0; tick <= 4; tick += 1) {
    const value = (max / 4) * tick;
    const y = yFor(value);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', pad.left); line.setAttribute('x2', width - pad.right);
    line.setAttribute('y1', y); line.setAttribute('y2', y);
    line.setAttribute('class', 'grid-line');
    svg.append(line);
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', pad.left - 6); label.setAttribute('y', y + 3);
    label.setAttribute('text-anchor', 'end'); label.setAttribute('class', 'axis');
    label.textContent = num(Math.round(value));
    svg.append(label);
  }

  const seriesColor = (index) => SERIES_COLORS[index % SERIES_COLORS.length];
  days.forEach((day, dayIndex) => {
    let cursor = pad.top + plotHeight;
    series.forEach((item, seriesIndex) => {
      const value = item.counts[dayIndex];
      if (!value) return;
      const barHeight = (value / max) * plotHeight;
      cursor -= barHeight;
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', pad.left + dayIndex * step);
      rect.setAttribute('y', cursor);
      rect.setAttribute('width', barWidth);
      rect.setAttribute('height', Math.max(barHeight, 0.8));
      rect.setAttribute('fill', seriesColor(seriesIndex));
      rect.setAttribute('class', 'bar');
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${day} · ${item.eventType} · ${num(value)}`;
      rect.append(title);
      svg.append(rect);
    });
  });

  const first = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  first.setAttribute('x', pad.left); first.setAttribute('y', height - 12);
  first.setAttribute('class', 'axis'); first.textContent = days[0];
  svg.append(first);
  const last = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  last.setAttribute('x', width - pad.right); last.setAttribute('y', height - 12);
  last.setAttribute('text-anchor', 'end'); last.setAttribute('class', 'axis');
  last.textContent = days[days.length - 1];
  svg.append(last);

  const brushRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  brushRect.setAttribute('class', 'brush');
  brushRect.setAttribute('y', pad.top);
  brushRect.setAttribute('height', plotHeight);
  brushRect.setAttribute('width', 0);
  brushRect.setAttribute('visibility', 'hidden');
  svg.append(brushRect);

  const wrapper = el('div', { class: 'chart-wrap' });
  wrapper.append(svg);
  host.append(wrapper);
  host.append(el('div', { class: 'tl-legend' }, series.map((item, index) => el('span', {}, [
    el('span', { class: 'swatch', style: `color:${seriesColor(index)}` }),
    `${item.eventType} · ${num(timeline.histogram.totals[item.eventType] ?? 0)}`,
  ]))));
  const dayPanel = el('div', { class: 'day-panel' });
  host.append(dayPanel);
  renderDayPanel(dayPanel);

  let startX = null;
  const dayAt = (event) => {
    const rect = svg.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    const index = Math.floor(((ratio * width) - pad.left) / step);
    return Math.max(0, Math.min(days.length - 1, index));
  };
  svg.addEventListener('pointerdown', (event) => {
    startX = dayAt(event);
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener('pointermove', (event) => {
    if (startX === null) return;
    const current = dayAt(event);
    const low = Math.min(startX, current);
    const high = Math.max(startX, current);
    brushRect.setAttribute('visibility', 'visible');
    brushRect.setAttribute('x', pad.left + low * step);
    brushRect.setAttribute('width', (high - low + 1) * step);
  });
  svg.addEventListener('pointerup', (event) => {
    if (startX === null) return;
    const current = dayAt(event);
    brushRect.setAttribute('visibility', 'hidden');
    const low = Math.min(startX, current);
    const high = Math.max(startX, current);
    startX = null;
    if (low === high) {
      state.range = null;
      state.selectedDay = days[low];
    } else {
      state.range = [days[low], days[high]];
      state.selectedDay = null;
    }
    applyWeights();
    renderDayPanel(dayPanel);
    renderPanel();
  });
}

function renderDayPanel(host) {
  host.innerHTML = '';
  const timeline = state.timeline;
  if (!timeline) return;
  if (state.range) {
    host.append(el('div', {}, [
      el('h3', { text: `范围 ${state.range[0]} → ${state.range[1]}` }),
      el('p', { class: 'dim', text: '星图里落在范围外的节点已变暗。' }),
      el('button', { class: 'chip', type: 'button', text: '清除范围', onclick: () => { state.range = null; applyWeights(); renderDayPanel(host); renderPanel(); } }),
    ]));
    return;
  }
  const day = state.selectedDay;
  if (!day) {
    host.append(el('div', {}, [
      el('h3', { text: '选一天' }),
      el('p', { class: 'dim', text: '拖动刷选一段时间范围，或点一天看当天的构成与当天新建的 L1 节点。' }),
    ]));
    return;
  }
  const index = timeline.histogram.days.indexOf(day);
  const composition = timeline.histogram.series
    .map((item) => ({ type: item.eventType, value: item.counts[index] ?? 0 }))
    .filter((item) => item.value > 0)
    .sort((left, right) => right.value - left.value);
  const created = (state.snapshot?.nodes ?? []).filter((node) => {
    if (node.lod !== 1 || !node.occurredAt) return false;
    return new Date(node.occurredAt).toISOString().slice(0, 10) === day;
  }).slice(0, 40);
  host.append(el('div', {}, [
    el('h3', { text: day }),
    composition.length
      ? el('ul', { class: 'plain' }, composition.map((item) => el('li', {}, [
        el('span', { text: item.type }), el('span', { class: 'num', text: num(item.value) }),
      ])))
      : el('p', { class: 'dim', text: '这一天没有记录在案的事件。' }),
  ]));
  host.append(el('div', {}, [
    el('h3', { text: `当天新建的 L1 节点（${num(created.length)}）` }),
    created.length
      ? el('ul', { class: 'plain' }, created.map((node) => el('li', {}, [
        el('button', { type: 'button', text: node.label || node.id, onclick: () => { showView('starmap'); selectNode(node, { fromSnapshot: true }); } }),
        el('span', { class: 'num dim', text: node.type }),
      ])))
      : el('p', { class: 'dim', text: '当天没有新建的聚合节点。' }),
  ]));
}

/* ----------------------------------------------------------------- recalls */

function renderRecalls() {
  const host = $('view-recalls');
  host.innerHTML = '';
  host.style.height = '100%';
  const recalls = state.recalls;
  const split = el('div', { class: 'split' });
  const list = el('div', { class: 'list' });
  const detail = el('div', { class: 'trace', id: 'recall-detail' });
  split.append(list, detail);
  host.append(split);

  if (!recalls || !recalls.available) {
    list.append(emptyState(
      '这个库还没有存过召回决策',
      '召回检查页只读已经落库的 trace（trace_events），首版不在页面里现场跑 explain。这个数据库里还没有那张表，或者它还是空的。',
    ));
    detail.append(emptyState('没有可展开的决策', '等宿主侧把 recall.request / recall.result 落进 trace 之后，这里会按任务列出每一次决策。'));
    return;
  }
  if (!recalls.recalls.length) {
    list.append(emptyState('当前范围内没有召回决策', '换一个项目或智能体范围再试。'));
    detail.append(emptyState('没有可展开的决策', '列表为空时没有详情可看。'));
    return;
  }
  const items = [];
  for (const recall of recalls.recalls) {
    const button = el('button', { class: 'recall-item', type: 'button' }, [
      el('span', { class: 'q', text: recall.query || '(无查询文本)' }),
      el('span', { class: 'm', text: `${stamp(recall.startedAt)} · ${recall.decision} · ${recall.taskId || recall.recallId}` }),
    ]);
    button.addEventListener('click', () => {
      for (const other of items) other.setAttribute('aria-current', 'false');
      button.setAttribute('aria-current', 'true');
      showRecallDetail(detail, recall.taskId || recall.recallId);
    });
    items.push(button);
    list.append(button);
  }
  items[0].setAttribute('aria-current', 'true');
  showRecallDetail(detail, recalls.recalls[0].taskId || recalls.recalls[0].recallId);
}

function showRecallDetail(host, recallId) {
  host.innerHTML = '';
  if (state.demo) {
    const recall = (state.recalls?.recalls ?? []).find((item) => (item.taskId || item.recallId) === recallId);
    if (recall) renderRecallDetail(host, { ...recall, chain: [] });
    else host.append(emptyState('这条 trace 打不开', '演示数据里没有这一条。'));
    return;
  }
  host.append(el('div', { class: 'skeleton w80' }), el('div', { class: 'skeleton w60' }), el('div', { class: 'skeleton w40' }));
  api(`recalls/${encodeURIComponent(recallId)}`, { project: state.projectId, agent: state.agent })
    .then((detail) => renderRecallDetail(host, detail))
    .catch((error) => {
      host.innerHTML = '';
      host.append(emptyState('这条 trace 打不开', error.message));
    });
}

function renderRecallDetail(host, detail) {
  host.innerHTML = '';
  const payload = detail.payload ?? {};
  host.append(el('h3', { text: detail.query || '(无查询文本)' }));
  host.append(el('dl', { class: 'kv' }, [
    el('dt', { text: '决策 id' }), el('dd', { text: detail.recallId }),
    el('dt', { text: '时间' }), el('dd', { text: stamp(detail.startedAt) }),
    el('dt', { text: '任务' }), el('dd', { text: detail.taskId || '—' }),
  ]));
  const suppressed = Array.isArray(payload.suppressed) ? payload.suppressed : [];
  if (suppressed.length) {
    host.append(el('h2', { class: 'head', text: '被门控 / 抑制', style: 'margin-top:0.875rem' }));
    host.append(el('div', { class: 'suppressed' }, suppressed.map((entry) =>
      el('span', { text: `${entry.reason ?? 'unknown'} × ${num(entry.count ?? 0)}` }))));
  }
  if (detail.chain?.length > 1) {
    host.append(el('h2', { class: 'head', text: '决策链', style: 'margin-top:0.875rem' }));
    host.append(el('ul', { class: 'plain' }, detail.chain.map((step) =>
      el('li', {}, [el('span', { text: step.eventType }), el('span', { class: 'dim', text: stamp(step.timestamp) })]))));
    if (detail.chainTruncated) {
      host.append(el('div', { class: 'notice', text: `决策链已截断：仅显示最近 ${num(detail.chainLimit)} 跳。` }));
    }
  }
  host.append(el('h2', { class: 'head', text: '完整 payload', style: 'margin-top:0.875rem' }));
  host.append(el('pre', { class: 'json', text: JSON.stringify(payload, null, 2) }));
}

/* ------------------------------------------------------------------- panel */

function emptyState(title, body) {
  return el('div', { class: 'empty' }, [el('h3', { text: title }), el('p', { class: 'dim', text: body })]);
}

function panelHeader(title, sub) {
  return el('div', { class: 'section' }, [el('h3', { text: title }), sub ? el('p', { class: 'dim', text: sub }) : null]);
}

function renderPanel(options = {}) {
  const panel = $('panel');
  panel.innerHTML = '';
  if (state.view === 'recalls') { renderRecallsPanel(panel); return; }
  if (state.view === 'timeline') { renderTimelinePanel(panel); return; }
  if (state.view === 'soul') { renderSoulPanel(panel); return; }
  if (state.view === 'credentials') { renderCredentialsPanel(panel); return; }
  if (state.view === 'health') { renderHealthPanel(panel); return; }
  if (state.selectedNode) { renderNodePanel(panel, options); return; }
  renderOverviewPanel(panel);
}

function renderSoulPanel(panel) {
  panel.append(panelHeader('Soul', '内核 soul_versions 表：按智能体、逐版本保存。'));
  if (!state.agent) {
    panel.append(el('p', { class: 'dim', text: '先在范围栏选择一个智能体。Soul 没有合并视图。' }));
    return;
  }
  panel.append(el('p', { class: 'dim', text: `当前智能体：${state.agent}` }));
  if (state.soul?.current) {
    panel.append(el('dl', { class: 'kv' }, [
      el('dt', { text: '版本' }), el('dd', { text: `v${state.soul.current.version}` }),
      el('dt', { text: 'tokens' }), el('dd', { text: `${state.soul.current.tokenCount} / ${state.soul.maxTokens}` }),
      el('dt', { text: '字节' }), el('dd', { text: String(new TextEncoder().encode(state.soul.current.content).length) }),
    ]));
  }
  panel.append(el('p', { class: 'hint', text: '保存会追加版本；回滚也是追加，不删除旧版本。智能体只能起草建议，不能保存。' }));
}

function renderSoul() {
  const root = $('view-soul');
  root.innerHTML = '';
  if (state.demo) {
    root.append(emptyState('演示模式没有 soul', '演示数据只覆盖星图、时间线与召回；soul 编辑只对真实数据库开放。'));
    return;
  }
  if (!state.agent) {
    root.append(emptyState('先选择一个智能体', 'Soul 按智能体分行。范围栏的「全部」是合并视图，没有合并 soul。'));
    return;
  }
  if (state.soulLoading || !state.soul || state.soul.agentId !== state.agent) {
    root.append(el('div', { class: 'soul-editor' }, [
      el('div', { class: 'skeleton w60' }),
      el('div', { class: 'skeleton' }),
      el('div', { class: 'skeleton w80' }),
    ]));
    return;
  }

  const data = state.soul;
  const editor = el('div', { class: 'soul-editor' });
  editor.append(el('h2', { text: `Soul · ${data.agentId}` }));
  editor.append(el('p', { class: 'hint', text: '当前版本逐字注入钉死车道的身份+规矩层；保存会落一个新版本，旧版本仍可回滚。' }));
  if (state.soulError) editor.append(el('p', { class: 'soul-error', text: state.soulError }));

  const textarea = el('textarea', { class: 'soul-text', rows: '18', spellcheck: 'false' });
  textarea.value = data.current?.content ?? '';
  const counter = el('span', { class: 'soul-count' });
  const save = el('button', { type: 'button', class: 'primary', text: '保存新版本' });
  const tokenInput = el('input', {
    class: 'soul-token',
    type: 'password',
    placeholder: '写入令牌',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  tokenInput.value = writeToken ?? '';
  tokenInput.addEventListener('input', () => {
    writeToken = tokenInput.value.trim() || null;
    if (writeToken) sessionStorage.setItem(WRITE_TOKEN_KEY, writeToken);
    else sessionStorage.removeItem(WRITE_TOKEN_KEY);
  });
  const updateCount = () => {
    const tokens = soulTokens(textarea.value);
    counter.textContent = `${tokens} / ${data.maxTokens} tokens`;
    counter.classList.toggle('over', tokens > data.maxTokens);
    save.disabled = tokens > data.maxTokens || textarea.value.trim() === '';
  };
  textarea.addEventListener('input', updateCount);
  save.addEventListener('click', () => { void saveSoul(textarea.value); });

  if (data.proposal) {
    const proposal = el('div', { class: 'soul-proposal' });
    proposal.append(el('strong', { text: '智能体的修改建议' }));
    proposal.append(el('p', { class: 'hint', text: data.proposal.reason ? `理由：${data.proposal.reason}` : '它只能起草，不能保存。' }));
    if (data.proposal.diff) {
      proposal.append(el('p', { class: 'hint', text: '相对当前版本的逐行差异：' }));
      proposal.append(el('pre', { class: 'json', text: data.proposal.diff }));
    }
    if (Array.isArray(data.proposal.sourceRefs) && data.proposal.sourceRefs.length > 0) {
      proposal.append(el('p', { class: 'hint', text: `依据：${data.proposal.sourceRefs.join('；')}` }));
    }
    if (data.proposal.counterexample) {
      proposal.append(el('p', { class: 'hint', text: `反例：${data.proposal.counterexample}` }));
    } else if (data.proposal.noCounterexampleScope) {
      proposal.append(el('p', { class: 'hint', text: `无反例（检索范围：${data.proposal.noCounterexampleScope}）` }));
    }
    proposal.append(el('pre', { class: 'json', text: data.proposal.content }));
    const use = el('button', { type: 'button', class: 'primary', text: '载入建议' });
    use.addEventListener('click', () => {
      textarea.value = data.proposal.content;
      updateCount();
      textarea.focus();
    });
    proposal.append(use);
    editor.append(proposal);
  }

  editor.append(el('p', { class: 'hint', text: '写操作需要数据目录下 observatory-token 文件的令牌；令牌不经 HTTP 读取，只留在本标签页。' }));
  editor.append(tokenInput);
  editor.append(textarea);
  editor.append(el('div', { class: 'soul-toolbar' }, [
    counter,
    save,
    el('span', { class: 'hint', text: '超过上限会被拒绝，不会截断。' }),
  ]));
  updateCount();

  editor.append(el('h2', { text: '版本史' }));
  const history = el('ul', { class: 'soul-history' });
  for (const row of data.versions) {
    const item = el('li', { class: 'soul-version' });
    item.append(el('span', { class: 'v', text: `v${row.version}` }));
    item.append(el('span', {
      class: 'meta',
      text: `${stamp(row.createdAt)} · ${row.createdBy} · ${row.tokenCount} tokens${row.reason ? ` · ${row.reason}` : ''}`,
    }));
    const rollback = el('button', { type: 'button', text: '回滚' });
    rollback.disabled = row.version === data.current?.version;
    rollback.addEventListener('click', () => {
      if (confirm(`回滚到 v${row.version}？这会追加一个新版本。`)) void rollbackSoul(row.version);
    });
    item.append(rollback);
    history.append(item);
  }
  editor.append(history);
  root.append(editor);
}

function renderCredentialsPanel(panel) {
  panel.append(panelHeader('凭据', '请求在可信面输入；值直达 0600 保险库，不进对话、日志或模型上下文。'));
  const data = state.credentials;
  if (!data) {
    panel.append(el('p', { class: 'dim', text: state.credentialsLoading ? '读取中…' : (state.credentialsError || '没有待处理的凭据请求。') }));
    return;
  }
  panel.append(el('dl', { class: 'kv' }, [
    el('dt', { text: '待处理' }), el('dd', { text: num(data.pending?.length ?? 0) }),
    el('dt', { text: '已保存引用' }), el('dd', { text: num(data.refs?.length ?? 0) }),
  ]));
}

function credentialTokenInput() {
  const input = el('input', {
    class: 'soul-token',
    type: 'password',
    placeholder: '写入令牌',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  input.value = writeToken ?? '';
  input.addEventListener('input', () => {
    writeToken = input.value.trim() || null;
    if (writeToken) sessionStorage.setItem(WRITE_TOKEN_KEY, writeToken);
    else sessionStorage.removeItem(WRITE_TOKEN_KEY);
  });
  return input;
}

function renderCredentials() {
  const root = $('view-credentials');
  root.innerHTML = '';
  if (state.demo) {
    root.append(emptyState('演示模式没有凭据', '凭据只对真实数据目录开放。'));
    return;
  }
  const editor = el('div', { class: 'soul-editor' });
  editor.append(el('h2', { text: '凭据请求' }));
  editor.append(el('p', { class: 'hint', text: '接下来的输入不会进入对话与账本，模型看不到。账号正常回显，密码完全不回显。' }));
  editor.append(credentialTokenInput());
  if (state.credentialsError) editor.append(el('p', { class: 'soul-error', text: state.credentialsError }));
  if (state.credentialsLoading) {
    editor.append(el('div', { class: 'skeleton w60' }), el('div', { class: 'skeleton' }));
  }
  const data = state.credentials;
  const pending = data?.pending ?? [];
  if (data && pending.length === 0) editor.append(el('p', { class: 'dim', text: '当前没有待处理的凭据请求。' }));
  for (const request of pending) {
    const form = el('div', { class: 'section' });
    form.append(el('h3', { text: `${request.service} · ${request.purpose}` }));
    form.append(el('p', { class: 'hint', text: `请求方 ${request.requestedBy} · ${stamp(request.createdAt)}` }));
    const fields = [];
    for (const field of request.fields) {
      const input = el('input', {
        class: 'soul-token',
        type: field.secret ? 'password' : 'text',
        placeholder: field.label || field.name,
        autocomplete: 'off',
        spellcheck: 'false',
      });
      fields.push({ name: field.name, input });
      form.append(el('label', { class: 'hint', text: field.label || field.name }));
      form.append(input);
    }
    const save = el('button', { type: 'button', class: 'primary', text: '保存到保险库' });
    save.addEventListener('click', () => {
      const values = {};
      for (const field of fields) values[field.name] = field.input.value;
      void saveCredential(request.id, values);
    });
    const cancel = el('button', { type: 'button', text: '取消' });
    cancel.addEventListener('click', () => { void cancelCredential(request.id); });
    form.append(el('div', { class: 'soul-toolbar' }, [save, cancel]));
    editor.append(form);
  }
  editor.append(el('h2', { text: '已保存的引用' }));
  const refs = data?.refs ?? [];
  if (data && refs.length === 0) editor.append(el('p', { class: 'dim', text: '还没有保存过凭据。' }));
  const history = el('ul', { class: 'soul-history' });
  for (const entry of refs) {
    const item = el('li', { class: 'soul-version' });
    item.append(el('span', { class: 'v', text: entry.ref }));
    item.append(el('span', { class: 'meta', text: `${entry.service} · ${stamp(entry.createdAt)}` }));
    const revoke = el('button', { type: 'button', text: '撤销' });
    revoke.addEventListener('click', () => {
      if (confirm(`撤销 ${entry.ref}？撤销后使用会立即失败。`)) void revokeCredential(entry.ref);
    });
    item.append(revoke);
    history.append(item);
  }
  editor.append(history);
  root.append(editor);
}

async function loadCredentials() {
  state.credentialsLoading = true;
  state.credentialsError = null;
  renderCredentials();
  try {
    state.credentials = await api('credentials');
  } catch (error) {
    state.credentials = null;
    state.credentialsError = error.message;
  } finally {
    state.credentialsLoading = false;
    renderCredentials();
    renderPanel();
  }
}

async function saveCredential(id, values) {
  state.credentialsError = null;
  try {
    await postJson('credentials/submit', { id, values });
    await loadCredentials();
  } catch (error) {
    state.credentialsError = error.message;
    renderCredentials();
    renderPanel();
  }
}

async function cancelCredential(id) {
  state.credentialsError = null;
  try {
    await postJson('credentials/cancel', { id });
    await loadCredentials();
  } catch (error) {
    state.credentialsError = error.message;
    renderCredentials();
    renderPanel();
  }
}

async function revokeCredential(ref) {
  state.credentialsError = null;
  try {
    await postJson('credentials/revoke', { ref });
    await loadCredentials();
  } catch (error) {
    state.credentialsError = error.message;
    renderCredentials();
    renderPanel();
  }
}

async function loadSoul() {
  if (state.demo || !state.agent) {
    state.soul = null;
    state.soulLoading = false;
    state.soulError = null;
    renderSoul();
    renderPanel();
    return;
  }
  state.soulLoading = true;
  state.soulError = null;
  renderSoul();
  try {
    state.soul = await api('soul', { agent: state.agent });
  } catch (error) {
    state.soul = null;
    state.soulError = error.message;
  } finally {
    state.soulLoading = false;
    renderSoul();
    renderPanel();
  }
}

function renderHealthPanel(panel) {
  panel.append(panelHeader('健康', '内核自检、最近做梦与编译、预算与异常。'));
  const health = state.health;
  if (!health) {
    panel.append(el('p', { class: 'dim', text: state.healthError ?? '正在读取健康状态。' }));
    return;
  }
  const report = health.report;
  panel.append(el('dl', { class: 'kv' }, [
    el('dt', { text: '状态' }), el('dd', { text: report ? (report.status === 'ok' ? '正常' : '降级') : '尚未自检' }),
    el('dt', { text: '模式' }), el('dd', { text: report?.mode === 'read_only' ? '只读陪伴' : '正常' }),
    el('dt', { text: '自检时间' }), el('dd', { text: stamp(report?.checkedAt) }),
  ]));
  panel.append(el('p', { class: 'hint', text: '健康页只读；自检由 cogmem doctor 或常驻进程写入。' }));
}

const SURFACING_GATE_LABELS = {
  keychain: '密钥标记',
  policy: '通道策略',
  expired: '过期',
  modulation: '反馈调制',
  occasion_private_tier: '私密场合',
  occasion_third_party: '第三方场合',
  no_due_instant: '无到期时刻',
};

function surfacingChannelPolicy(policy) {
  return Object.entries(policy ?? {})
    .map(([tier, channels]) => `${tier} ${[channels?.proactive ? 'proactive' : '', channels?.asked ? 'asked' : ''].filter(Boolean).join('+') || 'none'}`)
    .join(' · ');
}

function renderHealth() {
  const root = $('view-health');
  root.innerHTML = '';
  if (state.demo) {
    root.append(emptyState('演示模式没有健康页', '演示数据只覆盖星图、时间线与召回；健康只对真实数据库开放。'));
    return;
  }
  if (state.healthLoading || !state.health) {
    root.append(emptyState(state.healthError ? '读不到健康状态' : '正在读取健康状态',
      state.healthError ?? '自检、最近做梦与编译、预算与异常会在这里显示。'));
    return;
  }
  const health = state.health;
  const report = health.report;
  const wrap = el('div', { class: 'section' });
  wrap.append(el('h2', { text: '内核健康' }));
  if (!report) {
    wrap.append(el('p', { class: 'dim', text: '还没有自检记录。运行 `cogmem doctor` 或让常驻进程跑一轮自检。' }));
  } else {
    wrap.append(el('dl', { class: 'kv' }, [
      el('dt', { text: '状态' }), el('dd', { text: report.status === 'ok' ? '正常' : '降级' }),
      el('dt', { text: '模式' }), el('dd', { text: report.mode === 'read_only' ? '只读陪伴' : '正常' }),
      el('dt', { text: '自检时间' }), el('dd', { text: stamp(report.checkedAt) }),
      el('dt', { text: '降级项' }), el('dd', { text: report.degradations?.length ? report.degradations.join('、') : '无' }),
    ]));
    const checks = el('ul', { class: 'plain' });
    for (const check of report.checks ?? []) {
      checks.append(el('li', {}, [
        el('span', { text: `${check.id} · ${check.status}` }),
        el('span', { class: 'dim', text: check.degradation ? ` ${check.degradation}` : '' }),
      ]));
    }
    wrap.append(checks);
  }

  wrap.append(el('h2', { text: '最近做梦', style: 'margin-top:0.875rem' }));
  if (!health.lastDream) {
    wrap.append(el('p', { class: 'dim', text: '还没有做梦记录。' }));
  } else {
    wrap.append(el('dl', { class: 'kv' }, [
      el('dt', { text: '时间' }), el('dd', { text: stamp(health.lastDream.createdAt) }),
      el('dt', { text: '状态' }), el('dd', { text: health.lastDream.status }),
      el('dt', { text: '模式' }), el('dd', { text: health.lastDream.selectedMode }),
      el('dt', { text: '处理' }), el('dd', { text: `${num(health.lastDream.episodeCount)} 集 / ${num(health.lastDream.candidateCount)} 候选 / 失败 ${num(health.lastDream.failedEpisodeCount)}` }),
    ]));
  }

  wrap.append(el('h2', { text: '最近编译', style: 'margin-top:0.875rem' }));
  wrap.append(el('dl', { class: 'kv' }, [
    el('dt', { text: '记忆帧' }), el('dd', { text: stamp(health.lastCompile?.framesUpdatedAt) }),
    el('dt', { text: '图谱' }), el('dd', { text: stamp(health.lastCompile?.atlasUpdatedAt) }),
  ]));

  wrap.append(el('h2', { text: '预算消耗', style: 'margin-top:0.875rem' }));
  if (!health.budget) {
    wrap.append(el('p', { class: 'dim', text: '还没有上下文预算回执。' }));
  } else {
    wrap.append(el('dl', { class: 'kv' }, [
      el('dt', { text: '意图' }), el('dd', { text: health.budget.intent }),
      el('dt', { text: '用量' }), el('dd', { text: `${num(health.budget.usedTokens)} / ${num(health.budget.budgetTokens)} tokens` }),
      el('dt', { text: '时间' }), el('dd', { text: stamp(health.budget.createdAt) }),
    ]));
  }

  wrap.append(el('h2', { text: '异常计数（7 天）', style: 'margin-top:0.875rem' }));
  wrap.append(el('dl', { class: 'kv' }, [
    el('dt', { text: '降级转换' }), el('dd', { text: num(health.anomalies?.degradedTransitions) }),
    el('dt', { text: '做梦部分失败' }), el('dd', { text: num(health.anomalies?.failedDreamRuns) }),
  ]));

  wrap.append(el('h2', { text: '浮现反馈闸门', style: 'margin-top:0.875rem' }));
  const surfacing = health.surfacing;
  if (!surfacing) {
    wrap.append(el('p', { class: 'dim', text: '还没有浮现计数。' }));
  } else {
    const windowLabel = `${stamp(surfacing.window?.from)} – ${stamp(surfacing.window?.to)}`;
    const counts = surfacing.counts ?? {};
    wrap.append(el('p', { class: 'hint', text: `窗口 ${windowLabel} · ${num((surfacing.window?.windowMs ?? 0) / 86_400_000)} 天；反馈行${surfacing.sources?.feedback?.readable ? '可读' : '不可读'}，浮现轨迹${surfacing.sources?.trace?.readable ? '可读' : '不可读'}。` }));
    wrap.append(el('dl', { class: 'kv' }, [
      el('dt', { text: '候选总数' }), el('dd', { text: num(counts.considered) }),
      el('dt', { text: '可浮现候选' }), el('dd', { text: num(counts.candidates) }),
      el('dt', { text: '闸门挡下' }), el('dd', { text: num(counts.withheld) }),
      el('dt', { text: '无到期排除' }), el('dd', { text: num(counts.excluded) }),
      el('dt', { text: '尝试浮现' }), el('dd', { text: num(counts.attempted) }),
      el('dt', { text: '实际浮现' }), el('dd', { text: num(counts.surfaced) }),
      el('dt', { text: '浮现失败' }), el('dd', { text: num(counts.runFailed) }),
      el('dt', { text: '按住未发' }), el('dd', { text: num(counts.held) }),
      el('dt', { text: '被忽略' }), el('dd', { text: num(counts.ignored) }),
      el('dt', { text: '被接住' }), el('dd', { text: num(counts.engaged) }),
      el('dt', { text: '被停止' }), el('dd', { text: num(counts.stopped) }),
      el('dt', { text: '决策次数' }), el('dd', { text: num(counts.decisions) }),
    ]));
    if (!surfacing.sources?.trace?.readable) {
      wrap.append(el('p', { class: 'hint', text: '候选/闸门/浮现计数来自常驻进程的 shell-events.jsonl；轨迹不可读时只显示反馈计数。' }));
    }
    const gates = surfacing.gates ?? [];
    if (gates.length > 0) {
      const list = el('ul', { class: 'plain' });
      for (const entry of gates) {
        list.append(el('li', {}, [
          el('span', { text: SURFACING_GATE_LABELS[entry.gate] ?? entry.gate }),
          el('span', { class: 'dim', text: ` ${num(entry.count)}` }),
        ]));
      }
      wrap.append(el('p', { class: 'hint', text: '按闸门分（同一候选可同时被通道与场合挡下）。' }), list);
    }
    const priors = surfacing.priors ?? {};
    const feedback = priors.feedback ?? {};
    const policy = priors.channelPolicy ?? {};
    wrap.append(el('p', { class: 'hint', text: '当前生效的先验（尚未从样本学习，按固定规则执行）：' }));
    wrap.append(el('dl', { class: 'kv' }, [
      el('dt', { text: '连续忽略阈值' }), el('dd', { text: num(feedback.ignoredThreshold) }),
      el('dt', { text: '最大等级' }), el('dd', { text: num(feedback.maxLevel) }),
      el('dt', { text: '基础冷却' }), el('dd', { text: `${num((feedback.baseCooldownMs ?? 0) / 3_600_000)} 小时` }),
      el('dt', { text: '通道策略' }), el('dd', { text: surfacingChannelPolicy(policy) }),
      el('dt', { text: '闸门' }), el('dd', { text: (priors.gates ?? []).join('、') }),
    ]));
  }

  wrap.append(el('h2', { text: '最近快照', style: 'margin-top:0.875rem' }));
  if (!health.snapshot) {
    wrap.append(el('p', { class: 'dim', text: '还没有整脑快照。' }));
  } else {
    wrap.append(el('dl', { class: 'kv' }, [
      el('dt', { text: '文件' }), el('dd', { text: health.snapshot.file }),
      el('dt', { text: '时间' }), el('dd', { text: health.snapshot.createdAt || '—' }),
      el('dt', { text: '校验' }), el('dd', { text: health.snapshot.ok ? '通过' : '未通过' }),
    ]));
  }
  root.append(wrap);
}

async function loadHealth() {
  if (state.demo) {
    state.health = null;
    state.healthLoading = false;
    state.healthError = null;
    renderHealth();
    renderPanel();
    return;
  }
  state.healthLoading = true;
  state.healthError = null;
  renderHealth();
  try {
    state.health = await api('health', { project: state.projectId });
  } catch (error) {
    state.health = null;
    state.healthError = error.message;
  } finally {
    state.healthLoading = false;
    renderHealth();
    renderPanel();
  }
}

async function saveSoul(content) {
  if (!state.agent) return;
  state.soulLoading = true;
  state.soulError = null;
  renderSoul();
  try {
    await postJson('soul', { agentId: state.agent, content, reason: '星海编辑' });
    state.soul = await api('soul', { agent: state.agent });
  } catch (error) {
    state.soulError = error.message;
  } finally {
    state.soulLoading = false;
    renderSoul();
    renderPanel();
  }
}

async function rollbackSoul(version) {
  if (!state.agent) return;
  state.soulLoading = true;
  state.soulError = null;
  renderSoul();
  try {
    await postJson('soul/rollback', { agentId: state.agent, version, reason: '星海回滚' });
    state.soul = await api('soul', { agent: state.agent });
  } catch (error) {
    state.soulError = error.message;
  } finally {
    state.soulLoading = false;
    renderSoul();
    renderPanel();
  }
}

function renderOverviewPanel(panel) {
  const snapshot = state.snapshot;
  if (!snapshot) { panel.append(loadingPanel()); return; }
  panel.append(panelHeader('快照', `这份快照读的是水位线 ${num(snapshot.watermark)} 那一刻的库。`));
  const counts = el('div', { class: 'section' });
  counts.append(el('h2', { class: 'head', text: '规模' }));
  counts.append(el('dl', { class: 'kv' }, [
    el('dt', { text: '节点' }), el('dd', { text: num(snapshot.counts.nodesTotal) }),
    el('dt', { text: '边' }), el('dd', { text: num(snapshot.counts.edgesTotal) }),
    el('dt', { text: '本视图节点' }), el('dd', { text: num(snapshot.nodes.length) + (state.agent ? ` / ${num(snapshot.counts.nodesTotal)}` : '') }),
    el('dt', { text: '生成时刻' }), el('dd', { text: stamp(snapshot.generatedAt) }),
  ]));
  panel.append(counts);

  const types = Object.entries(snapshot.counts.nodesByType).sort((left, right) => right[1] - left[1]);
  const typeSection = el('div', { class: 'section' });
  typeSection.append(el('h2', { class: 'head', text: state.agent ? '按类型（本视图）' : '按类型' }));
  typeSection.append(el('ul', { class: 'plain' }, types.map(([type, count]) => el('li', {}, [
    el('span', {}, [el('span', { class: 'swatch', style: `color:${colorFor({ type })};margin-right:0.375rem` }), type]),
    el('span', { class: 'num', text: num(count) }),
  ]))));
  panel.append(typeSection);

  const layout = el('div', { class: 'section' });
  layout.append(el('h2', { class: 'head', text: '星图的编码' }));
  layout.append(el('p', {
    class: 'dim prose',
    text: snapshot.layout.armRule === 'topic_path'
      ? `力导向团簇 = 帧/图谱关系，颜色 = 六类角色（${num(snapshot.layout.arms.length)} 个顶层分组）。点大小 = 连边数、support 与 activation。`
      : `这个项目没有主题节点，所以力导向从项目（${snapshot.projectId}）起算。颜色 = 六类角色，点大小 = 连边数、support 与 activation。`,
  }));
  layout.append(el('ul', { class: 'plain' }, snapshot.layout.arms.slice(0, 12).map((arm) =>
    el('li', {}, [el('span', { text: arm.id }), el('span', { class: 'num', text: num(arm.nodes) })]))));
  panel.append(layout);

  const edges = Object.entries(snapshot.counts.edgesByRelation).sort((left, right) => right[1] - left[1]);
  if (edges.length) {
    const edgeSection = el('div', { class: 'section' });
    edgeSection.append(el('h2', { class: 'head', text: '关系' }));
    edgeSection.append(el('p', { class: 'dim', text: `本视图画 ${num(snapshot.edges?.length ?? 0)} 条边，账本共 ${num(snapshot.counts.edgesTotal)} 条。` }));
    edgeSection.append(el('ul', { class: 'plain' }, edges.slice(0, 12).map(([relation, count]) =>
      el('li', {}, [el('span', { text: relation }), el('span', { class: 'num', text: num(count) })]))));
    panel.append(edgeSection);
  }
  if (state.demo) {
    panel.append(el('div', { class: 'section' }, [
      el('p', { class: 'dim', text: '当前是虚构演示数据，不来自任何真实数据库。' }),
      el('button', { class: 'chip', type: 'button', text: '回到真实数据', onclick: () => { location.search = ''; } }),
    ]));
  } else {
    panel.append(el('div', { class: 'section' }, [
      el('p', { class: 'hint', text: '想看界面长什么样而没有语料？' }),
      el('button', { class: 'chip', type: 'button', text: '打开虚构演示数据', onclick: () => { location.search = '?demo=1'; } }),
    ]));
  }
}

function renderNodePanel(panel, options) {
  const node = options.node ?? state.selectedNode;
  panel.append(panelHeader(node.label || node.id, `${ROLE_LABEL[roleOf(node)]} · ${node.type} · LOD ${node.lod}`));
  if (options.error) {
    panel.append(el('div', { class: 'section' }, [el('p', { class: 'dim', text: `详情读取失败：${options.error}` })]));
    return;
  }
  if (options.detail === 'loading') { panel.append(loadingPanel()); return; }
  const detail = options.detail;
  const facts = el('div', { class: 'section' });
  facts.append(el('dl', { class: 'kv' }, [
    el('dt', { text: '角色' }), el('dd', { text: ROLE_LABEL[roleOf(node)] }),
    el('dt', { text: '连边' }), el('dd', { text: num(node.degree ?? 0) }),
    el('dt', { text: 'support' }), el('dd', { text: num(node.support) }),
    el('dt', { text: 'activation' }), el('dd', { text: (node.activation ?? 0).toFixed(3) }),
    el('dt', { text: '状态' }), el('dd', { text: detail?.status ?? '—' }),
    el('dt', { text: '时间' }), el('dd', { text: stamp(node.occurredAt) }),
    el('dt', { text: 'id' }), el('dd', { text: node.id }),
  ]));
  panel.append(facts);
  if (detail?.summary) {
    const summary = el('div', { class: 'section' });
    summary.append(el('h2', { class: 'head', text: '原文' }));
    summary.append(el('p', { class: 'prose', text: detail.summary }));
    panel.append(summary);
  }
  const evidence = detail?.evidence ?? [];
  const evidenceSection = el('div', { class: 'section' });
  evidenceSection.append(el('h2', { class: 'head', text: `证据（${num(detail?.evidenceTotal ?? evidence.length)}）` }));
  if (!evidence.length) evidenceSection.append(el('p', { class: 'dim', text: '这个节点没有直接的下钻证据。' }));
  evidenceSection.append(el('ul', { class: 'evidence' }, evidence.map((item) => {
    const locator = item.sourceLocator;
    return el('li', {}, [
      el('span', {
        class: 'dim',
        text: locator?.localDate ? `${locator.localDate} · ${item.eventId.slice(0, 18)}…` : item.eventId,
      }),
      item.excerpt ? el('p', { class: 'prose excerpt', text: item.excerpt }) : null,
      el('div', { class: 'cmd' }, [
        el('span', { text: locator?.command || item.drilldown }),
        el('button', { type: 'button', text: '复制', onclick: (event) => copyCommand(event, locator?.command || item.drilldown) }),
      ]),
    ]);
  })));
  panel.append(evidenceSection);

  const neighbors = detail?.neighbors ?? [];
  const edgeSection = el('div', { class: 'section' });
  edgeSection.append(el('h2', { class: 'head', text: `一跳邻域（${num(neighbors.length)}）` }));
  if (!neighbors.length) edgeSection.append(el('p', { class: 'dim', text: '没有相邻节点。' }));
  edgeSection.append(el('ul', { class: 'edges' }, neighbors.map((edge) => {
    const otherId = edge.source === node.id ? edge.target : edge.source;
    const other = state.nodeIndex.get(otherId);
    return el('li', {}, [
      el('span', { class: 'rel', text: edge.relation }),
      other
        ? el('button', { type: 'button', text: other.label || otherId, onclick: () => selectNode(other, { fromSnapshot: true }) })
        : el('span', { class: 'dim', text: otherId }),
    ]);
  })));
  panel.append(edgeSection);
}

function copyCommand(event, text) {
  navigator.clipboard?.writeText(text).then(() => {
    event.target.textContent = '已复制';
    setTimeout(() => { event.target.textContent = '复制'; }, 1400);
  }).catch(() => {});
}

function renderTimelinePanel(panel) {
  panel.append(panelHeader('时间线', '按天 × 事件类型统计，来自 memory_events。'));
  if (state.range) {
    panel.append(el('div', { class: 'section' }, [el('p', { class: 'dim', text: `已选范围 ${state.range[0]} → ${state.range[1]}，星图同步高亮。` })]));
  } else if (state.selectedDay) {
    panel.append(el('div', { class: 'section' }, [el('p', { class: 'dim', text: `已选 ${state.selectedDay}。` })]));
  } else {
    panel.append(el('div', { class: 'section' }, [el('p', { class: 'dim', text: '拖动刷选范围，或点一天看当天。' })]));
  }
}

function renderRecallsPanel(panel) {
  panel.append(panelHeader('召回检查', '只读已经落库的决策 trace，不在页面里现场跑 explain。'));
  const recalls = state.recalls;
  const section = el('div', { class: 'section' });
  section.append(el('dl', { class: 'kv' }, [
    el('dt', { text: 'trace 表' }), el('dd', { text: recalls?.available ? '存在' : '不存在' }),
    el('dt', { text: '决策条数' }), el('dd', { text: num(recalls?.recalls?.length ?? 0) }),
    el('dt', { text: '范围' }), el('dd', { text: state.agent ?? '全部' }),
  ]));
  panel.append(section);
}

function loadingPanel() {
  return el('div', { class: 'section' }, [
    el('div', { class: 'skeleton w60' }), el('div', { class: 'skeleton' }),
    el('div', { class: 'skeleton w80' }), el('div', { class: 'skeleton w40' }),
  ]);
}

/* ---------------------------------------------------------- scope and boot */

function renderHeader() {
  const snapshot = state.snapshot;
  const demo = state.demo || snapshot?.source === DEMO_SOURCE;
  const badge = $('source-badge');
  badge.className = `badge ${demo ? 'badge-demo' : 'badge-live'}`;
  $('source-label').textContent = demo ? 'demo · 虚构' : 'live';
  $('waterline').innerHTML = demo
    ? '演示数据 · <b>无水位线</b>'
    : `水位线 <b>#${num(snapshot?.watermark ?? 0)}</b> · 生成 <b>${stamp(snapshot?.generatedAt)}</b> · 范围 <b>${state.agent ? escapeHtml(state.agent) : '全部'}</b>`;
  $('legend-scope').textContent = state.agent ? `范围 ${state.agent}` : '全部';
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function renderScope() {
  const snapshot = state.snapshot;
  const roster = $('roster');
  roster.innerHTML = '';
  $('scope-all-count').textContent = snapshot ? ` ${num(snapshot.counts.nodesTotal)}` : '';
  $('scope-all').setAttribute('aria-pressed', String(state.agent === null));
  for (const agent of snapshot?.agents ?? []) {
    const chip = el('button', {
      class: `chip${agent.kind === 'host' ? ' host' : ''}`,
      type: 'button',
      'aria-pressed': String(state.agent === agent.id),
      title: `${agent.events} 条事件 · ${agent.nodes} 个节点${agent.kind === 'host' ? ' · 已接入宿主' : ''}`,
      onclick: () => { state.agent = state.agent === agent.id ? null : agent.id; reload(); },
    }, [agent.id, el('span', { class: 'count', text: num(agent.events) })]);
    roster.append(chip);
  }
}

function renderLegend() {
  const snapshot = state.snapshot;
  const counts = snapshot?.counts.nodesByRole ?? STAR_ROLES.reduce((result, role) => {
    result[role.id] = (snapshot?.nodes ?? []).filter((node) => roleOf(node) === role.id).length;
    return result;
  }, {});
  $('legend-items').innerHTML = '';
  for (const role of STAR_ROLES) {
    const hidden = state.hiddenRoles.has(role.id);
    const button = el('button', {
      class: 'legend-role',
      type: 'button',
      'aria-pressed': String(!hidden),
      title: hidden ? `显示${role.label}` : `只暗下${role.label}`,
      onclick: () => {
        if (hidden) state.hiddenRoles.delete(role.id);
        else state.hiddenRoles.add(role.id);
        applyWeights();
        renderLegend();
        map.needsFrame = true;
      },
    }, [
      el('span', { class: 'swatch', style: `color:${role.color}` }),
      role.label,
      el('span', { class: 'count', text: num(counts?.[role.id] ?? 0) }),
    ]);
    $('legend-items').append(el('li', {}, [button]));
  }
  const truncation = snapshot?.truncation;
  const notice = $('truncation-notice');
  if (truncation) {
    notice.classList.remove('hidden');
    const parts = Object.entries(truncation.byType).map(([type, entry]) => `${type} ${num(entry.returned)}/${num(entry.total)}`);
    notice.textContent = `已截断：快照上限 ${num(truncation.limit)} 个节点，省略 ${num(truncation.omitted)} 个（${parts.join('、')}）。截断按激活度、support 与时间从高到低。`;
  } else {
    notice.classList.add('hidden');
  }
}

function showView(view) {
  state.view = view;
  for (const name of ['starmap', 'timeline', 'recalls', 'soul', 'credentials', 'health']) {
    $(`tab-${name}`).setAttribute('aria-selected', String(name === view));
    $(`view-${name}`).classList.toggle('on', name === view);
  }
  if (view === 'recalls') renderRecalls();
  if (view === 'timeline') renderTimeline();
  if (view === 'soul') void loadSoul();
  if (view === 'credentials') void loadCredentials();
  if (view === 'health') void loadHealth();
  if (view === 'starmap') map.needsFrame = true;
  renderPanel();
}

async function loadDemo() {
  state.demo = true;
  const response = await fetch('./demo.json');
  const demo = await response.json();
  state.projectId = demo.projectId;
  state.snapshot = { ...demo.snapshot, source: DEMO_SOURCE };
  state.timeline = { ...demo.timeline, source: DEMO_SOURCE };
  state.recalls = { ...demo.recalls, source: DEMO_SOURCE };
  applyLoaded();
}

function applyLoaded() {
  state.selectedNode = null;
  state.selectedNeighbors = new Set();
  state.selectedDay = null;
  state.range = null;
  map.marker && (map.marker.visible = false);
  if (map.edgeHighlight) map.edgeHighlight.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
  $('project-select').innerHTML = '';
  for (const project of state.snapshot.projects ?? []) {
    $('project-select').append(el('option', { value: project.projectId, selected: project.projectId === state.projectId, text: `${project.projectId} · ${num(project.nodes)} 节点 / ${num(project.events)} 事件` }));
  }
  if (!state.snapshot.projects?.length) {
    $('project-select').append(el('option', { text: state.projectId || '（无项目）' }));
  }
  state.nodeIndex = new Map(state.snapshot.nodes.map((node) => [node.id, node]));
  renderHeader();
  renderScope();
  renderLegend();
  buildMap(state.snapshot);
  renderTimeline();
  renderRecalls();
  if (state.view === 'soul') void loadSoul();
  if (state.view === 'credentials') void loadCredentials();
  if (state.view === 'health') void loadHealth();
  renderPanel();
  applyHashTarget();
}

function applyHashTarget() {
  const hash = decodeURIComponent(location.hash.replace(/^#/u, ''));
  if (hash === 'credentials') { showView('credentials'); return; }
  if (!hash.startsWith('node=')) return;
  const node = state.nodeIndex.get(hash.slice('node='.length));
  if (node) selectNode(node, { fromSnapshot: true });
}

async function reload() {
  if (state.demo) { state.agent = null; return; }
  renderPanel();
  const params = { project: state.projectId, agent: state.agent };
  const [snapshot, timeline, recalls] = await Promise.all([
    api('snapshot', params),
    api('timeline', params),
    api('recalls', { ...params, limit: 50 }),
  ]);
  state.snapshot = snapshot;
  state.timeline = timeline;
  state.recalls = recalls;
  if (!state.projectId) state.projectId = snapshot.projectId || null;
  applyLoaded();
}

async function boot() {
  if (new URLSearchParams(location.search).get('demo') === '1') {
    try { await loadDemo(); return; } catch (error) { /* fall through to the live path */ }
  }
  try {
    await reload();
  } catch (error) {
    $('panel').innerHTML = '';
    $('panel').append(emptyState('读不到记忆库', `${error.message}。确认 cogmem observatory 正在运行，并且这个工作区里有记忆数据库。`));
  }
}

$('tab-starmap').addEventListener('click', () => showView('starmap'));
$('tab-timeline').addEventListener('click', () => showView('timeline'));
$('tab-recalls').addEventListener('click', () => showView('recalls'));
$('tab-soul').addEventListener('click', () => showView('soul'));
$('tab-credentials').addEventListener('click', () => showView('credentials'));
$('tab-health').addEventListener('click', () => showView('health'));
$('scope-all').addEventListener('click', () => { state.agent = null; reload(); });
$('project-select').addEventListener('change', (event) => { state.projectId = event.target.value; reload(); });
for (const button of document.querySelectorAll('.lod-row button')) {
  button.addEventListener('click', () => {
    state.lodCap = Number(button.dataset.lod);
    for (const other of document.querySelectorAll('.lod-row button')) {
      other.setAttribute('aria-pressed', String(Number(other.dataset.lod) === state.lodCap));
    }
    applyLodBands();
    map.needsFrame = true;
    updateMapStats();
  });
}
window.addEventListener('resize', () => { state.mobile = matchMedia('(max-width: 900px)').matches; });
initMap();
boot();
