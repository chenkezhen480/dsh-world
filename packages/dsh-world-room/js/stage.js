// Renderer, light, cameras and the ink-outline pass. The room is built Z-up; `world` turns it upright for three.js.
import * as THREE from 'three';
import { patternTextures } from './kit.js';

const PAPER = '#F7EEE2';                 // page background, as in the concept sheet
const INK = '#5B3A2C';
const VIEW = { target: [0.8, 0.45, 0.7], elevation: 35, width: 10.6, height: 7.0 };     // the cut-away view of the concept art
/** What only her eyes see: the walls and ceiling your view leaves open, and the sky. */
export const INSIDE_LAYER = 1;
/** How far she sees before things fade into the haze, and its colour (the sky's horizon). */
const HAZE = { color: '#E4F0F4', near: 28, far: 150 };
const EYE = { fov: 62, height: 0.6 };

/** Three flat tones instead of a smooth falloff. */
function toonRamp() {
  const t = new THREE.DataTexture(new Uint8Array([175, 220, 255]), 3, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

/**
 * What the outline pass sees of a mesh that should leave no ink (the sky, the rain): nothing, and no depth either.
 */
export function inkless(side = THREE.FrontSide) {
  return new THREE.ShaderMaterial({ side, depthWrite: false, vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }', fragmentShader: 'void main() { gl_FragColor = vec4(0.5, 0.5, 1.0, 0.0); }' });
}

/** look ('toon' | 'glow' | pattern name) -> material; one instance per look. */
export function createMaterials() {
  const ramp = toonRamp(), textures = patternTextures(), cache = new Map();
  return (look) => {
    if (!cache.has(look)) {
      cache.set(look, look === 'glow' ? new THREE.MeshBasicMaterial({ vertexColors: true })
        : look === 'toon' ? new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: ramp })
          : new THREE.MeshToonMaterial({ map: textures[look], gradientMap: ramp }));
    }
    return cache.get(look);
  };
}

/** View-space normal in rgb, the part id in alpha: what the outline pass compares between neighbouring pixels. */
function surfaceMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    vertexShader: `
      attribute float pid;
      varying vec3 vNormal;
      varying float vPid;
      void main() {
        vNormal = normalMatrix * normal;
        vPid = pid;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vNormal;
      varying float vPid;
      void main() {
        vec3 n = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
        gl_FragColor = vec4(n * 0.5 + 0.5, vPid);
      }`,
  });
}

/**
 * Ink where depth jumps, where the surface turns sharply, and (lighter) where one part meets another. Depth is read back
 * as distance from the camera, so the same thresholds hold in both cameras; ink fades out with the haze.
 */
function inkMaterial() {
  return new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false,
    uniforms: {
      tColor: { value: null }, tSurface: { value: null }, tDepth: { value: null }, texel: { value: new THREE.Vector2() }, ink: { value: new THREE.Color(INK) },
      near: { value: 1 }, far: { value: 100 }, ortho: { value: true }, fogNear: { value: 1e9 }, fogFar: { value: 2e9 }, edgeAbs: { value: 0.09 }, edgeRel: { value: 0 },
    },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `
      uniform sampler2D tColor, tSurface, tDepth;
      uniform vec2 texel;
      uniform vec3 ink;
      uniform float near, far, fogNear, fogFar, edgeAbs, edgeRel;
      uniform bool ortho;
      varying vec2 vUv;
      float distanceAt(vec2 at) {
        float d = texture2D(tDepth, at).r;
        return ortho ? near + d * (far - near) : near * far / (far - d * (far - near));
      }
      void main() {
        vec4 here = texture2D(tSurface, vUv);
        float z = distanceAt(vUv), edge = 0.0, seam = 0.0;
        for (int i = 0; i < 4; i++) {
          vec2 at = vUv + texel * (i == 0 ? vec2(1.0, 0.0) : i == 1 ? vec2(-1.0, 0.0) : i == 2 ? vec2(0.0, 1.0) : vec2(0.0, -1.0));
          vec4 there = texture2D(tSurface, at);
          edge = max(edge, step(edgeAbs + edgeRel * z, abs(distanceAt(at) - z)));
          edge = max(edge, step(0.55, distance(there.rgb, here.rgb)));
          seam = max(seam, step(0.002, abs(there.a - here.a)));
        }
        vec4 color = texture2D(tColor, vUv);
        float fade = 1.0 - smoothstep(fogNear, fogFar, z);
        gl_FragColor = vec4(mix(color.rgb, ink, max(edge * 0.85, seam * 0.5) * fade), 1.0);
        #include <colorspace_fragment>
      }`,
  });
}

