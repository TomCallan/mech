import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { SceneDoc } from '../scene/types';
import { geometryForPart } from './geometry';

export type ViewPreset = 'front' | 'top' | 'right' | 'iso' | 'active';

export interface StackEntry {
  partId: string;
  distance: number;
  plane: number;
}

/** A click that landed on geometry, plus everything hidden behind it. */
export interface PartHit {
  partId: string;
  /** Surface point in render space (includes the level explode offset). */
  point: [number, number, number];
  stack: StackEntry[];
}

export interface ViewportCallbacks {
  /** A click that hit a part. `hit` is null when empty space was clicked. */
  onPartClick: (hit: PartHit | null, additive: boolean) => void;
  /** A click on empty space, with the point on the active work plane. */
  onEmptyClick: (planePoint: [number, number, number], additive: boolean) => void;
  onGrab: (partId: string, worldPoint: [number, number, number], planeNormal: [number, number, number]) => void;
  onDrag: (worldPoint: [number, number, number]) => void;
  onRelease: () => void;
  onHover: (partId: string | null) => void;
}

/**
 * Z-up 3D viewport. The physics world uses X/Y as the working plane and Z for
 * levels, so render coordinates are physics coordinates with no conversion.
 * Level separation is a pure render offset (`explode`) and never touches state.
 */
export class Viewport {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly persp: THREE.PerspectiveCamera;
  private readonly ortho: THREE.OrthographicCamera;
  private camera: THREE.Camera;
  private controls: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();

  private readonly partGroup = new THREE.Group();
  private readonly jointGroup = new THREE.Group();
  private readonly overlayGroup = new THREE.Group();
  private readonly meshes = new Map<string, THREE.Mesh>();
  private readonly partMeta = new Map<string, { plane: number; kind: string; dofs: string }>();
  private jointMeshes: THREE.Object3D[] = [];

  private grid: THREE.LineSegments | null = null;
  private workPlane: THREE.Mesh | null = null;

  private doc: SceneDoc | null = null;
  private poses: Float32Array | null = null;
  private selection: string[] = [];
  private hovered: string | null = null;
  private activePlane = 0;
  private explode = 0;
  private orthoMode = false;

  private dragging: string | null = null;
  private dragEnabled = true;
  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpMat = new THREE.Matrix4();
  private readonly tmpScale = new THREE.Vector3(1, 1, 1);

  constructor(private readonly container: HTMLElement, private readonly cb: ViewportCallbacks) {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(0x0b0f14, 1);
    container.appendChild(this.renderer.domElement);

    this.persp = new THREE.PerspectiveCamera(45, w / h, 0.01, 50);
    this.persp.position.set(0.32, -0.42, 0.3);
    this.persp.up.set(0, 0, 1);

    const aspect = w / h;
    const frustum = 0.5;
    this.ortho = new THREE.OrthographicCamera(
      (-frustum * aspect) / 2, (frustum * aspect) / 2, frustum / 2, -frustum / 2, -10, 20,
    );
    this.ortho.position.copy(this.persp.position);
    this.ortho.up.set(0, 0, 1);

    this.camera = this.persp;
    this.controls = this.makeControls(this.persp);

    this.scene.add(this.partGroup, this.jointGroup, this.overlayGroup);
    this.setupLights();
    this.buildOverlay();
    this.attachPointerHandlers();
  }

  private makeControls(camera: THREE.Camera): OrbitControls {
    const c = new OrbitControls(camera, this.renderer.domElement);
    c.enableDamping = true;
    c.dampingFactor = 0.12;
    c.rotateSpeed = 0.9;
    c.zoomSpeed = 0.9;
    c.panSpeed = 0.9;
    c.minDistance = 0.05;
    c.maxDistance = 8;
    return c;
  }

