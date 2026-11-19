// Her as a flat picture in the room: transparent animation clips, always turned to the camera, feet at its origin.
import * as THREE from 'three';

const ALPHA_CUT = 0.5;
const PART_ID = 252 / 255;      // above the ids the set hands out, so she never shares one with furniture
const UP = new THREE.Vector3(0, 0, 1);      // the room is built Z-up

/** What the outline pass reads for her: one flat surface, so ink is drawn round her silhouette only. */
function surfaceMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { map: { value: null } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform sampler2D map;
      varying vec2 vUv;
      void main() {
        if (texture2D(map, vUv).a < ${ALPHA_CUT}) discard;
        gl_FragColor = vec4(0.5, 0.5, 1.0, ${PART_ID.toFixed(4)});
      }`,
  });
}

/**
 * createSprite(art, hooks) owns her pictures and the clip that is playing.
 *   art.still      { url, feet, tall }   a still picture, shown until a clip has a frame and whenever clips cannot play
 *   art.clips      name -> url           transparent videos, all framed alike
 *   art.clipFrame  { feet, tall }        the framing of every clip
 *   art.loops      name -> [from, to]    seconds: a clip that only repeats this stretch (it has a lead-in and a tail)
 *   feet / tall    where her feet are (fraction of the picture's height, from the bottom) and how much of it she fills
 *   hooks.change()  a new frame is ready to draw;  hooks.fault(message)  clips or the still could not be read
 * `object` goes into the room; `play(names)` loops through those clips (null hides her); `mirror(on)` flips her
 * left to right; `face(camera)` turns her to the viewer, upright; `tint(color)` dims her picture to the light round her
 * (she is drawn unlit, so at night she would glow otherwise).
 */
export function createSprite(art, hooks) {
  const look = new THREE.MeshBasicMaterial({ alphaTest: ALPHA_CUT, alphaToCoverage: true, side: THREE.DoubleSide });
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, alphaTest: ALPHA_CUT });
  const surface = surfaceMaterial();
  const picture = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), look);
  picture.castShadow = true;
  picture.customDepthMaterial = depth;
  picture.userData.surface = surface;
  const object = new THREE.Group();
  object.name = 'her';
  object.add(picture);
  object.visible = false;

  const videos = new Map();           // clip name -> { video, texture }
  let still = null;                   // { texture, aspect }
  let queue = [], at = 0, playing = null, clipsBroken = false;
  let flipped = false;
  let onScreen = null;                // the clip whose frames are on the plane; null while the still stands in

  /** Puts one picture on the plane, scaled so she is 1 unit tall with her feet on the origin. */
  function put(texture, aspect, frame) {
    look.map = depth.map = surface.uniforms.map.value = texture;
    look.needsUpdate = depth.needsUpdate = true;
    const height = 1 / frame.tall;
    picture.scale.set(height * aspect * (flipped ? -1 : 1), height, 1);
    picture.position.y = -frame.feet * height;
    object.visible = true;
    hooks.change();
  }
  function putStill() { if (still && queue.length && !onScreen) put(still.texture, still.aspect, art.still); }

  function clip(name) {
    if (!videos.has(name)) {
      const video = Object.assign(document.createElement('video'), { src: art.clips[name], muted: true, playsInline: true, preload: 'auto' });
      const texture = new THREE.VideoTexture(video);
      texture.colorSpace = THREE.SRGBColorSpace;
      video.addEventListener('ended', () => { if (playing === name) next(); });
      video.addEventListener('error', () => broken(name));
      const stretch = art.loops?.[name];
      const frame = () => {
        // also catches the start: a seek asked for before the clip has loaded is dropped
        if (stretch && !video.seeking && (video.currentTime >= stretch[1] || video.currentTime < stretch[0])) video.currentTime = stretch[0];
        // The first frame of a newly started clip puts it on the plane. Waiting for `loadeddata` instead misses a
        // clip that had already loaded: rewinding it drops its ready state and that event never comes again.
        if (playing === name && onScreen !== name) { onScreen = name; put(texture, video.videoWidth / video.videoHeight, art.clipFrame); }
        else if (playing === name) hooks.change();
        video.requestVideoFrameCallback(frame);
      };
      video.requestVideoFrameCallback(frame);
      videos.set(name, { video, texture });
    }
    return videos.get(name);
  }
  function broken(name) {
    if (clipsBroken) return;
    clipsBroken = true;
    playing = null; onScreen = null;
    hooks.fault(`她的动画播不了（${name}），先用立绘代替。`);
    putStill();
  }
  function start(name) {
    const { video } = clip(name);
    if (playing && playing !== name) videos.get(playing).video.pause();
    playing = name;
    video.loop = queue.length === 1;
    video.currentTime = art.loops?.[name]?.[0] ?? 0;
    putStill();                         // until this clip has a frame, the clip before stays up, or the still
    // Switching clips pauses the one before; its pending play() then rejects with AbortError, which is not a failure.
    video.play().catch((error) => { if (error?.name !== 'AbortError') broken(name); });
  }
  function next() { at = (at + 1) % queue.length; start(queue[at]); }

  // Fetch every clip up front: one asked for only when she sets off would still be loading while she slides along.
  for (const name of Object.keys(art.clips)) clip(name);

  new THREE.TextureLoader().loadAsync(art.still.url).then((texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    still = { texture, aspect: texture.image.width / texture.image.height };
    putStill();
  }, () => hooks.fault('她的立绘没读到。'));

  return {
    object,
    play(names) {
      const same = names && names.length === queue.length && names.every((name, i) => name === queue[i]);
      if (same) return;
      queue = names ?? []; at = 0;
      if (!queue.length) {
        if (playing) videos.get(playing).video.pause();
        playing = null; onScreen = null; object.visible = false; hooks.change();
      } else if (clipsBroken) putStill(); else start(queue[0]);
    },
    mirror(on) {
      if (on === flipped) return;
      flipped = on;
      picture.scale.x = Math.abs(picture.scale.x) * (flipped ? -1 : 1);
      hooks.change();
    },
    /**
     * Turns her to the viewer while she stays upright, like a card standing on the floor: a picture leaning back
     * toward the camera would put her head deep inside whatever stands behind her. Standing upright she is seen
     * from above and so drawn shorter; stretching her by the same amount gives exactly the picture facing the
     * camera would. The room is turned upright by its parent, so the camera's axes are taken in the parent's frame.
     */
    face(camera) {
      const toRoom = object.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(camera.quaternion);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(toRoom), away = new THREE.Vector3(0, 0, 1).applyQuaternion(toRoom);
      const seen = Math.hypot(away.x, away.y);                  // how much of an upright unit the camera sees
      if (seen < 0.05) return;                                   // straight overhead: nothing upright can face it
      right.z = 0; right.normalize();
      object.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, UP, new THREE.Vector3().crossVectors(right, UP)));
      object.scale.y = 1 / seen;
    },
    tint(color) { look.color.set(color); hooks.change(); },
  };
}
