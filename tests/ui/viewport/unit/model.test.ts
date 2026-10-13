// The arithmetic of the viewport panel (src/app/panels/viewport/model.ts): what each press begins, what orbit,
// pan, dolly, look and fly do to the camera of runtime.md 7.5, how the cameras frame a terrain, how the top view
// zooms about the pointer, and what the panel says of the picture.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { nodes } from '../../../../src/core/nodes/index.ts';
import { addNode, createRegistry, newDoc, setNodeFlags, type DocDraft } from '../../../../src/core/runtime.ts';
import {
  axes, cameraOf, centerOrbit, centerTop, DEFAULT_DISPLAY, dolly, dollyDrag, dragKind, dragSun, eyeOf, fly, flyKeys, flySpeed, frameOrbit, frameTop, initialModel,
  isBlank, look, metres, orbit, outputTitle, pan, panTop, PITCH_MAX, PITCH_MIN, STATUS_TEXT, STATUS_WORD, topUv, viewStatus, wheelFactor, zoomTop,
  type OrbitCamera, type ViewFacts, type ViewStatus,
} from '../../../../src/app/panels/viewport/model.ts';
import { orbitEye, project, viewOf } from '../../../../src/viewport/camera.ts';

const CAMERA: OrbitCamera = { kind: 'orbit', target: [2000, 2000, 250], yaw: 300, pitch: 30, distance: 6000, fovY: 35 };
const SIZE = { width: 1200, height: 800 };
const NONE = { alt: false, shift: false, ctrl: false };
const close = (a: readonly number[], b: readonly number[], tolerance = 1e-6): boolean => a.every((v, i) => Math.abs(v - b[i]!) <= tolerance * Math.max(1, Math.abs(v)));

test('what a press begins: both conventions orbit, pan and dolly; the right button flies; Shift with the left turns the sun', () => {
  const kinds = (mode: 'orbit' | 'top') => Object.fromEntries([
    ['left', dragKind(mode, 0, NONE)], ['alt+left', dragKind(mode, 0, { ...NONE, alt: true })], ['shift+left', dragKind(mode, 0, { ...NONE, shift: true })],
    ['middle', dragKind(mode, 1, NONE)], ['alt+middle', dragKind(mode, 1, { ...NONE, alt: true })], ['shift+middle', dragKind(mode, 1, { ...NONE, shift: true })],
    ['right', dragKind(mode, 2, NONE)], ['alt+right', dragKind(mode, 2, { ...NONE, alt: true })],
  ]);
  assert.deepEqual(kinds('orbit'), {
    'left': 'orbit', 'alt+left': 'orbit', 'shift+left': 'sun', 'middle': 'orbit', 'alt+middle': 'pan', 'shift+middle': 'pan', 'right': 'fly', 'alt+right': 'dolly',
  });
  assert.deepEqual(kinds('top'), {
    'left': 'pan', 'alt+left': 'pan', 'shift+left': 'sun', 'middle': 'pan', 'alt+middle': 'pan', 'shift+middle': 'pan', 'right': 'pan', 'alt+right': 'dolly',
  });
  assert.equal(dragKind('orbit', 3, NONE), null);
});

test('the panel and the renderer place the camera alike', () => {
  for (const camera of [CAMERA, { ...CAMERA, yaw: 17, pitch: -40 }, { ...CAMERA, yaw: 0, pitch: 0 }]) {
    assert.ok(close(eyeOf(camera), orbitEye(camera)));
    const view = viewOf(camera, SIZE);
    assert.ok(view.kind === 'orbit' && close(axes(camera.yaw, camera.pitch).right, view.right) && close(axes(camera.yaw, camera.pitch).up, view.up));
  }
});

test('orbit: dragging right brings the near side to the right, dragging down shows more of the top; the pitch stays in its range', () => {
  const nearSide = [CAMERA.target[0] - 100 * axes(CAMERA.yaw, 0).forward[0], CAMERA.target[1] - 100 * axes(CAMERA.yaw, 0).forward[1], CAMERA.target[2]] as const;
  const before = project(viewOf(CAMERA, SIZE), SIZE, nearSide, 4000)!;
  const right = orbit(CAMERA, 40, 0), down = orbit(CAMERA, 0, 40);
  assert.ok(project(viewOf(right, SIZE), SIZE, nearSide, 4000)!.x > before.x + 1);
  assert.ok(project(viewOf(down, SIZE), SIZE, nearSide, 4000)!.y > before.y + 1 && down.pitch > CAMERA.pitch);
  assert.deepEqual([right.target, right.distance], [CAMERA.target, CAMERA.distance], 'the target and the distance stay');
  assert.equal(orbit(CAMERA, 0, 1e5).pitch, PITCH_MAX);
  assert.equal(orbit(CAMERA, 0, -1e5).pitch, PITCH_MIN);
  assert.ok(orbit(CAMERA, 1e4, 0).yaw >= 0 && orbit(CAMERA, 1e4, 0).yaw < 360);
});

