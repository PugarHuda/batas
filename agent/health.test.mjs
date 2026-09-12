// The morning report's arithmetic, pinned against the live position as it stood on 2026-09-12.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUnits } from 'viem';

import { deriveHealth } from './health.mjs';

const U = (s) => parseUnits(s, 18);
const NOW = 1_789_300_000; // 2026-09-12, ~29 days before the expiry below
const SHIP_AT = NOW - 3600 * 5;

const terms = { maxAmountIn: U('7.162902849964033514'), minRateE18: U('1.941043832593008104'), feeBps: 30_000, expiry: 1_791_820_918 };
const shipped = { a: U('1010'), b: U('1980.256839312058774023'), at: SHIP_AT, block: 1, tx: '0xship' };
const held = { valid: true, revoked: false, expiry: terms.expiry, secondsLeft: terms.expiry - NOW };
const ledgerOk = { publication: { published: true, consensusTimestamp: '1789232545.719876104' }, revocations: { revocations: [] } };
const quiet = { feedbackCount: 0, summaryValue: '0', breachedCount: 0 };

const near = (actual, expected, tol, what) => assert.ok(Math.abs(Number(actual) - expected) <= tol, `${what}: ${actual} vs ${expected}`);
const codes = (r) => r.alerts.map((a) => a.code);

test('untouched since the ship: ok, with the headroom the reserves imply', () => {
    const r = deriveHealth({ terms, reservesNow: { a: shipped.a, b: shipped.b }, reservesAtShip: shipped, trades: [], authority: held, ledger: ledgerOk, reputation: quiet, now: NOW });
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.alerts, []);
    near(r.headroom.spotVsFloorBps, 100, 2, 'spot vs floor');
    near(r.headroom.marginalBps, 70.7, 0.5, 'marginal');
    near(r.headroom.worstCaseOutflowB, 13.90, 0.01, 'worst-case outflow');
    near(r.headroom.worstCaseOutflowPctB, 0.70, 0.01, 'worst-case %');
    near(r.headroom.absorbableBeforeFloorA, 3.575, 0.005, 'absorbable');
    assert.equal(r.headroom.driftSinceGrantBps, 0);
    assert.equal(r.headroom.floorAgeHours, 5);
});

test('one cap-sized trade inverts the floor and thins the B side', () => {
    const amountIn = terms.maxAmountIn;
    const fee = (amountIn * 30_000n + 9_999_999n) / 10_000_000n;
    const net = amountIn - fee;
    const amountOut = (net * shipped.b) / (shipped.a + net);
    const trade = { block: 2, tx: '0xswap', at: SHIP_AT + 60, taker: '0xTAKER', maker: '0xMAKER', amountIn, amountOut };
    const r = deriveHealth({
        terms, reservesNow: { a: shipped.a + net, b: shipped.b - amountOut }, reservesAtShip: shipped,
        trades: [trade], authority: held, ledger: ledgerOk, reputation: quiet, now: NOW,
    });
    assert.equal(r.status, 'critical');
    assert.ok(r.headroom.marginalBps < 0);
    assert.ok(codes(r).includes('FLOOR_INVERTED'));
    assert.ok(codes(r).includes('TRADE_AT_FLOOR'), 'the cap trade sits on the floor by construction');
    assert.ok(!codes(r).includes('RESERVES_DOWN'), 'one cap trade takes 0.7% of B, under the 1% that is worth a word');
    assert.equal(r.alerts.find((a) => a.code === 'FLOOR_INVERTED').since, new Date((SHIP_AT + 60) * 1000).toISOString());
    near(r.trades[0].perTradeCapUtilisationPct, 100, 0.01, 'cap utilisation');
    assert.equal(r.trades[0].selfTrade, false);
});

test('the B side draining is info under 99% and a warning under 95%', () => {
    const at = (pct) => deriveHealth({
        terms, reservesNow: { a: shipped.a, b: (shipped.b * BigInt(pct)) / 100n }, reservesAtShip: shipped,
        trades: [], authority: held, ledger: ledgerOk, reputation: quiet, now: NOW,
    }).alerts.find((a) => a.code === 'RESERVES_DOWN')?.severity;
    assert.equal(at(100), undefined);
    assert.equal(at(97), 'info');
    assert.equal(at(94), 'warn');
});

test('docked: no reserves, no headroom, status says so', () => {
    const r = deriveHealth({ terms, reservesNow: null, reservesAtShip: shipped, trades: [], authority: held, ledger: ledgerOk, reputation: quiet, now: NOW });
    assert.equal(r.status, 'docked');
    assert.equal(r.headroom, null);
});

