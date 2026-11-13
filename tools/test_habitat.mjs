// Checks the scoring model against the numbers the README promises, and that the Python build
// uses the same cover-type table. Run: node tools/test_habitat.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = {};
await import('../habitat.js');
const H = window.Habitat, F = H.F;
const stand = (o) => ({ group: 'aspen', cover: 'Aspen', age: 10, stock: 'well', acres: 10, lowland: false, transition: false, ...o });
const score = (s, flags = 0, season = 'early') => H.score(s, flags, season).score;

assert.equal(score(stand()), 75, 'young aspen on its own tops out at 75');
assert.equal(score(stand(), F.alder), 90, 'alder next door +15');
assert.equal(score(stand(), F.matureAspen), 87, 'mature aspen next door +12 early');
assert.equal(score(stand(), F.matureAspen, 'late'), 90, 'mature aspen next door +15 late');
assert.equal(score(stand(), F.lowland), 81, 'upland-lowland transition +6');
assert.equal(score(stand(), F.youngConifer, 'late'), 80, 'young conifer +5, late only');
assert.equal(score(stand(), F.youngConifer), 75, 'young conifer adds nothing early');
assert.equal(score(stand(), F.matureConifer), 70, 'mature conifer -5');
assert.equal(score(stand(), F.alder | F.matureAspen | F.lowland), 100, 'the full combination reaches 100');
assert.equal(score(stand({ acres: 30 })), 68, 'cut over 20 acres x0.9');
assert.equal(score(stand({ acres: 50 })), 60, 'cut over 40 acres x0.8');
assert.equal(score(stand({ acres: 90 })), 53, 'cut over 80 acres x0.7');
assert.equal(score(stand({ stock: 'poor' })), 56, 'poor stocking x0.75');
assert.equal(score(stand({ stock: 'medium' })), 68, 'medium stocking x0.9');
assert.equal(score(stand({ age: 1 })), 10, 'a fresh cut is food, not cover');
assert.equal(score(stand({ group: 'none', cover: 'Water' })), 0, 'not grouse cover');

// The weekly Python build keeps its own copy of the cover-type table.
const py = readFileSync(new URL('./build_summary.py', import.meta.url), 'utf8');
const dict = /^GROUPS = (\{[\s\S]*?\n\})/m.exec(py)[1].replace(/,(\s*[}\]])/g, '$1');
assert.deepEqual(JSON.parse(dict), H.GROUPS, 'build_summary.py GROUPS matches habitat.js');
console.log('habitat: all checks pass');