test('pan: what was under the pointer at the target\'s distance stays under it', () => {
  const moved = pan(CAMERA, 120, -45, SIZE.height);
  const at = project(viewOf(moved, SIZE), SIZE, CAMERA.target, 4000)!;
  assert.ok(Math.abs(at.x - (SIZE.width / 2 + 120)) < 0.01 && Math.abs(at.y - (SIZE.height / 2 - 45)) < 0.01, `${at.x} ${at.y}`);
  assert.deepEqual([moved.yaw, moved.pitch, moved.distance], [CAMERA.yaw, CAMERA.pitch, CAMERA.distance]);
});

test('dolly: the distance scales, within its limits, and a point it is aimed at keeps its place in the picture', () => {
  assert.equal(dolly(CAMERA, 0.5).distance, 3000);
  assert.deepEqual(dolly(CAMERA, 0.5).target, CAMERA.target);
  assert.equal(dolly(CAMERA, 1e-9, null, { min: 2, max: 100 }).distance, 2);
  assert.equal(dolly(CAMERA, 1e9, null, { min: 2, max: 100 }).distance, 100);
  const point = [2600, 1500, 400] as const;
  const before = project(viewOf(CAMERA, SIZE), SIZE, point, 4000)!;
  const nearer = dolly(CAMERA, 0.4, point);
  const after = project(viewOf(nearer, SIZE), SIZE, point, 4000)!;
  assert.ok(Math.abs(after.x - before.x) < 0.01 && Math.abs(after.y - before.y) < 0.01, 'the point under the pointer stays there');
  assert.ok(wheelFactor(100) > 1 && wheelFactor(-100) < 1 && Math.abs(wheelFactor(100) * wheelFactor(-100) - 1) < 1e-12, 'scrolling back and forth returns');
  assert.ok(dollyDrag(CAMERA, 50, 0).distance < CAMERA.distance && dollyDrag(CAMERA, 0, 50).distance > CAMERA.distance);
});

test('fly: looking turns about the eye, the keys move eye and target together, and the speed crosses the terrain in seconds', () => {
  const turned = look(CAMERA, 200, -60);
  assert.ok(close(eyeOf(turned), eyeOf(CAMERA), 1e-9), 'the eye stays where it is');
  assert.ok(turned.yaw !== CAMERA.yaw && turned.pitch < CAMERA.pitch);
  assert.ok(look(CAMERA, 0, -1e5).pitch < 0, 'a camera that flies looks up as well');

  assert.deepEqual(flyKeys(new Set(['KeyW', 'KeyD', 'KeyE'])), { forward: 1, right: 1, up: 1 });
  assert.deepEqual(flyKeys(new Set(['KeyW', 'KeyS', 'KeyA', 'KeyQ'])), { forward: 0, right: -1, up: -1 });
  assert.equal(fly(CAMERA, flyKeys(new Set()), 100, 1), CAMERA, 'no key, no move: the same camera');
  const ahead = fly(CAMERA, { forward: 1, right: 0, up: 0 }, 100, 0.5);
  const { forward, right } = axes(CAMERA.yaw, CAMERA.pitch);
  assert.ok(close(eyeOf(ahead), eyeOf(CAMERA).map((v, i) => v + 50 * forward[i]!)));
  const sideways = fly(CAMERA, { forward: 0, right: 1, up: 1 }, 100, 1);
  assert.ok(close(sideways.target, [CAMERA.target[0] + 100 * right[0], CAMERA.target[1] + 100 * right[1], CAMERA.target[2] + 100]));
  const terrain = { terrainSize: 4000, heightRange: 1000 };
  assert.equal(flySpeed(terrain, { shift: false, ctrl: false }), 1000);
  assert.equal(flySpeed(terrain, { shift: true, ctrl: false }), 3000);
  assert.ok(Math.abs(flySpeed(terrain, { shift: false, ctrl: true }, 2) - 2000 / 3) < 1e-9);
});

