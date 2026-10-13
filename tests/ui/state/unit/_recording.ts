// The recordings of ../assets/ (testing.md 8.5 rule 5), as ../record.ts wrote them. Not a test file.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EngineEvent } from '../../../../src/core/runtime.ts';
import { reduceEngineEvent, INITIAL_ENGINE_STATE, type EngineState } from '../../../../src/app/state/engine-store.ts';

export interface Recording {
  readonly about: string;
  /** Node ids by the names record.ts gave them. */
  readonly ids: Readonly<Record<string, string>>;
  /** How many events had arrived when a step had come to rest, and the revision the engine had been sent by then. */
  readonly marks: Readonly<Record<string, { readonly events: number; readonly engineRevision: number }>>;
  readonly events: readonly EngineEvent[];
}

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');

export function loadRecording(name: string): Recording {
  const raw = JSON.parse(readFileSync(path.join(ASSETS, `${name}.json`), 'utf8')) as Recording;
  // A recording holds no pixels; an event has the member all the same.
  const events = raw.events.map((event) => (event.type === 'thumbnail' ? { ...event, rgba: new Uint8ClampedArray(0) } : event));
  return { ...raw, events };
}

/** The state after the first `count` events of the recording. */
export function stateAt(recording: Recording, count: number, from: EngineState = INITIAL_ENGINE_STATE): EngineState {
  let state = from;
  for (let i = 0; i < count; i++) state = reduceEngineEvent(state, recording.events[i]!);
  return state;
}

/** The state when the step of this name had come to rest. */
export function stateAtMark(recording: Recording, mark: string): EngineState {
  const at = recording.marks[mark];
  if (!at) throw new Error(`The recording has no mark "${mark}": ${Object.keys(recording.marks).join(', ')}`);
  return stateAt(recording, at.events);
}
