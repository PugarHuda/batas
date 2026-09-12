// The paid answer, tested without paying for it.
//
// Everything this file checks decides what a caller is told about somebody else's identity, and
// each case here was wrong until today. `agentId: []` came back `registered: true`, because
// `BigInt([])` is `0n` and the registry was duly asked about agent #0. A `maker` that was not a
// string threw out of `.toLowerCase()` and the service reported `registered: false` — telling a
// paying caller that an identity does not exist when the truth was that we never managed to ask.
//
// That distinction is the whole point of the endpoint, so it is exercised directly rather than
// through HTTP: the route is behind a paywall, and a test that costs HBAR is a test people stop
// running.

import test from 'node:test';
import assert from 'node:assert/strict';

import { inspect } from './service.mjs';
import { OWNER, AGENT_ID } from './deployment.mjs';

const LIVE_PROGRAM =
    '0x212100000000000000006367be30fcbd45ea00000000000000001aeff914e72b45e8802005006acd0476222e945800bd6cdd60521b64a12d7b3f12fc90916a6b39d2bae5eaeda9283535ddc98f1991c81ed5cd7e056167656e74700300753050000208000000006aa58586';

test('a program that is not hex is refused before anything is looked up', async () => {
    for (const program of [undefined, null, 42, {}, 'not hex', '0xZZ']) {
        const { status } = await inspect({ program });
        assert.equal(status, 400, `${JSON.stringify(program)} should be a bad request`);
    }
});

test('a well formed request returns the terms and the publication', async () => {
    const { status, body } = await inspect({ program: LIVE_PROGRAM });
    assert.equal(status, 200);
    assert.equal(body.guarded, true);
    assert.equal(body.instructionCount, 6);
    assert.equal(body.publication.published, true);
    assert.equal(body.operator, undefined, 'the operator lookup is opt-in and was not asked for');
});

test('a malformed agentId is reported as a bad parameter, not as an unregistered identity', async () => {
    // The two are not the same, and only one of them is a claim about a third party.
    for (const agentId of [[], {}, 'abc', '1e999', -1, 1.5, null]) {
        const { status, body } = await inspect({ program: LIVE_PROGRAM, agentId });
        assert.equal(status, 200, 'the mandate decode still succeeded, so the answer is still owed');
        assert.equal(body.operator.checked, false, `${JSON.stringify(agentId)} should not have been checked`);
        assert.equal(body.operator.registered, undefined, 'saying "not registered" here would be a lie');
        assert.match(body.operator.error, /non-negative integer/);
    }
});

test('a malformed maker is reported as a bad parameter too', async () => {
    for (const maker of [{}, [], 42, '0x', 'not-an-address', `${OWNER}00`]) {
        const { body } = await inspect({ program: LIVE_PROGRAM, agentId: AGENT_ID, maker });
        assert.equal(body.operator.checked, false);
        assert.equal(body.operator.registered, undefined);
        assert.match(body.operator.error, /20-byte address/);
    }
});

test('the live identity resolves and vouches for its own maker', async () => {
    const { body } = await inspect({ program: LIVE_PROGRAM, agentId: AGENT_ID, maker: OWNER });
    assert.equal(body.operator.checked, true);
    assert.equal(body.operator.registered, true);
    assert.equal(body.operator.check.vouched, true);
});

test('and refuses to vouch for a stranger, while still saying it looked', async () => {
    const stranger = '0x0000000000000000000000000000000000000001';
    const { body } = await inspect({ program: LIVE_PROGRAM, agentId: AGENT_ID, maker: stranger });
    assert.equal(body.operator.checked, true, 'the lookup succeeded; it is the vouching that failed');
    assert.equal(body.operator.registered, true);
    assert.equal(body.operator.check.vouched, false);
    assert.match(body.operator.check.reason, /did not grant this mandate/);
});

test('an id that was never minted is checked and comes back unregistered', async () => {
    // This one *is* a claim about the registry, and it is a true one — distinct from the cases above.
    const { body } = await inspect({ program: LIVE_PROGRAM, agentId: '99999999' });
    assert.equal(body.operator.checked, true);
    assert.equal(body.operator.registered, false);
});

test('a program too long to be a mandate is bounded rather than enumerated', async () => {
    // 234KB in, 2.69MB out, for one payment of a tenth of a cent. The terms are still read from the
    // whole stream; only the listing is capped, and the report says so.
    const huge = `0x${'5000'.repeat(60_000)}`;
    const { status, body } = await inspect({ program: huge });
    assert.equal(status, 200);
    assert.equal(body.instructionCount, 60_000);
    assert.equal(body.instructions.length, 256);
    assert.ok(body.notes.some((n) => /the first 256 are listed/.test(n)), JSON.stringify(body.notes));
    assert.ok(JSON.stringify(body).length < 200_000, 'the answer must not be megabytes');
});