test('framing: the whole terrain is in the picture and fills most of it, whatever the picture\'s shape and the direction', () => {
  for (const [terrainSize, heightRange] of [[4032, 1008], [1008, 252], [100_000, 3000], [512, 2000]] as const) {
    for (const size of [{ width: 1600, height: 900 }, { width: 500, height: 900 }, { width: 1228, height: 420 }]) {
      for (const from of [{ yaw: 300, pitch: 30 }, { yaw: 45, pitch: 75 }, { yaw: 180, pitch: 5 }]) {
        const camera = frameOrbit({ terrainSize, heightRange }, 1, size.width / size.height, from);
        assert.deepEqual([camera.yaw, camera.pitch], [from.yaw, from.pitch], 'the direction is kept');
        const view = viewOf(camera, size);
        let reach = 0;
        for (const x of [0, terrainSize]) {
          for (const y of [0, terrainSize]) {
            for (const z of [0, heightRange * 0.6]) {
              const at = project(view, size, [x, y, z], terrainSize);
              assert.ok(at !== null && at.x >= 0 && at.x <= size.width && at.y >= 0 && at.y <= size.height, `${terrainSize} m in ${size.width} × ${size.height}: a corner at ${at?.x} ${at?.y}`);
              reach = Math.max(reach, Math.abs(at.x / size.width - 0.5) * 2, Math.abs(at.y / size.height - 0.5) * 2);
            }
          }
        }
        assert.ok(reach > 0.8, `the terrain fills the picture: ${reach}`);
      }
    }
  }
  assert.deepEqual(frameTop(2), { kind: 'top', center: [0.5, 0.5], span: 2.16 });
  assert.equal(frameTop(0.5).span, 1.08, 'a tall picture shows the terrain across its width');
});

test('the top view: a drag moves the terrain with the pointer, and zooming keeps what is under the pointer', () => {
  const top = frameTop(1.5);
  const moved = panTop(top, 150, -60, 1200);
  const before = topUv(top, 400, 300, 1200, 800), after = topUv(moved, 550, 240, 1200, 800);
  assert.ok(close(before, after, 1e-12));
  const zoomed = zoomTop(top, 0.25, 900, 200, 1200, 800);
  assert.ok(Math.abs(zoomed.span - top.span * 0.25) < 1e-12);
  assert.ok(close(topUv(zoomed, 900, 200, 1200, 800), topUv(top, 900, 200, 1200, 800), 1e-12));
  assert.ok(zoomTop(top, 1e-9, 0, 0, 1200, 800).span >= 0.002 && zoomTop(top, 1e9, 0, 0, 1200, 800).span <= 16);
  // Texel (0, 0) is at the top left: the middle of a canvas that shows the whole terrain is its middle.
  assert.ok(close(topUv({ kind: 'top', center: [0.5, 0.5], span: 1 }, 0, 0, 1000, 1000), [0, 0], 1e-12));
});

test('the sun: a drag across turns it, a drag upwards raises it, between the horizon and the zenith', () => {
  const dragged = dragSun(DEFAULT_DISPLAY, 50, -40);
  assert.deepEqual([dragged.sunAzimuth, dragged.sunElevation], [DEFAULT_DISPLAY.sunAzimuth + 20, DEFAULT_DISPLAY.sunElevation + 10]);
  assert.equal(dragSun(DEFAULT_DISPLAY, 0, 1e4).sunElevation, 0);
  assert.equal(dragSun(DEFAULT_DISPLAY, 0, -1e4).sunElevation, 90);
  assert.equal(dragSun(DEFAULT_DISPLAY, 600, 0).sunAzimuth, (DEFAULT_DISPLAY.sunAzimuth + 240) % 360);
  assert.equal(dragged.shading, DEFAULT_DISPLAY.shading);
});

test('the sun of a new project lights what the first camera sees: it stands behind the camera, to one side, and not below the top view', () => {
  const { sunAzimuth, sunElevation } = DEFAULT_DISPLAY;
  const camera = initialModel().orbit;
  const { forward, right } = axes(camera.yaw, 0);
  const sun = [Math.cos(sunAzimuth * Math.PI / 180), Math.sin(sunAzimuth * Math.PI / 180)] as const;
  const along = sun[0] * forward[0] + sun[1] * forward[1], across = sun[0] * right[0] + sun[1] * right[1];
  assert.ok(along < -0.1 && along > -0.8, `the light comes from behind the camera, and not straight from behind: ${along}`);
  assert.ok(Math.abs(across) > 0.5, `and from one side, so that slopes have a lit and a shaded face: ${across}`);
  // In the top view +Y is down the screen: a light from below turns hills into hollows for most eyes.
  assert.ok(sun[1] <= 0.2, `the top view is lit from its left or its top: ${sun.join(' ')}`);
  assert.ok(sunElevation >= 25 && sunElevation <= 50);
});

