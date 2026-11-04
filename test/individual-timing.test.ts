import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from './helpers/tool-harness.ts';
import { registerFixtureTools, attributeCommand } from '../src/tools/fixtures.ts';
import { validateLooks } from '../src/tools/cuelists.ts';
import { Validator } from '../src/validate.ts';

let h: Harness;
let timing: Record<string, unknown> | undefined;
let masks: { activePhaser: number; individual: number } | undefined;
before(async () => { h = await startHarness(registerFixtureTools); });
after(async () => { await h.close(); });
beforeEach(() => {
  timing = { fade: 1.25, delay: 0.4 };
  masks = { activePhaser: 76, individual: 76 };
  h.fake.reset();
  h.fake.onCommand(() => 'OK');
  h.fake.on('objects', args => args.ref === 'Selection'
    ? { total: 1, items: [{ fields: { CountTotalSelected: '1', CountFullySelected: '1' } }] }
    : { total: 1, items: [{ name: 'Dimmer' }] });
  h.fake.on('programmer', () => ({
    source: 'programmer', scope: 'selection', total: 1, count: 1,
    coverage: { complete: true }, fixturesTruncated: false,
    scannedFixtures: [{ fid: '201', subfixtureIndex: 84, name: 'Wash', attributes: ['Dimmer'] }],
    rows: [{ fid: '201', subfixtureIndex: 84, attribute: 'Dimmer', value: 17,
      valueRaw: 0x2b851f, stepCount: 1, physicalFrom: 0, physicalTo: 1, readout: 'Percent',
      ...(timing ? { phaser: timing } : {}), ...(masks ? { masks } : {}) }],
  }));
});

test('individual timing: command retains fade, zero delay and legacy spelling', () => {
  assert.equal(attributeCommand('Dimmer', 17, 'Percent', { fade: 1.25, delay: 0 }),
    'Attribute "Dimmer" At Absolute Percent 17 Fade 1.25 Delay 0');
  assert.equal(attributeCommand('Dimmer', 17, 'Percent'), 'Attribute "Dimmer" At Absolute Percent 17');
});

test('individual timing: multi-attribute setter sends and verifies requested timing', async () => {
  const r = await h.callJson('gma3_set_attributes', { use_selection: true,
    values: [{ attribute: 'Dimmer', value: 17, unit: 'percent', fade: 1.25, delay: 0.4 }] });
  assert.equal(r.result.verification.status, 'matched', r.text);
  assert(h.fake.commands.includes('Attribute "Dimmer" At Absolute Percent 17 Fade 1.25 Delay 0.4'));
  assert.deepEqual(r.result.verification.actual.individualTiming?.rows.map(x =>
    [x.attribute,x.fade,x.delay,x.masks.activePhaser,x.masks.individual]), [['Dimmer',1.25,0.4,76,76]]);
});

test('individual timing: matching level cannot hide a wrong fade', async () => {
  timing = { fade: 9, delay: 0.4 };
  const r = await h.callJson('gma3_set_attributes', { use_selection: true,
    values: [{ attribute: 'Dimmer', value: 17, unit: 'percent', fade: 1.25, delay: 0.4 }] });
  assert.equal(r.result.verification.status, 'mismatched', r.text);
  assert.match(r.result.verification.detail, /fade.*9.*1.25/i);
});

test('individual timing: missing timing readback is unavailable', async () => {
  timing = undefined;
  const r = await h.callJson('gma3_set_attributes', { use_selection: true,
    values: [{ attribute: 'Dimmer', value: 17, unit: 'percent', fade: 1.25 }] });
  assert.equal(r.result.verification.status, 'unavailable', r.text);
});

test('individual timing: negative delay is rejected before mutation', async () => {
  const r = await h.callJson('gma3_set_attributes', { use_selection: true,
    values: [{ attribute: 'Dimmer', value: 17, unit: 'percent', delay: -1 }] });
  assert.equal(r.result.outcome, 'failed', r.text);
  assert.equal(h.fake.commands.length, 0);
});

test('individual timing: explicit zero survives the single-attribute setter', async () => {
  timing = { fade: 0, delay: 0 };
  const r = await h.callJson('gma3_set_attribute', { use_selection: true,
    attribute: 'Dimmer', value: 17, unit: 'percent', fade: 0, delay: 0 });
  assert.equal(r.result.verification.status, 'matched', r.text);
  assert(h.fake.commands.includes('Attribute "Dimmer" At Absolute Percent 17 Fade 0 Delay 0'));
});

test('individual timing: bulk cue parsing retains independently requested timings', () => {
  const v = new Validator();
  const looks = validateLooks(v, { fixtures: '201', values: [
    { attribute: 'Dimmer', value: 17, unit: 'percent', fade: 1.25, delay: 0.4 },
    { attribute: 'Pan', value: 50, unit: 'percent', fade: 4, delay: 0 },
  ] }, 'cue', undefined);
  assert(v.ok, JSON.stringify(v.errors));
  assert.deepEqual(looks[0].values.map(x => [x.fade, x.delay]), [[1.25, 0.4], [4, 0]]);
});

test('individual timing: a relative value cannot request unverified timing', () => {
  const v = new Validator();
  validateLooks(v, { fixtures: '201', values: [
    { attribute: 'Pan', value: 12, unit: 'percent', layer: 'relative', delay: 0 },
  ] }, 'cue', undefined);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(' '), /individual fade and delay require an absolute value/);
});

test('individual timing: inactive default zero is not a stored explicit zero', async () => {
  timing = { fade: 0, delay: 0 }; masks = { activePhaser: 64, individual: 64 };
  const r = await h.callJson('gma3_set_attributes', { use_selection: true,
    values: [{ attribute: 'Dimmer', value: 17, unit: 'percent', fade: 0, delay: 0 }] });
  assert.equal(r.result.verification.status, 'mismatched', r.text);
  assert.match(r.result.verification.detail, /timing.*not active/i);
});

test('individual timing: missing activation masks cannot prove requested timing', async () => {
  masks = undefined;
  const r = await h.callJson('gma3_set_attributes', { use_selection: true,
    values: [{ attribute: 'Dimmer', value: 17, unit: 'percent', fade: 1.25 }] });
  assert.equal(r.result.verification.status, 'unavailable', r.text);
});

test('individual timing: individual data with inactive timing layer is mismatched', async () => {
  masks = { activePhaser: 64, individual: 76 };
  const r = await h.callJson('gma3_set_attributes', { use_selection: true,
    values: [{ attribute: 'Dimmer', value: 17, unit: 'percent', delay: 0.4 }] });
  assert.equal(r.result.verification.status, 'mismatched', r.text);
});
