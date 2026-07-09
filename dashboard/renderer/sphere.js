// Black-hole visualization (three.js): a dense spherical burst of fine white
// radial streaks with a spiral twist on pure black. Constant slow rotation;
// voice only brightens the lines and core — no movement reaction at all.
import * as THREE from 'three';

const R = 2.15;
const N = 3400;
const TWIST = 0.55;

export function createSphere(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 5.2);

  const group = new THREE.Group();
  scene.add(group);

  // Bake the streak geometry once — it never changes.
  const positions = new Float32Array(N * 6);
  const colors = new Float32Array(N * 6);
  const tmp = new THREE.Vector3();

  function rotZ(v, ang) {
    const c = Math.cos(ang), s = Math.sin(ang);
    return [v.x * c - v.y * s, v.x * s + v.y * c, v.z];
  }

  for (let i = 0; i < N; i++) {
    const u = Math.random() * 2 - 1;
    const theta = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    tmp.set(s * Math.cos(theta), s * Math.sin(theta), u);

    const ri = (0.05 + Math.random() * 0.4) * R;
    const ro = Math.min(R, ri + (0.4 + Math.random() * 0.9) * R);
    const inner = rotZ(tmp.clone().multiplyScalar(ri), TWIST * (ri / R));
    const outer = rotZ(tmp.clone().multiplyScalar(ro), TWIST * (ro / R));

    positions.set([...inner, ...outer], i * 6);

    const b = 0.5 + Math.random() * 0.5;
    colors.set([b, b, b, b * 0.35, b * 0.35, b * 0.37], i * 6);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  group.add(new THREE.LineSegments(geo, mat));


  let level = 0, levelTarget = 0;
  let t = 0;

  function resize() {
    const { clientWidth: w, clientHeight: h } = canvas.parentElement;
    renderer.setSize(w, h, false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  function animate() {
    requestAnimationFrame(animate);
    t += 0.016;

    // Voice level: rise quickly, fall slowly.
    levelTarget *= 0.92;
    level += (levelTarget - level) * (levelTarget > level ? 0.2 : 0.05);

    // Constant slow rotation — never changes speed.
    group.rotation.z += 0.00015;
    group.rotation.y = Math.sin(t * 0.03) * 0.08;

    // Voice only affects brightness: lines glow whiter when speaking.
    mat.opacity += ((0.5 + level * 0.35) - mat.opacity) * 0.07;

    renderer.render(scene, camera);
  }
  animate();

  return {
    setState: () => {}, // no state-dependent behavior — just brightness
    setLevel: (v) => { levelTarget = Math.max(levelTarget, Math.min(1, v)); },
  };
}