/**
 * createStage(canvas) owns the renderer, scene, cameras and render targets.
 * `world` is where Z-up content goes. `camera` is your cut-away view; `lookFrom(at, heading, pitch)` switches to her
 * eyes (room coordinates, heading in radians from +x toward +y). `resize` and `render` are driven by the page.
 */
export function createStage(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.shadowMap.enabled = true;

  const scene = new THREE.Scene();
  const world = new THREE.Group();
  world.rotation.x = -Math.PI / 2;
  scene.add(world);
  const haze = new THREE.Fog(HAZE.color, HAZE.near, HAZE.far);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 260);
  const target = new THREE.Vector3(VIEW.target[0], VIEW.target[2], -VIEW.target[1]);
  const elev = THREE.MathUtils.degToRad(VIEW.elevation);
  camera.position.copy(target).add(new THREE.Vector3(0, Math.sin(elev), Math.cos(elev)).multiplyScalar(30));
  camera.lookAt(target);

  const eye = new THREE.PerspectiveCamera(EYE.fov, 1, 0.05, 600);
  eye.layers.enable(INSIDE_LAYER);
  let looking = false;
  /** Room coordinates (Z-up) to the upright scene. */
  const upright = (x, y, z) => new THREE.Vector3(x, z, -y);

  const color = new THREE.WebGLRenderTarget(1, 1, { samples: 4, colorSpace: THREE.SRGBColorSpace });
  const surface = new THREE.WebGLRenderTarget(1, 1, { depthTexture: new THREE.DepthTexture(1, 1), minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  const surfaceLook = surfaceMaterial(), ink = inkMaterial();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), ink);
  const flat = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const paper = new THREE.Color(PAPER), sky = new THREE.Color(HAZE.color);

  function resize(width, height, pixelRatio) {
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(width, height, false);
    const w = Math.max(1, Math.round(width * pixelRatio)), h = Math.max(1, Math.round(height * pixelRatio));
    color.setSize(w, h);
    surface.setSize(w, h);
    ink.uniforms.texel.value.set(pixelRatio / w, pixelRatio / h);
    const aspect = width / height, halfW = Math.max(VIEW.width / 2, VIEW.height / 2 * aspect);     // never crop the room
    camera.left = -halfW; camera.right = halfW; camera.top = halfW / aspect; camera.bottom = -halfW / aspect;
    camera.updateProjectionMatrix();
    eye.aspect = aspect;
    eye.updateProjectionMatrix();
  }

  function lookFrom(at, heading, pitch = 0) {
    looking = true;
    const from = upright(at[0], at[1], (at[2] ?? 0) + EYE.height);
    eye.position.copy(from);
    eye.lookAt(from.clone().add(upright(Math.cos(heading) * Math.cos(pitch), Math.sin(heading) * Math.cos(pitch), Math.sin(pitch))));
  }

  /** What part of the room the view is on: the point it looks at, in room coordinates, and how far it sees. */
  function viewpoint() {
    if (looking) return { x: eye.position.x, y: -eye.position.z, reach: HAZE.far * 0.75 };
    const t = target, halfW = (camera.right - camera.left) / 2 / camera.zoom, halfH = (camera.top - camera.bottom) / 2 / camera.zoom;
    return { x: t.x, y: -t.z, reach: Math.hypot(halfW, halfH / Math.sin(elev)) + 4 };
  }

  function render() {
    const cam = looking ? eye : camera;
    scene.fog = looking ? haze : null;               // your view is small enough to be all in reach: no haze in it
    ink.uniforms.near.value = cam.near; ink.uniforms.far.value = cam.far; ink.uniforms.ortho.value = !looking;
    ink.uniforms.fogNear.value = looking ? HAZE.near : 1e9; ink.uniforms.fogFar.value = looking ? HAZE.far : 2e9;
    // Lines where depth jumps by more than a fixed step in your flat view, or by more than a share of the distance in hers.
    ink.uniforms.edgeAbs.value = looking ? 0.02 : 0.09; ink.uniforms.edgeRel.value = looking ? 0.015 : 0;

    renderer.setRenderTarget(color);
    renderer.setClearColor(looking ? sky : paper, 1);
    renderer.clear();
    renderer.render(scene, cam);

    const looks = [];                                // a mesh may bring its own surface material (her cut-out, the sky)
    scene.traverse((o) => { if (o.isMesh || o.isLineSegments) { looks.push([o, o.material]); o.material = o.userData.surface ?? surfaceLook; } });
    renderer.setRenderTarget(surface);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    const shadows = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;           // same lights, same frame: no second shadow pass
    renderer.render(scene, cam);
    renderer.shadowMap.autoUpdate = shadows;
    for (const [o, material] of looks) o.material = material;

    ink.uniforms.tColor.value = color.texture;
    ink.uniforms.tSurface.value = surface.texture;
    ink.uniforms.tDepth.value = surface.depthTexture;
    renderer.setRenderTarget(null);
    renderer.render(quad, flat);
  }

  function dispose() {
    color.dispose(); surface.dispose(); surfaceLook.dispose(); ink.dispose(); quad.geometry.dispose(); renderer.dispose();
  }

  /** The colour far things fade into in her eyes, which follows the sky's horizon. */
  function hazeColor(value) { haze.color.set(value); sky.set(value); }

  return { renderer, scene, world, camera, target, resize, render, dispose, lookFrom, viewpoint, hazeColor, get looking() { return looking; } };
}