test('the model starts in the 3D view, and sends the camera of the view it is in', () => {
  const model = initialModel();
  assert.deepEqual([model.mode, model.display, model.framed], ['orbit', DEFAULT_DISPLAY, null]);
  assert.equal(cameraOf(model), model.orbit);
  assert.equal(cameraOf({ ...model, mode: 'top' }), model.top);
});

test('what the panel says of the picture, from the device down to the result', () => {
  const facts: ViewFacts = { device: 'ready', bound: true, node: 'done', overlay: null, shown: { revision: 5, resolution: 1009, draft: false }, sent: 5, evaluating: false };
  const said = (change: Partial<ViewFacts>): ViewStatus => viewStatus({ ...facts, ...change });
  assert.deepEqual([
    said({}), said({ device: 'starting' }), said({ device: 'lost', shown: null }), said({ device: 'failed' }), said({ bound: false, shown: null }),
    said({ evaluating: true }), said({ node: 'error' }), said({ node: 'skipped', shown: null }), said({ node: 'error', evaluating: true }),
    said({ shown: null, node: 'running', evaluating: true }), said({ shown: null, node: null }),
  ], ['shown', 'starting', 'lost', 'failed', 'empty', 'updating', 'error', 'error', 'updating', 'updating', 'empty']);

  // A picture of an earlier document while nothing computes the next: previews are paused, or a build runs.
  assert.equal(said({ sent: 6 }), 'stale');
  assert.equal(said({ sent: 6, evaluating: true }), 'updating');

  // A draft is a draft for as long as it is what is shown: the word does not change with every evaluation of a drag.
  const draft = { revision: 5, resolution: 253, draft: true };
  assert.deepEqual([said({ shown: draft }), said({ shown: draft, evaluating: true }), said({ shown: { ...draft, revision: 4 }, sent: 6, evaluating: true }), said({ shown: draft, sent: 9 })],
    ['draft', 'draft', 'draft', 'draft']);

  // The overlay's node fails while the terrain's is well: nothing new is shown (7.3 rule 6), and that is said, not "Updating".
  assert.equal(said({ overlay: 'error', sent: 6 }), 'overlayError');
  assert.equal(said({ overlay: 'skipped' }), 'overlayError');
  assert.equal(said({ overlay: 'error', evaluating: true }), 'updating');
  assert.equal(said({ node: 'error', overlay: 'error' }), 'error', 'the terrain\'s failure is the first to say');
  assert.equal(said({ overlay: 'done' }), 'shown');

  // A node that lacks a wire is unfinished, not failed: the word is the graph's and the inspector's, not "Node failed".
  assert.equal(said({ node: 'unwired' }), 'unwired');
  assert.equal(said({ node: 'unwired', shown: null }), 'unwired');
  assert.equal(said({ node: 'unwired', evaluating: true }), 'updating');
  assert.equal(said({ overlay: 'unwired' }), 'unwired', 'a mask that is not wired yet, over a terrain that is well');
  assert.equal(said({ node: 'error', overlay: 'unwired' }), 'error', 'a terrain that failed is said first');
  assert.deepEqual([STATUS_WORD.unwired, STATUS_TEXT.unwired], ['Missing input', 'The selected node lacks an input']);

  // testing.md 6.2: one sentence, capitalised, no full stop. The toolbar's word is short enough for a narrow panel.
  for (const text of [...Object.values(STATUS_TEXT), ...Object.values(STATUS_WORD)]) assert.ok(text === '' || (/^[A-Z]/.test(text) && !text.endsWith('.')), text);
  for (const [status, word] of Object.entries(STATUS_WORD)) {
    assert.ok(word.length <= 14, word);
    assert.equal(word === '', status === 'shown' || status === 'empty', `${status} has a word unless there is nothing to say`);
    assert.equal(STATUS_TEXT[status as ViewStatus] === '', status === 'shown');
  }
});