  private setupLights(): void {
    this.scene.add(new THREE.HemisphereLight(0xbfd4e8, 0x2a2f36, 0.85));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(0.6, -0.9, 1.1);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x9ec5ff, 0.45);
    fill.position.set(-0.9, 0.6, 0.4);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffd9a0, 0.3);
    rim.position.set(0.2, 1.0, -0.8);
    this.scene.add(rim);
  }

  private buildOverlay(): void {
    const axes = new THREE.Group();
    const mk = (dir: THREE.Vector3, color: number) => {
      const g = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        dir.clone().multiplyScalar(0.12),
      ]);
      axes.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 })));
    };
    mk(new THREE.Vector3(1, 0, 0), 0xff6b6b);
    mk(new THREE.Vector3(0, 1, 0), 0x7bc96f);
    mk(new THREE.Vector3(0, 0, 1), 0x6b9bff);
    this.overlayGroup.add(axes);
  }

  // --- document sync ------------------------------------------------------

  setDoc(doc: SceneDoc): void {
    const prev = this.doc;
    this.doc = doc;

    const alive = new Set<string>();
    for (const part of doc.parts) {
      alive.add(part.id);
      const geo = geometryForPart(part);
      let mesh = this.meshes.get(part.id);
      const meta = this.partMeta.get(part.id);
      const key = `${part.kind}:${geo.uuid}`;
      const changed = !mesh || !meta || (mesh.userData.geoKey as string) !== key;

      if (!mesh) {
        mesh = new THREE.Mesh(
          geo,
          new THREE.MeshStandardMaterial({ color: part.color, metalness: 0.35, roughness: 0.42 }),
        );
        mesh.matrixAutoUpdate = false;
        mesh.userData.partId = part.id;
        this.meshes.set(part.id, mesh);
        this.partGroup.add(mesh);
      } else if (changed) {
        mesh.geometry = geo;
      }
      mesh.userData.geoKey = key;
      (mesh.material as THREE.MeshStandardMaterial).color.set(part.color);
      this.partMeta.set(part.id, { plane: part.plane, kind: part.kind, dofs: part.dofs });
    }

    for (const [id, mesh] of this.meshes) {
      if (!alive.has(id)) {
        this.partGroup.remove(mesh);
        (mesh.material as THREE.Material).dispose();
        this.meshes.delete(id);
        this.partMeta.delete(id);
      }
    }

    const structureChanged = !prev || prev.joints !== doc.joints || prev.planeSpacing !== doc.planeSpacing;
    if (structureChanged) this.rebuildJoints(doc);
    this.rebuildGrid(doc);
    this.applySelectionHighlight();
  }

  private rebuildGrid(doc: SceneDoc): void {
    if (this.grid) {
      this.overlayGroup.remove(this.grid);
      this.grid.geometry.dispose();
      (this.grid.material as THREE.Material).dispose();
    }
    const span = doc.planeSpacing * 12;
    const step = doc.planeSpacing / 2;
    const pts: THREE.Vector3[] = [];
    const n = Math.round(span / step);
    for (let i = -n; i <= n; i++) {
      const t = i * step;
      if (i % 2 !== 0) continue;
      pts.push(new THREE.Vector3(-span, t, 0), new THREE.Vector3(span, t, 0));
      pts.push(new THREE.Vector3(t, -span, 0), new THREE.Vector3(t, span, 0));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const colors = new Float32Array(pts.length * 3);
    for (let i = 0; i < pts.length; i++) {
      // Every other pair of lines is a "major" line.
      const major = Math.floor(i / 4) % 2 === 0;
      const c = major ? 0.2 : 0.13;
      colors[i * 3] = c * 0.85;
      colors[i * 3 + 1] = c;
      colors[i * 3 + 2] = c * 1.25;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.grid = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75 }));
    this.overlayGroup.add(this.grid);

    if (!this.workPlane) {
      const planeGeo = new THREE.PlaneGeometry(1, 1);
      this.workPlane = new THREE.Mesh(
        planeGeo,
        new THREE.MeshBasicMaterial({ color: 0x3d7dd8, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false }),
      );
      this.overlayGroup.add(this.workPlane);
    }
    this.workPlane.scale.set(span * 1.4, span * 1.4, 1);
  }

  private rebuildJoints(doc: SceneDoc): void {
    for (const obj of this.jointMeshes) {
      this.jointGroup.remove(obj);
      obj.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material) (m.material as THREE.Material).dispose();
      });
    }
    this.jointMeshes = [];

    const axisMat = new THREE.MeshStandardMaterial({ color: 0xd6dde5, metalness: 0.7, roughness: 0.3 });
    const jointById = new Map(doc.joints.map((j) => [j.id, j]));

    for (const joint of doc.joints) {
      const group = new THREE.Group();
      group.userData.jointId = joint.id;
      group.userData.plane = joint.anchor[2] / doc.planeSpacing;

      if (joint.kind === 'pin') {
        const len = doc.planeSpacing * 0.9;
        const geo = new THREE.CylinderGeometry(doc.planeSpacing * 0.1, doc.planeSpacing * 0.1, len, 16);
        // Cylinder runs along Y; align it with the joint axis.
        const mesh = new THREE.Mesh(geo, axisMat);
        const axis = new THREE.Vector3(...joint.axis).normalize();
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
        group.add(mesh);
      } else if (joint.kind === 'slider') {
        const geo = new THREE.CylinderGeometry(doc.planeSpacing * 0.05, doc.planeSpacing * 0.05, doc.planeSpacing * 2.2, 12);
        const mesh = new THREE.Mesh(geo, axisMat);
        const axis = new THREE.Vector3(...joint.axis).normalize();
        mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
        mesh.material = new THREE.MeshStandardMaterial({ color: 0x9aa7b4, metalness: 0.6, roughness: 0.5, transparent: true, opacity: 0.5 });
        group.add(mesh);
      } else if (joint.kind === 'gear') {
        const a = joint.couplingA ? jointById.get(joint.couplingA) : null;
        const b = joint.couplingB ? jointById.get(joint.couplingB) : null;
        if (a && b) {
          const geo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(...a.anchor),
            new THREE.Vector3(...b.anchor),
          ]);
          const line = new THREE.Line(geo, new THREE.LineDashedMaterial({ color: 0xf2c14e, dashSize: doc.planeSpacing * 0.25, gapSize: doc.planeSpacing * 0.18 }));
          line.computeLineDistances();
          group.add(line);
        }
      } else {
        const geo = new THREE.SphereGeometry(doc.planeSpacing * (joint.kind === 'ball' ? 0.16 : 0.12), 16, 12);
        group.add(new THREE.Mesh(geo, axisMat));
      }

      group.position.set(joint.anchor[0], joint.anchor[1], joint.anchor[2]);
      this.jointGroup.add(group);
      this.jointMeshes.push(group);
    }
  }

  // --- per-frame ----------------------------------------------------------

  setPoses(poses: Float32Array): void {
    this.poses = poses;
  }

  /** Transforms are applied from the pose buffer each frame. */
  applyPoses(indexOf: (partId: string) => number): void {
    if (!this.doc || !this.poses) return;
    for (const part of this.doc.parts) {
      const mesh = this.meshes.get(part.id);
      if (!mesh) continue;
      const i = indexOf(part.id);
      if (i < 0) continue;
      const o = i * 7;
      const offset = part.plane * this.explode;
      this.tmpVec.set(this.poses[o], this.poses[o + 1], this.poses[o + 2] + offset);
      this.tmpQuat.set(this.poses[o + 3], this.poses[o + 4], this.poses[o + 5], this.poses[o + 6]);
      this.tmpMat.compose(this.tmpVec, this.tmpQuat, this.tmpScale);
      mesh.matrix.copy(this.tmpMat);
      mesh.matrixWorldNeedsUpdate = true;
    }

    for (const group of this.jointMeshes) {
      const plane = group.userData.plane as number;
      const base = this.jointBasePosition(group);
      group.position.set(base.x, base.y, base.z + plane * this.explode);
    }

    const gridZ = this.activePlane * (this.doc.planeSpacing + this.explode);
    if (this.grid) this.grid.position.z = gridZ;
    if (this.workPlane) this.workPlane.position.z = gridZ;
  }

  private jointBasePosition(group: THREE.Object3D): THREE.Vector3 {
    const stored = group.userData.base as THREE.Vector3 | undefined;
    if (stored) return stored;
    const v = group.position.clone();
    group.userData.base = v;
    return v;
  }

  render(): void {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  resize(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h);
    const aspect = w / h;
    this.persp.aspect = aspect;
    this.persp.updateProjectionMatrix();
    const frustum = this.ortho.top - this.ortho.bottom;
    this.ortho.left = (-frustum * aspect) / 2;
    this.ortho.right = (frustum * aspect) / 2;
    this.ortho.updateProjectionMatrix();
  }

  // --- state from the UI --------------------------------------------------

  setSelection(ids: string[]): void {
    // Called every frame from the render loop, so bail out when nothing changed
    // rather than touching every material.
    if (
      ids.length === this.selection.length &&
      ids.every((id, i) => this.selection[i] === id)
    ) {
      return;
    }
    this.selection = ids;
    this.applySelectionHighlight();
  }

  private applySelectionHighlight(): void {
    const sel = new Set(this.selection);
    for (const [id, mesh] of this.meshes) {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const isSel = sel.has(id);
      const isHover = this.hovered === id;
      mat.emissive.setHex(isSel ? 0x2b5fa8 : isHover ? 0x1d3a5c : 0x000000);
      mat.emissiveIntensity = 1;
    }
  }

  setHovered(partId: string | null): void {
    if (this.hovered === partId) return;
    this.hovered = partId;
    this.applySelectionHighlight();
  }

  setActivePlane(plane: number): void {
    this.activePlane = plane;
  }

  setExplode(metres: number): void {
    this.explode = metres;
  }  setOrtho(on: boolean): void {
    if (on === this.orthoMode) return;
    this.orthoMode = on;
    const target = this.controls.target.clone();
    const pos = this.camera.position.clone();
    this.controls.dispose();
    if (on) {
      // Match the perspective framing so the switch is not jarring.
      const dist = pos.distanceTo(target);
      const halfH = Math.tan((this.persp.fov * Math.PI) / 360) * dist;
      const aspect = this.renderer.domElement.clientWidth / this.renderer.domElement.clientHeight;
      this.ortho.top = halfH;
      this.ortho.bottom = -halfH;
      this.ortho.left = -halfH * aspect;
      this.ortho.right = halfH * aspect;
      this.ortho.position.copy(pos);
      this.ortho.quaternion.copy(this.camera.quaternion);
      this.ortho.updateProjectionMatrix();
      this.camera = this.ortho;
    } else {
      this.persp.position.copy(pos);
      this.persp.quaternion.copy(this.camera.quaternion);
      this.camera = this.persp;
    }
    this.controls = this.makeControls(this.camera);
    this.controls.target.copy(target);
  }

  /**
   * Z-up presets. Axis-aligned views need an up vector perpendicular to the
   * view direction, otherwise the camera basis is degenerate.
   */
  setView(preset: ViewPreset): void {
    const z = this.doc ? this.activePlane * (this.doc.planeSpacing + this.explode) : 0;
    const target = new THREE.Vector3(0, 0, z);
    const d = 0.55;

    const presets: Record<ViewPreset, { dir: THREE.Vector3; up: THREE.Vector3 }> = {
      // Face-on to the working plane: the planar editing view.
      front: { dir: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0) },
      top: { dir: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, 1) },
      right: { dir: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 0, 1) },
      iso: { dir: new THREE.Vector3(0.7, -0.75, 0.6).normalize(), up: new THREE.Vector3(0, 0, 1) },
      active: { dir: new THREE.Vector3(0.16, -0.2, 0.97).normalize(), up: new THREE.Vector3(0, 0, 1) },
    };

    const { dir, up } = presets[preset];
    this.camera.up.copy(up);
    this.camera.position.copy(target).addScaledVector(dir, d);
    this.controls.target.copy(target);
    this.controls.update();
  }

  /** Distance from the camera to its target. Used by the UI for a readout. */
  cameraDistance(): number {
    return this.camera.position.distanceTo(this.controls.target);
  }

  // --- picking ------------------------------------------------------------

  private updatePointer(ev: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  }

  /** All parts under the cursor, nearest first. Used for depth disambiguation. */
  pickStack(ev: PointerEvent): StackEntry[] {
    if (!this.doc || !this.poses) return [];
    this.updatePointer(ev);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects([...this.meshes.values()], false);
    const out: StackEntry[] = [];
    const seen = new Set<string>();
    for (const hit of hits) {
      const partId = hit.object.userData.partId as string;
      if (seen.has(partId)) continue;
      seen.add(partId);
      out.push({
        partId,
        distance: hit.distance,
        plane: this.partMeta.get(partId)?.plane ?? 0,
      });
    }
    return out;
  }

  /**
   * Preference order: a part on the active level wins outright, so editing a back
   * level is never blocked by geometry in front of it. Otherwise take the nearest.
   * The winning part's surface point rides along, because tools need somewhere to
   * hang a pin.
   */
  pickDetail(ev: PointerEvent): PartHit | null {
    if (!this.doc || !this.poses) return null;
    this.updatePointer(ev);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects([...this.meshes.values()], false);
    if (hits.length === 0) return null;

    const stack: StackEntry[] = [];
    const seen = new Set<string>();
    const pointFor = new Map<string, THREE.Vector3>();
    for (const hit of hits) {
      const partId = hit.object.userData.partId as string;
      if (seen.has(partId)) continue;
      seen.add(partId);
      pointFor.set(partId, hit.point.clone());
      stack.push({ partId, distance: hit.distance, plane: this.partMeta.get(partId)?.plane ?? 0 });
    }

    const chosen = stack.find((s) => s.plane === this.activePlane) ?? stack[0];
    const p = pointFor.get(chosen.partId);
    if (!p) return null;
    return { partId: chosen.partId, point: [p.x, p.y, p.z], stack };
  }

  private screenPointOnPlane(ev: PointerEvent, plane: THREE.Plane): [number, number, number] | null {
    this.updatePointer(ev);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, hit)) return null;
    return [hit.x, hit.y, hit.z];
  }

  /** Point on the active work plane under the cursor, in render space. */
  private pointOnActivePlane(ev: PointerEvent): [number, number, number] | null {
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -this.activePlaneRenderZ());
    return this.screenPointOnPlane(ev, plane);
  }

  setDragEnabled(enabled: boolean): void {
    this.dragEnabled = enabled;
  }

  /**
   * Pointer routing. A left press either starts a body drag (select tool) or is
   * reported as a click for the active tool. The two never both fire: this
   * capture-phase listener disables the controls before OrbitControls sees the
   * event, so orbiting and tool clicks cannot overlap.
   */
  private attachPointerHandlers(): void {
    const el = this.renderer.domElement;

    el.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      const hit = this.pickDetail(ev);

      if (this.dragEnabled) {
        if (!hit) {
          this.cb.onPartClick(null, ev.shiftKey);
          return;
        }
        const meta = this.partMeta.get(hit.partId);
        // Planar parts are dragged within their own level, which keeps a planar
        // mechanism planar instead of yanking it out of its plane.
        const normal: [number, number, number] =
          meta?.dofs === 'plane2d' ? [0, 0, 1] : this.cameraNormal();
        const plane = this.dragPlaneFor(hit.partId, normal);
        const point = this.screenPointOnPlane(ev, plane);
        if (!point) return;

        this.dragging = hit.partId;
        this.controls.enabled = false;
        this.cb.onPartClick(hit, ev.shiftKey);
        this.cb.onGrab(hit.partId, point, normal);
        el.setPointerCapture(ev.pointerId);
        ev.stopPropagation();
        return;
      }

      // Tool mode: report the click and keep the camera still.
      this.controls.enabled = false;
      if (hit) {
        this.cb.onPartClick(hit, ev.shiftKey);
      } else {
        const p = this.pointOnActivePlane(ev);
        if (p) this.cb.onEmptyClick(p, ev.shiftKey);
      }
      ev.stopPropagation();
    }, { capture: true });

    el.addEventListener('pointermove', (ev) => {
      if (this.dragging) {
        const meta = this.partMeta.get(this.dragging);
        const normal: [number, number, number] =
          meta?.dofs === 'plane2d' ? [0, 0, 1] : this.cameraNormal();
        const plane = this.dragPlaneFor(this.dragging, normal);
        const point = this.screenPointOnPlane(ev, plane);
        if (point) this.cb.onDrag(point);
        return;
      }
      const hit = this.pickDetail(ev);
      const partId = hit ? hit.partId : null;
      this.setHovered(partId);
      this.cb.onHover(partId);
    });

    const end = (ev: PointerEvent) => {
      this.controls.enabled = true;
      if (!this.dragging) return;
      this.dragging = null;
      this.cb.onRelease();
      try {
        el.releasePointerCapture(ev.pointerId);
      } catch {
        // capture may already be gone
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  private cameraNormal(): [number, number, number] {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    return [-dir.x, -dir.y, -dir.z];
  }

  /** Drag planes follow the body, so the grab point stays under the cursor. */
  private dragPlaneFor(partId: string, normal: [number, number, number]): THREE.Plane {
    const idx = this.doc ? this.doc.parts.findIndex((p) => p.id === partId) : -1;
    const z = idx >= 0 && this.poses ? this.poses[idx * 7 + 2] : 0;
    const plane = new THREE.Plane(new THREE.Vector3(normal[0], normal[1], normal[2]).normalize(), 0);
    plane.constant = -plane.normal.dot(new THREE.Vector3(0, 0, z));
    return plane;
  }

  /** Render-space z of the active level, needed to map clicks back to physics. */
  activePlaneRenderZ(): number {
    if (!this.doc) return 0;
    return this.activePlane * (this.doc.planeSpacing + this.explode);
  }

  dispose(): void {
    this.controls.dispose();
    for (const [, mesh] of this.meshes) {
      (mesh.material as THREE.Material).dispose();
    }
    this.meshes.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
