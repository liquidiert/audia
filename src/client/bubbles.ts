import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { Candidate } from "../shared/types";
import { fallbackThumb } from "./session";

const PALETTE = [0xff4f7b, 0x7b5cff, 0x3ddc97, 0xffb547, 0x4fc3ff, 0xff7a45, 0xc05cff, 0x45e0d0];
const TEX_SIZE = 512;
/** World-space radius of a bubble with one vote. Area grows linearly with votes. */
const UNIT_RADIUS = 1;
const MIN_RADIUS = 0.55;

interface Bubble {
  id: string;
  group: THREE.Group;
  shell: THREE.Mesh<THREE.SphereGeometry, THREE.MeshPhysicalMaterial>;
  face: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  art: HTMLImageElement | null;
  pos: THREE.Vector2;
  vel: THREE.Vector2;
  radius: number;
  target: number;
  phase: number;
  votes: number;
  leading: boolean;
  /** Position in the tally (0 = most votes); decides stacking. */
  rank: number;
  /** Set when the song left the pool; animates out then gets disposed. */
  leaving?: { won: boolean; since: number };
  cand: Candidate;
}

/**
 * Candidate songs as glossy bubbles. Bubble area is proportional to votes;
 * a small force simulation packs them around the centre.
 */
export class BubbleField {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.1, 500);
  private bubbles = new Map<string, Bubble>();
  private timer = new THREE.Timer();
  private camZ = 20;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(this.renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-6, 8, 10);
    this.scene.add(key);

    this.camera.position.set(0, 0, this.camZ);
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop((time) => this.frame(time));
  }

  /** Sync bubbles with the live tally. `winners` are songs that just entered the playlist. */
  update(candidates: Candidate[], winners: Set<string>) {
    const seen = new Set<string>();
    const leader = candidates[0]?.votes ? candidates[0].song.id : null;
    candidates.forEach((c, i) => {
      seen.add(c.song.id);
      let b = this.bubbles.get(c.song.id);
      if (!b || b.leaving) {
        if (b) this.dispose(b);
        b = this.create(c, i);
      }
      b.cand = c;
      b.target = radiusFor(c.votes);
      this.stack(b, i);
      if (b.votes !== c.votes || b.leading !== (leader === c.song.id)) {
        b.votes = c.votes;
        b.leading = leader === c.song.id;
        this.paint(b);
      }
    });
    for (const b of this.bubbles.values()) {
      if (!seen.has(b.id) && !b.leaving) {
        b.leaving = { won: winners.has(b.id), since: performance.now() };
        // A winner flies into the pill over everything else.
        if (b.leaving.won) this.stack(b, -1);
      }
    }
  }

  private create(c: Candidate, index: number): Bubble {
    const color = PALETTE[hash(c.song.id) % PALETTE.length]!;
    const group = new THREE.Group();

    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(1, 64, 48),
      new THREE.MeshPhysicalMaterial({
        color,
        roughness: 0.08,
        metalness: 0,
        clearcoat: 1,
        clearcoatRoughness: 0.05,
        iridescence: 0.6,
        iridescenceIOR: 1.4,
        transparent: true,
        opacity: 0.24,
        depthWrite: false,
        depthTest: false,
      }),
    );

    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = TEX_SIZE;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const face = new THREE.Mesh(
      new THREE.CircleGeometry(0.86, 64),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false, depthTest: false }),
    );
    face.position.z = 0.02;

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(1.04, 1.12, 96),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, toneMapped: false, depthTest: false }),
    );

    group.add(face, shell, ring);
    this.scene.add(group);

    const angle = index * 2.39996 + Math.random();
    const dist = 6 + index * 0.8;
    const b: Bubble = {
      id: c.song.id,
      group,
      shell,
      face,
      ring,
      canvas,
      texture,
      art: null,
      pos: new THREE.Vector2(Math.cos(angle) * dist, Math.sin(angle) * dist),
      vel: new THREE.Vector2(),
      radius: 0.01,
      target: radiusFor(c.votes),
      phase: Math.random() * Math.PI * 2,
      votes: c.votes,
      leading: false,
      rank: index,
      cand: c,
    };
    this.stack(b, index);
    this.bubbles.set(b.id, b);
    this.paint(b);

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      b.art = img;
      this.paint(b);
    };
    img.onerror = () => {
      if (img.src !== fallbackThumb(c.song.id)) img.src = fallbackThumb(c.song.id);
    };
    img.src = c.song.thumb ?? fallbackThumb(c.song.id);
    return b;
  }

  /**
   * Bubbles are drawn in tally order instead of by depth, so overlaps never
   * intersect: the most-voted bubble is painted last and sits on top.
   */
  private stack(b: Bubble, rank: number) {
    b.rank = rank;
    const base = (1000 - rank) * 4;
    b.face.renderOrder = base + 1;
    b.shell.renderOrder = base + 2;
    b.ring.renderOrder = base + 3;
  }

  /** Draw album art, title and vote count onto the bubble's face texture. */
  private paint(b: Bubble) {
    const ctx = b.canvas.getContext("2d")!;
    const s = TEX_SIZE;
    const color = `#${(b.shell.material.color.getHex() >>> 0).toString(16).padStart(6, "0")}`;
    ctx.clearRect(0, 0, s, s);
    ctx.save();
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2);
    ctx.clip();

    if (b.art) {
      // Centre-crop to a square (YouTube fallbacks are 16:9).
      const { naturalWidth: w, naturalHeight: h } = b.art;
      const side = Math.min(w, h);
      ctx.drawImage(b.art, (w - side) / 2, (h - side) / 2, side, side, 0, 0, s, s);
    } else {
      const g = ctx.createLinearGradient(0, 0, s, s);
      g.addColorStop(0, color);
      g.addColorStop(1, "#15151f");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
    }
    const shade = ctx.createLinearGradient(0, s * 0.25, 0, s);
    shade.addColorStop(0, "rgba(8,8,14,0.05)");
    shade.addColorStop(1, "rgba(8,8,14,0.85)");
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, s, s);

    ctx.textAlign = "center";
    ctx.fillStyle = "#fff";
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = 12;
    ctx.font = "800 120px system-ui, sans-serif";
    ctx.fillText(String(b.votes), s / 2, s * 0.5);
    ctx.font = "600 34px system-ui, sans-serif";
    ctx.fillText(b.votes === 1 ? "vote" : "votes", s / 2, s * 0.58);

    ctx.font = "700 40px system-ui, sans-serif";
    wrap(ctx, b.cand.song.title, s / 2, s * 0.71, s * 0.7, 44, 2);
    ctx.font = "500 30px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    wrap(ctx, b.cand.song.artist, s / 2, s * 0.86, s * 0.55, 32, 1);
    ctx.restore();
    b.texture.needsUpdate = true;
  }

  private frame(time: number) {
    this.timer.update(time);
    const dt = Math.min(this.timer.getDelta(), 1 / 20);
    const t = this.timer.getElapsed();
    const list = [...this.bubbles.values()];

    // Force simulation in the xy plane: pull to centre, push apart on overlap.
    for (const b of list) {
      if (b.leaving) continue;
      b.vel.addScaledVector(b.pos, -1.6 * dt);
    }
    for (let i = 0; i < list.length; i++) {
      const a = list[i]!;
      if (a.leaving) continue;
      for (let j = i + 1; j < list.length; j++) {
        const c = list[j]!;
        if (c.leaving) continue;
        const d = new THREE.Vector2().subVectors(a.pos, c.pos);
        const len = d.length() || 0.001;
        const min = a.radius + c.radius + 0.35;
        if (len < min) {
          const push = d.multiplyScalar(((min - len) / len) * 9 * dt);
          const wa = c.radius / (a.radius + c.radius);
          a.vel.addScaledVector(push, wa);
          c.vel.addScaledVector(push, -(1 - wa));
        }
      }
    }

    let extent = 4;
    for (const b of list) {
      if (b.leaving) {
        const k = (performance.now() - b.leaving.since) / 1000;
        if (b.leaving.won) {
          // Fly down towards the now-playing pill.
          b.pos.lerp(new THREE.Vector2(0, -this.camZ * 0.42), Math.min(1, dt * 3));
          b.radius = THREE.MathUtils.lerp(b.radius, 0.2, dt * 2.5);
        } else {
          b.radius = THREE.MathUtils.lerp(b.radius, 0, dt * 6);
        }
        if (k > 1.6 || b.radius < 0.02) {
          this.dispose(b);
          continue;
        }
      } else {
        b.vel.multiplyScalar(Math.pow(0.02, dt));
        b.pos.addScaledVector(b.vel, dt);
        b.radius = THREE.MathUtils.lerp(b.radius, b.target, 1 - Math.pow(0.004, dt));
        extent = Math.max(extent, b.pos.length() + b.radius);
      }

      const bob = Math.sin(t * 0.9 + b.phase) * 0.12;
      b.group.position.set(b.pos.x, b.pos.y + bob, 0);
      b.group.scale.setScalar(Math.max(b.radius, 0.001));
      b.shell.rotation.y = t * 0.2 + b.phase;
      const ringMat = b.ring.material;
      ringMat.opacity = THREE.MathUtils.lerp(ringMat.opacity, b.leading ? 0.55 + Math.sin(t * 3) * 0.25 : 0, dt * 5);
    }

    // Keep the whole cluster in frame (leave room for the pill and side panel).
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const fitH = extent / Math.tan(fov / 2) / 0.8;
    const fitW = fitH / Math.min(1, this.camera.aspect);
    this.camZ = THREE.MathUtils.lerp(this.camZ, Math.max(14, fitW), dt * 1.5);
    this.camera.position.z = this.camZ;

    this.renderer.render(this.scene, this.camera);
  }

  private dispose(b: Bubble) {
    this.scene.remove(b.group);
    b.shell.geometry.dispose();
    b.shell.material.dispose();
    b.face.geometry.dispose();
    b.face.material.dispose();
    b.ring.geometry.dispose();
    b.ring.material.dispose();
    b.texture.dispose();
    if (this.bubbles.get(b.id) === b) this.bubbles.delete(b.id);
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }
}

function radiusFor(votes: number) {
  return Math.max(MIN_RADIUS, UNIT_RADIUS * Math.sqrt(votes));
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Centered, ellipsized multi-line text. */
function wrap(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lh: number, maxLines: number) {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > maxW && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  const shown = lines.slice(0, maxLines);
  if (lines.length > maxLines) {
    let last = shown[maxLines - 1]!;
    while (ctx.measureText(`${last}…`).width > maxW && last.length > 1) last = last.slice(0, -1);
    shown[maxLines - 1] = `${last}…`;
  }
  shown.forEach((l, i) => {
    let s = l;
    while (ctx.measureText(s).width > maxW && s.length > 1) s = s.slice(0, -2) + "…";
    ctx.fillText(s, x, y + i * lh);
  });
}