test('the canvas is covered when there is no picture to trust, and only then', () => {
  const covered = (shown: boolean): ViewStatus[] => (Object.keys(STATUS_WORD) as ViewStatus[]).filter((status) => isBlank(status, shown));
  assert.deepEqual(covered(true), ['starting', 'failed', 'empty']);
  assert.deepEqual(covered(false), ['starting', 'lost', 'failed', 'empty', 'error', 'unwired']);
});

test('what is shown is called by its node\'s title, the user\'s before the type\'s, with the output\'s name when it is not the first', () => {
  const registry = createRegistry(nodes);
  const draft = structuredClone(newDoc()) as DocDraft;
  const island = addNode(draft, registry, 'generate/island', { x: 0, y: 0 });
  const range = addNode(draft, registry, 'generate/mountain-range', { x: 0, y: 200 });
  assert.equal(outputTitle(draft, registry, { node: range, port: 'out' }), 'Mountain Range');
  assert.equal(outputTitle(draft, registry, { node: island, port: 'out' }), 'Island');
  assert.equal(outputTitle(draft, registry, { node: island, port: 'water' }), 'Island · Water');
  setNodeFlags(draft, range, { title: '  Ridge of the north  ' });
  assert.equal(outputTitle(draft, registry, { node: range, port: 'out' }), 'Ridge of the north');
  assert.equal(outputTitle(draft, registry, { node: 'gone', port: 'out' }), null);
  assert.equal(outputTitle(draft, registry, undefined), null);
  // A node of a type this build does not have is called by its type, and a port it does not have by the node alone.
  draft.nodes[range] = { ...draft.nodes[range]!, title: undefined, type: 'generate/of-another-build' } as never;
  assert.equal(outputTitle(draft, registry, { node: range, port: 'out' }), 'generate/of-another-build');
  assert.equal(outputTitle(draft, registry, { node: island, port: 'nowhere' }), 'Island');
});

test('a double click brings a point to the middle of either view', () => {
  const centered = centerOrbit(CAMERA, [1200, 2600, 340]);
  assert.deepEqual([centered.target, centered.yaw, centered.pitch, centered.distance], [[1200, 2600, 340], CAMERA.yaw, CAMERA.pitch, CAMERA.distance]);
  const at = project(viewOf(centered, SIZE), SIZE, [1200, 2600, 340], 4000)!;
  assert.ok(Math.abs(at.x - SIZE.width / 2) < 0.01 && Math.abs(at.y - SIZE.height / 2) < 0.01, `${at.x} ${at.y}`);
  assert.deepEqual(centerTop(frameTop(1.5), [0.2, 0.9]), { kind: 'top', center: [0.2, 0.9], span: frameTop(1.5).span });
});

test('framing takes in a sea that stands above the terrain, as far as a picture can hold it', () => {
  const terrain = { terrainSize: 4032, heightRange: 1008 };
  const size = { width: 1600, height: 900 };
  const dry = frameOrbit(terrain, 1, 16 / 9, { yaw: 300, pitch: 30 }, 0.25, null);
  assert.deepEqual(frameOrbit(terrain, 1, 16 / 9, { yaw: 300, pitch: 30 }, 0.25, 0.3), dry, 'a sea below the terrain\'s own heights changes nothing');
  assert.deepEqual(frameOrbit(terrain, 1, 16 / 9, { yaw: 300, pitch: 30 }, 0.25, -1e9), dry);
  const flooded = frameOrbit(terrain, 1, 16 / 9, { yaw: 300, pitch: 30 }, 0.25, 2);
  assert.ok(flooded.distance > dry.distance * 1.1);
  for (const x of [0, 4032]) {
    for (const y of [0, 4032]) {
      const at = project(viewOf(flooded, size), size, [x, y, 2 * 1008], 4032);
      assert.ok(at !== null && at.x >= 0 && at.x <= size.width && at.y >= 0 && at.y <= size.height, `a corner of the sea at ${at?.x} ${at?.y}`);
    }
  }
  const absurd = frameOrbit(terrain, 1, 16 / 9, { yaw: 300, pitch: 30 }, 0.25, 1e9);
  assert.ok(Number.isFinite(absurd.distance) && absurd.distance < dry.distance * 6, 'a sea level that is no height of this terrain does not send the camera away');
});

test('lengths are written as a person reads them', () => {
  assert.deepEqual([metres(0), metres(3.14159), metres(42.42), metres(512.3), metres(12345.6), metres(-250.4)], ['0 m', '3.14 m', '42.4 m', '512 m', '12 346 m', '-250 m']);
  assert.equal(metres(Number.NaN), '');
});