test('the ledger, the name, the clock and the counterparties each get a say', () => {
    const r = deriveHealth({
        terms: { ...terms, expiry: NOW + 3600 },
        reservesNow: { a: shipped.a, b: shipped.b }, reservesAtShip: shipped,
        trades: [{ block: 2, tx: '0xself', at: SHIP_AT + 1, taker: '0xabc', maker: '0xABC', amountIn: U('1'), amountOut: U('1.95') }],
        authority: { ...held, expiry: NOW + 1800 },
        ledger: {
            publication: { published: true, consensusTimestamp: '1789232545.719876104' },
            revocations: { revocations: [{ label: 'agent', sequenceNumber: 11, consensusTimestamp: '1789232596.601623794', revokedAt: '2026-09-12T20:23:16.601Z' }] },
        },
        reputation: { feedbackCount: 3, summaryValue: '12', breachedCount: 1 },
        now: NOW,
    });
    assert.deepEqual(codes(r).sort(), ['EXPIRY_SOON', 'FLOOR_BREACH_REPORTED', 'LEDGER_DISAGREES', 'NAME_SHORTER_THAN_MANDATE', 'SELF_TRADE']);
    assert.equal(r.status, 'critical');
    assert.equal(r.alerts.find((a) => a.code === 'LEDGER_DISAGREES').since, '2026-09-12T20:23:16.000Z');
});

test('a revoked name is critical and says revoked, not expired; a missing publication is a warning', () => {
    const r = deriveHealth({
        terms, reservesNow: { a: shipped.a, b: shipped.b }, reservesAtShip: shipped, trades: [],
        authority: { valid: false, revoked: true, expiry: NOW - 10, reason: 'mandate name "agent" was revoked at X, ahead of its term' },
        ledger: { publication: { published: false, reason: 'no such message' }, revocations: { revocations: [] } },
        reputation: quiet, now: NOW,
    });
    assert.equal(r.status, 'critical');
    assert.deepEqual(codes(r).sort(), ['NAME_INVALID', 'NOT_PUBLISHED']);
    assert.match(r.alerts[0].message, /revoked/);
});

test('a grant recorded after the revocation puts the ledger back in agreement with a held name', () => {
    const revoked = { revocations: { revocations: [{ label: 'agent', sequenceNumber: 11, consensusTimestamp: '1789232596.601623794', revokedAt: '2026-09-12T20:23:16.601Z' }] } };
    const regranted = { nameGrants: { nameGrants: [{ label: 'agent', sequenceNumber: 12, consensusTimestamp: '1789232700.000000000', grantedAt: '2026-09-12T20:25:00.000Z' }] } };
    const run = (ledger, authority) => codes(deriveHealth({
        terms, reservesNow: { a: shipped.a, b: shipped.b }, reservesAtShip: shipped, trades: [], authority, ledger, reputation: quiet, now: NOW,
    }));
    assert.deepEqual(run({ ...ledgerOk, ...revoked, ...regranted }, held), [], 'the newest record is a grant and the chain says held');
    assert.deepEqual(run({ ...ledgerOk, ...revoked }, held), ['LEDGER_DISAGREES'], 'without the grant record the revocation is still the last word');

    // The other direction: a grant recorded, then revoked on chain without a note.
    const gone = { valid: false, revoked: true, expiry: NOW - 10, reason: 'revoked' };
    const r = deriveHealth({
        terms, reservesNow: { a: shipped.a, b: shipped.b }, reservesAtShip: shipped, trades: [], authority: gone,
        ledger: { ...ledgerOk, ...regranted }, reputation: quiet, now: NOW,
    });
    assert.deepEqual(codes(r).sort(), ['LEDGER_DISAGREES', 'NAME_INVALID']);
    assert.match(r.alerts.find((a) => a.code === 'LEDGER_DISAGREES').message, /grant \(#12\).*revoked/);
    assert.equal(r.alerts.find((a) => a.code === 'LEDGER_DISAGREES').since, '2026-09-12T20:25:00.000Z');

    // A name that merely lapsed is not a disagreement with the grant that said when it would.
    assert.deepEqual(run({ ...ledgerOk, ...regranted }, { valid: false, revoked: false, expiry: NOW - 10, reason: 'expired' }), ['NAME_INVALID']);
    // A revocation newer than the grant while the chain says revoked: the two agree.
    const revokedAgain = { revocations: { revocations: [{ label: 'agent', sequenceNumber: 13, consensusTimestamp: '1789232800.000000000', revokedAt: '2026-09-12T20:26:40.000Z' }] } };
    assert.deepEqual(run({ ...ledgerOk, ...regranted, ...revokedAgain }, gone), ['NAME_INVALID']);
});