/**
 * Soft sky fill, a key light from the open front, sun through the window, a warm glow at every lamp. Returns
 * light(values), which sets them for a time of day (state.js's daylight); until then it is midday.
 */
export function addLights(world, sun, lamps) {
  const fill = new THREE.HemisphereLight('#FFFFFF', '#F1E6D8', 2.55);
  world.add(fill);

  const key = new THREE.DirectionalLight('#FFF4E4', 1.1);
  key.position.set(-4, -9, 10);
  key.target.position.set(0.8, 0.4, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  Object.assign(key.shadow.camera, { left: -7, right: 7, top: 6, bottom: -6, near: 1, far: 30 });
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.012;
  key.shadow.radius = 3;
  world.add(key, key.target);

  const beam = new THREE.SpotLight('#FFD79A', 3, 0, THREE.MathUtils.degToRad(15), 0.15, 0);
  beam.position.copy(sun.from);
  beam.target.position.copy(sun.to);
  beam.castShadow = true;
  beam.shadow.mapSize.set(2048, 2048);
  beam.shadow.bias = -0.0008;
  world.add(beam, beam.target);

  const glows = lamps.map((at) => {
    const glow = new THREE.PointLight('#FFC27A', 0.5, 2.4, 1.2);
    glow.position.copy(at);
    world.add(glow);
    return glow;
  });
  return function light(values) {
    fill.color.set(values.fill[0]); fill.groundColor.set(values.fill[1]); fill.intensity = values.fill[2];
    key.color.set(values.key[0]); key.intensity = values.key[1];
    beam.color.set(values.beam[0]); beam.intensity = values.beam[1];
    for (const glow of glows) glow.intensity = values.lamps;
  };
}
