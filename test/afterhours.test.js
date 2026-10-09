import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { DAY, MIN, NIGHT, SPOT, closeAll, setup } from './helpers.js';

after(closeAll);

test('under-18 users cannot sign up', async () => {
  const t = await setup();
  const r = await t.call('POST', '/v1/users', { body: { handle: 'kid1', birthdate: '2012-01-01' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'age_restricted');
  const ok = await t.call('POST', '/v1/users', { body: { handle: 'adult1', birthdate: '1999-01-01' } });
  assert.equal(ok.status, 200);
  t.close();
});

test('requests without a valid token are rejected', async () => {
  const t = await setup();
  assert.equal((await t.call('POST', '/v1/map', { body: SPOT })).status, 401);
  assert.equal((await t.call('POST', '/v1/map', { token: 'nope', body: SPOT })).status, 401);
  t.close();
});

test('map is locked in the daytime, with a teaser and next unlock at 8 PM local', async () => {
  const t = await setup(DAY);
  const u = await t.newUser();
  const r = await t.call('POST', '/v1/map', { token: u.token, body: SPOT });
  assert.equal(r.body.locked, true);
  assert.deepEqual(r.body.pins, []);
  assert.equal(r.body.unlocks_at, Date.UTC(2026, 9, 10, 0, 0, 0)); // 8 PM EDT = 00:00Z
  assert.equal(r.body.teaser.scheduled_spots, 0);
  const p = await t.call('POST', '/v1/pins', { token: u.token, body: t.pinBody() });
  assert.equal(p.status, 403);
  assert.equal(p.body.error.code, 'locked');
  t.close();
});

test('map unlocks at night and shows a new pin', async () => {
  const t = await setup();
  const u = await t.newUser();
  const created = await t.call('POST', '/v1/pins', { token: u.token, body: t.pinBody() });
  assert.equal(created.status, 200);
  assert.equal(created.body.expires_at, NIGHT + 3 * 60 * MIN);
  const m = await t.call('POST', '/v1/map', { token: u.token, body: SPOT });
  assert.equal(m.body.locked, false);
  assert.equal(m.body.pins.length, 1);
  t.close();
});

test('pin creation needs device attestation, a known category, and clean content', async () => {
  const t = await setup();
  const u = await t.newUser();
  const post = (over) => t.call('POST', '/v1/pins', { token: u.token, body: t.pinBody(over) });
  assert.equal((await post({ attestation: 'spoofed' })).body.error.code, 'attestation_failed');
  assert.equal((await post({ category: 'weapons' })).body.error.code, 'invalid_category');
  assert.equal((await post({ title: 'Street Takeover tonight' })).body.error.code, 'content_policy');
  assert.equal((await post({ accuracy_m: 500 })).body.error.code, 'low_accuracy');
  assert.equal((await post({ lat: 0, lng: 0 })).body.error.code, 'outside_service_area');
  t.close();
});

test('pins expire after 3 hours and vanish from the map', async () => {
  const t = await setup();
  const u = await t.newUser();
  await t.call('POST', '/v1/pins', { token: u.token, body: t.pinBody() });
  t.state.now += 3 * 60 * MIN + 1;
  const m = await t.call('POST', '/v1/map', { token: u.token, body: SPOT });
  assert.equal(m.body.pins.length, 0);
  t.close();
});

test('Still Here needs two different people on site to extend a pin', async () => {
  const t = await setup();
  const [creator, a, b] = [await t.newUser(), await t.newUser(), await t.newUser()];
  const pin = (await t.call('POST', '/v1/pins', { token: creator.token, body: t.pinBody() })).body;

  assert.equal((await t.call('POST', `/v1/pins/${pin.id}/still-here`, { token: creator.token, body: t.near() })).body.error.code, 'own_pin');
  const far = await t.call('POST', `/v1/pins/${pin.id}/still-here`, { token: a.token, body: t.near({ lat: 42.2908 }) });
  assert.equal(far.body.error.code, 'not_present');

  t.state.now += 2 * 60 * MIN;
  const first = await t.call('POST', `/v1/pins/${pin.id}/still-here`, { token: a.token, body: t.near() });
  assert.equal(first.body.extended, false);
  const again = await t.call('POST', `/v1/pins/${pin.id}/still-here`, { token: a.token, body: t.near() });
  assert.equal(again.body.extended, false); // the same person tapping twice does not count twice
  const second = await t.call('POST', `/v1/pins/${pin.id}/still-here`, { token: b.token, body: t.near() });
  assert.equal(second.body.extended, true);
  assert.equal(second.body.expires_at, t.state.now + 3 * 60 * MIN);
  t.close();
});

test('a pin never outlives its 12-hour cap, and nothing can be confirmed once the map locks', async () => {
  const t = await setup(NIGHT - 60 * MIN); // 8:00 PM
  const [creator, a, b] = [await t.newUser(), await t.newUser(), await t.newUser()];
  const pin = (await t.call('POST', '/v1/pins', { token: creator.token, body: t.pinBody() })).body;
  const maxEnd = t.state.now + 12 * 60 * MIN;
  for (let i = 0; i < 4; i++) {
    t.state.now += 2 * 60 * MIN; // 10 PM, midnight, 2 AM, 4 AM
    await t.call('POST', `/v1/pins/${pin.id}/still-here`, { token: a.token, body: t.near() });
    const r = await t.call('POST', `/v1/pins/${pin.id}/still-here`, { token: b.token, body: t.near() });
    assert.equal(r.status, 200);
    assert.ok(r.body.expires_at <= maxEnd);
  }
  t.state.now += 2 * 60 * MIN; // 6 AM: map is locked again
  const late = await t.call('POST', `/v1/pins/${pin.id}/still-here`, { token: a.token, body: t.near() });
  assert.equal(late.body.error.code, 'locked');
  t.close();
});

test('far-away viewers only get an approximate location; nearby viewers get exact', async () => {
  const t = await setup();
  const u = await t.newUser();
  const v = await t.newUser();
  await t.call('POST', '/v1/pins', { token: u.token, body: t.pinBody() });
  const farView = (await t.call('POST', '/v1/map', { token: v.token, body: { lat: 42.32, lng: -83.743 } })).body.pins[0];
  assert.equal(farView.approximate, true);
  assert.notEqual(farView.lat, SPOT.lat);
  const nearView = (await t.call('POST', '/v1/map', { token: v.token, body: SPOT })).body.pins[0];
  assert.equal(nearView.approximate, false);
  assert.equal(nearView.lat, SPOT.lat);
  t.close();
});

test('three reports hide a pin', async () => {
  const t = await setup();
  const creator = await t.newUser();
  const pin = (await t.call('POST', '/v1/pins', { token: creator.token, body: t.pinBody() })).body;
  for (let i = 0; i < 3; i++) {
    const r = await t.newUser();
    await t.call('POST', `/v1/pins/${pin.id}/report`, { token: r.token, body: { reason: 'sketchy' } });
  }
  const v = await t.newUser();
  assert.equal((await t.call('POST', '/v1/map', { token: v.token, body: SPOT })).body.pins.length, 0);
  t.close();
});

test('new accounts have a tighter nightly pin limit', async () => {
  const t = await setup();
  const u = await t.newUser({ established: false });
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push((await t.call('POST', '/v1/pins', { token: u.token, body: t.pinBody() })).status);
  assert.deepEqual(codes, [200, 200, 403]);
  t.close();
});

test('sensitive zones block pins and presence', async () => {
  const t = await setup();
  await t.call('POST', '/v1/sensitive-zones', { admin: true, body: { label: 'school', ...SPOT, radius_m: 300 } });
  const u = await t.newUser();
  const r = await t.call('POST', '/v1/pins', { token: u.token, body: t.pinBody() });
  assert.equal(r.body.error.code, 'sensitive_location');
  assert.equal((await t.call('POST', '/v1/sensitive-zones', { body: {} })).status, 403);
  t.close();
});

// ---- Crowd presence -------------------------------------------------------

async function crowdScene(t, count) {
  const creator = await t.newUser();
  const pin = (await t.call('POST', '/v1/pins', { token: creator.token, body: t.pinBody() })).body;
  const people = [];
  for (let i = 0; i < count; i++) {
    const p = await t.newUser({ optIn: true });
    const r = await t.call('POST', '/v1/presence', { token: p.token, body: SPOT });
    assert.equal(r.body.counted, true);
    people.push(p);
  }
  return { pin, people, creator };
}

const crowdOf = async (t, viewer, pinId, loc = SPOT) =>
  (await t.call('POST', `/v1/pins/${pinId}/view`, { token: viewer.token, body: loc })).body.crowd;

test('presence is opt-in', async () => {
  const t = await setup();
  const u = await t.newUser();
  const r = await t.call('POST', '/v1/presence', { token: u.token, body: SPOT });
  assert.equal(r.body.error.code, 'presence_off');
  t.close();
});

test('crowd counts are hidden below 5 and use a delayed snapshot', async () => {
  const t = await setup();
  const { pin, creator } = await crowdScene(t, 4);
  t.state.now += 6 * MIN;
  assert.equal(await crowdOf(t, creator, pin.id), null); // only 4 people

  const fifth = await t.newUser({ optIn: true });
  await t.call('POST', '/v1/presence', { token: fifth.token, body: SPOT });
  assert.equal(await crowdOf(t, creator, pin.id), null); // 5th arrived after the last snapshot

  t.state.now += 5 * MIN; // next snapshot includes everyone
  const crowd = await crowdOf(t, creator, pin.id);
  assert.equal(crowd.band, '5+');
  assert.equal(crowd.dots.length, 5);
  t.close();
});

test('crowd dots are decoration: stable within a snapshot and never at a real position', async () => {
  const t = await setup();
  const { pin, creator } = await crowdScene(t, 6);
  t.state.now += 6 * MIN;
  const a = await crowdOf(t, creator, pin.id);
  const b = await crowdOf(t, creator, pin.id);
  assert.deepEqual(a.dots, b.dots);
  assert.ok(a.dots.every((d) => !(d.lat === SPOT.lat && d.lng === SPOT.lng)));
  t.close();
});

test('far-away viewers get the band but no dots', async () => {
  const t = await setup();
  const { pin, creator } = await crowdScene(t, 5);
  t.state.now += 6 * MIN;
  const crowd = await crowdOf(t, creator, pin.id, { lat: 42.32, lng: -83.743 });
  assert.equal(crowd.band, '5+');
  assert.equal(crowd.dots, undefined);
  t.close();
});

test('leaving removes you from the count', async () => {
  const t = await setup();
  const { pin, people, creator } = await crowdScene(t, 5);
  t.state.now += 6 * MIN;
  assert.equal((await crowdOf(t, creator, pin.id)).band, '5+');

  const left = await t.call('POST', '/v1/presence', { token: people[0].token, body: { lat: 42.3, lng: -83.7 } });
  assert.equal(left.body.counted, false);
  t.state.now += 5 * MIN;
  assert.equal(await crowdOf(t, creator, pin.id), null);
  t.close();
});

test('presence expires on its own and opting out clears you immediately', async () => {
  const t = await setup();
  const { pin, people, creator } = await crowdScene(t, 6);
  t.state.now += 6 * MIN;
  await t.call('PATCH', '/v1/me', { token: people[0].token, body: { presence_opt_in: false } });
  t.state.now += 5 * MIN;
  assert.equal((await crowdOf(t, creator, pin.id)).band, '5+'); // 5 left
  await t.call('PATCH', '/v1/me', { token: people[1].token, body: { presence_opt_in: false } });
  t.state.now += 5 * MIN;
  assert.equal(await crowdOf(t, creator, pin.id), null); // 4 left, under the minimum

  t.state.now += 31 * MIN; // everyone else times out
  assert.equal(await crowdOf(t, creator, pin.id), null);
  t.close();
});

test('presence never stores coordinates', async () => {
  const t = await setup();
  await crowdScene(t, 1);
  const cols = t.app.db.prepare('PRAGMA table_info(presence)').all().map((c) => c.name);
  assert.ok(!cols.includes('lat') && !cols.includes('lng'));
  t.close();
});

// ---- Squads / Ghost Nodes -------------------------------------------------

test('ghost nodes are visible only to squad members', async () => {
  const t = await setup();
  const [owner, friend, stranger] = [await t.newUser(), await t.newUser(), await t.newUser()];
  const squad = (await t.call('POST', '/v1/squads', { token: owner.token, body: { name: 'The Crew' } })).body;
  await t.call('POST', '/v1/squads/join', { token: friend.token, body: { invite_code: squad.invite_code } });
  const node = await t.call('POST', `/v1/squads/${squad.id}/nodes`, { token: owner.token, body: { ...SPOT, name: 'Back lot' } });
  assert.equal(node.status, 200);
  const seen = await t.call('GET', `/v1/squads/${squad.id}/nodes`, { token: friend.token });
  assert.equal(seen.body.nodes.length, 1);
  const denied = await t.call('GET', `/v1/squads/${squad.id}/nodes`, { token: stranger.token });
  assert.equal(denied.body.error.code, 'not_in_squad');
  const map = await t.call('POST', '/v1/map', { token: stranger.token, body: SPOT });
  assert.equal(JSON.stringify(map.body).includes('Back lot'), false); // never on the public map
  t.state.now += 7 * 60 * MIN;
  assert.equal((await t.call('GET', `/v1/squads/${squad.id}/nodes`, { token: friend.token })).body.nodes.length, 0);
  t.close();
});

// ---- Flash Drops ----------------------------------------------------------

async function vendor(t, tokens) {
  const v = await t.newUser();
  await t.call('POST', `/v1/admin/vendors/${v.id}/tokens`, { admin: true, body: { amount: tokens } });
  return v;
}
const dropBody = (over = {}) => ({ ...SPOT, title: '50 hoodies left', ...over });

test('only vendors with tokens can run a Flash Drop, and drops are labeled promoted', async () => {
  const t = await setup();
  const plain = await t.newUser();
  assert.equal((await t.call('POST', '/v1/vendor/drops', { token: plain.token, body: dropBody() })).body.error.code, 'not_vendor');

  const v = await vendor(t, 1);
  const ok = await t.call('POST', '/v1/vendor/drops', { token: v.token, body: dropBody() });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ends_at - ok.body.starts_at, 60 * MIN);
  const empty = await t.call('POST', '/v1/vendor/drops', { token: v.token, body: dropBody() });
  assert.equal(empty.body.error.code, 'no_tokens');

  const viewer = await t.newUser();
  const m = await t.call('POST', '/v1/map', { token: viewer.token, body: { lat: 42.3, lng: -83.74 } });
  assert.equal(m.body.drops.length, 1);
  assert.equal(m.body.drops[0].promoted, true);
  t.state.now += 61 * MIN;
  assert.equal((await t.call('POST', '/v1/map', { token: viewer.token, body: SPOT })).body.drops.length, 0);
  t.close();
});

test('Flash Drops are capped per city per night and tokens are not spent on rejection', async () => {
  const t = await setup();
  const v = await vendor(t, 10);
  for (let i = 0; i < 5; i++) {
    assert.equal((await t.call('POST', '/v1/vendor/drops', { token: v.token, body: dropBody() })).status, 200);
  }
  const sixth = await t.call('POST', '/v1/vendor/drops', { token: v.token, body: dropBody() });
  assert.equal(sixth.body.error.code, 'drop_cap');
  const { balance } = t.app.db.prepare('SELECT balance FROM vendor_tokens WHERE vendor_id = ?').get(v.id);
  assert.equal(balance, 5);
  t.close();
});

test('scheduled drops appear in the daytime teaser count', async () => {
  const t = await setup(DAY);
  const v = await vendor(t, 2);
  const startsAt = new Date(Date.UTC(2026, 9, 10, 2, 0, 0)).toISOString(); // 10 PM tonight
  assert.equal((await t.call('POST', '/v1/vendor/drops', { token: v.token, body: dropBody({ starts_at: startsAt }) })).status, 200);
  const viewer = await t.newUser();
  const m = await t.call('POST', '/v1/map', { token: viewer.token, body: SPOT });
  assert.equal(m.body.locked, true);
  assert.equal(m.body.teaser.scheduled_spots, 1);
  assert.deepEqual(m.body.drops, []);
  t.close();
});
