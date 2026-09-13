// Batas's SwapVM decoder and encoder, checked against 1inch's official SDK (@1inch/swap-vm-sdk 0.4.4)
// and the live position on Sepolia.
//
// encoder-parity.test.mjs already holds swapvm.mjs to MandateLib in Solidity, but both of those are
// Batas's code. This test holds them to a third party's. Every divergence the SDK shows is asserted
// with its exact bytes, not loosened away, because the point is to know where it disagrees:
//
//   1. Opcode numbering. The SDK's instruction tables are dense arrays (deadline at 13, xycSwapXD at
//      17, salt at 20, flatFeeAmountInXD at 21). The @1inch/swap-vm source BatasRouter compiles
//      against numbers them in family banks (OpcodeList.sol: 0x20, 0x50, 0x02, 0x70). The SDK's
//      stock AquaProgramBuilder cannot read the live program at all.
//   2. FeeFlatIn width and base. FeeFlat.sol is `[uint24 feeBps]` on a 1e7 base; the SDK's
//      FlatFeeArgs is a uint32 on a 1e9 base. The same 0.3% fee is `7003007530` on chain and
//      `1504002dc6c0` from the SDK's strategy builder.
//   3. Order data. MakerTraitsLib.build in Solidity prefixes `data` with tokenA ++ tokenB and starts
//      the hook offsets at 40; the SDK's MakerTraits.encode has no prefix and starts at 0. The SDK
//      extracts the live program correctly but re-encodes the order as a different strategy.
//
// Where the SDK does define an instruction at the right slot (Deadline, XYCSwap, Salt), its bytes
// and decoded arguments match swapvm.mjs exactly.
//
// All chain access here is read-only: event logs and two eth_call views.

import test, { before } from 'node:test';
import assert from 'node:assert/strict';

import { createPublicClient, http, keccak256, decodeAbiParameters, encodeAbiParameters, encodeFunctionData, decodeFunctionResult, concat, pad, toHex } from 'viem';
import { sepolia } from 'viem/chains';

import { latestProgramOnChain, programFromStrategy } from './position.mjs';
import { decodeProgram, readMandate, toProgram, MAX_ENCODABLE_EXPIRY } from './swapvm.mjs';
import { ROUTER, OWNER, ENS_REGISTRY, TOKENS, SEPOLIA_RPC } from './deployment.mjs';
import { sdk, SLOT, opaque, bankedSet, officialDecode } from './sdk-parity.mjs';

const { controls, xycSwap, fee } = sdk.instructions;

// The SDK's own opcodes and coders, at the slots the router's Solidity gives them.
const SDK_AT_SOLIDITY_SLOTS = [
    [controls.salt, SLOT.Salt],
    [controls.deadline, SLOT.Deadline],
    [xycSwap.xycSwapXD, SLOT.XYCSwap],
    [fee.flatFeeAmountInXD, SLOT.FeeFlatIn],
];
const sdkOnly = bankedSet(SDK_AT_SOLIDITY_SLOTS);

// The same, plus Batas's two instructions registered through the SDK's extension point, and the fee
// carried as raw bytes because the SDK's fee coder cannot read the on-chain width (finding 2, which
// has its own test below). Everything else still goes through the SDK's own coders.
const ENVELOPE = opaque('Batas.PolicyEnvelope');
const NAME = opaque('Batas.MandateName');
const FEE_RAW = opaque('FeeFlatIn.raw');
const withBatas = bankedSet([
    [controls.salt, SLOT.Salt],
    [controls.deadline, SLOT.Deadline],
    [xycSwap.xycSwapXD, SLOT.XYCSwap],
    [FEE_RAW, SLOT.FeeFlatIn],
    [ENVELOPE, SLOT.PolicyEnvelope],
    [NAME, SLOT.MandateName],
]);

const segment = (set, op, args) => new sdk.ProgramBuilder(set).add(op.createIx(args)).build().toString().slice(2);

let live;
before(async () => {
    const found = await latestProgramOnChain();
    assert.ok(found, 'a mandate is live on the router');
    live = { ...found, program: programFromStrategy(found.strategy) };
});

test('the slot table this test uses is the one swapvm.mjs uses', () => {
    // Parsed from OpcodeList.sol and the two Batas .sol files, so a disagreement here is swapvm.mjs's
    // hand copy drifting from the Solidity, not two copies of the same guess.
    assert.deepEqual(
        [SLOT.Salt, SLOT.Deadline, SLOT.PolicyEnvelope, SLOT.MandateName, SLOT.XYCSwap, SLOT.FeeFlatIn],
        [0x02, 0x20, 0x21, 0x22, 0x50, 0x70],
    );
});

test('the SDK reads the live order and finds the same program programFromStrategy does', () => {
    const order = sdk.Order.decode(new sdk.HexString(live.strategy));
    assert.equal(order.program.toString(), live.program);
    assert.equal(order.traits.useAquaInsteadOfSignature, true);
    assert.equal(order.maker.toString().toLowerCase(), OWNER.toLowerCase());
});

test('finding 1: the SDK stock Aqua table numbers opcodes densely and cannot read the live program', () => {
    const aqua = sdk.instructions.aquaInstructions;
    assert.deepEqual(
        [aqua.indexOf(controls.deadline), aqua.indexOf(xycSwap.xycSwapXD), aqua.indexOf(controls.salt), aqua.indexOf(fee.flatFeeAmountInXD)],
        [13, 17, 20, 21],
        'SDK 0.4.4 AquaProgramBuilder slots',
    );

    // Read with that table, the live stream fails on its second instruction: 0x20 is index 32,
    // `extruction`, which wants a 20-byte address and finds Deadline's five bytes.
    assert.throws(() => sdk.AquaProgramBuilder.decode(new sdk.SwapVmProgram(live.program)), /Can not consume 20 bytes, have only 5/);

    // The first one is worse, because it does not fail. 0x21 is index 33,
    // onlyTxOriginTokenBalanceNonZero, and the SDK reads the envelope's first 20 bytes as a token
    // address and drops the other 13 without a word.
    const envelope = live.program.slice(0, 2 + 35 * 2);
    const [misread] = sdk.AquaProgramBuilder.decode(new sdk.SwapVmProgram(envelope)).getInstructions();
    assert.equal(misread.opcode, controls.onlyTxOriginTokenBalanceNonZero);
    assert.equal(misread.args.token.toString().toLowerCase(), `0x${live.program.slice(6, 46)}`);
});

test('the SDK does not know 0x21 or 0x22: at its own filler it drops them silently', () => {
    // Envelope, Deadline and MandateName: the part of the live program before the fee.
    const head = `0x${live.program.slice(2, 2 + 90 * 2)}`;
    const rows = officialDecode(head, sdkOnly);

    assert.deepEqual(rows.map((r) => r.id), ['empty', 'Controls.deadline', 'empty']);
    // Rebuilt, both Batas instructions come back as `00 00` with their 33 and 46 argument bytes gone;
    // only Deadline survives intact. A reader relying on the SDK alone would not see the cap, the
    // floor, the direction or the kill switch.
    const rebuilt = new sdk.ProgramBuilder(sdkOnly).decode(new sdk.SwapVmProgram(head)).build().toString();
    assert.equal(rebuilt, `0x0000${head.slice(2 + 35 * 2, 2 + 42 * 2)}0000`);
    assert.ok(head.slice(2 + 35 * 2).startsWith('2005'), 'the surviving middle is the Deadline instruction');
});

test('finding 2: the SDK fee coder cannot read the on-chain FeeFlatIn, and writes a different one', () => {
    const [feeIns] = decodeProgram(live.program).filter((i) => i.opcode === SLOT.FeeFlatIn);
    assert.equal(feeIns.args.length, 6, 'FeeFlat.sol: [uint24 feeBps]');

    assert.throws(
        () => officialDecode(`0x${SLOT.FeeFlatIn.toString(16)}03${feeIns.args}`, sdkOnly),
        /Can not consume 4 bytes, have only 3/,
    );

    // The same number through each encoder. The SDK's base is 1e9, the contract's 1e7, so even with
    // the width fixed the value would mean a hundredth of the fee.
    const feeBps = Number(BigInt(`0x${feeIns.args}`));
    assert.equal(segment(sdkOnly, fee.flatFeeAmountInXD, new fee.FlatFeeArgs(BigInt(feeBps))), `7004${feeBps.toString(16).padStart(8, '0')}`);
    assert.equal(`${SLOT.FeeFlatIn.toString(16)}03${feeIns.args}`, `7003${feeBps.toString(16).padStart(6, '0')}`);
});

test('every instruction in the live program sits where decodeProgram puts it, with the same arguments', () => {
    const ours = decodeProgram(live.program);
    const theirs = officialDecode(live.program, withBatas);

    assert.equal(theirs.length, ours.length);
    for (let i = 0; i < ours.length; i++) {
        assert.equal(theirs[i].offset, ours[i].offset, `instruction ${i} offset`);
        assert.equal(theirs[i].opcode, ours[i].opcode, `instruction ${i} opcode`);
        assert.equal(theirs[i].args, ours[i].args, `instruction ${i} args`);
    }

    // Offsets are compared above; they move with the kill-switch label, so they are not pinned here.
    assert.deepEqual(
        theirs.map((r) => `0x${r.opcode.toString(16)}:${r.id}`),
        ['0x21:Batas.PolicyEnvelope', '0x20:Controls.deadline', '0x22:Batas.MandateName', '0x70:FeeFlatIn.raw', '0x50:XYCSwap.xycSwapXD', '0x2:Controls.salt'],
    );

    // The arguments the SDK actually interprets, against readMandate's reading of the same bytes.
    const terms = readMandate(ours);
    const by = Object.fromEntries(theirs.map((r) => [r.id, r.decoded]));
    assert.equal(by['Controls.deadline'].deadline, BigInt(terms.expiry));
    assert.equal(by['Controls.salt'].salt.toString(), terms.salt);
    assert.deepEqual(by['XYCSwap.xycSwapXD'].toJSON(), {});

    // And the SDK's builder writes the stream back byte for byte.
    assert.equal(new sdk.ProgramBuilder(withBatas).decode(new sdk.SwapVmProgram(live.program)).build().toString(), live.program);
});

// toProgram always emits PolicyEnvelope, Deadline, FeeFlatIn, XYCSwap and Salt: the envelope and the
// deadline are mandatory terms, and explain() flags a program without them. So the shapes vary what
// can vary: the fee from nothing to just under the whole input, the deadline from zero to the widest
// a uint40 carries, the salt across uint64, and the kill switch present or absent.
const SHAPES = [
    { label: 'zero fee, zero deadline, zero salt, no kill switch', feeBps: 0n, expiry: 0, salt: 0n },
    { label: 'the live terms with a kill switch', feeBps: 30_000n, expiry: 1_784_480_886, salt: 1_789_254_711n, nameRegistry: ENS_REGISTRY, nameHolder: OWNER, nameLabel: 'agent' },
    { label: 'widest fee, widest deadline, widest salt', feeBps: 9_999_999n, expiry: MAX_ENCODABLE_EXPIRY, salt: 2n ** 64n - 1n },
];

for (const shape of SHAPES) {
    test(`builders agree on the standard instructions: ${shape.label}`, () => {
        const body = toProgram({
            maxAmountIn: 10n ** 21n, minRateE18: 10n ** 17n, tokenIn: TOKENS[0], tokenOut: TOKENS[1], ...shape,
        }).slice(2);

        const deadlineSeg = segment(sdkOnly, controls.deadline, new controls.DeadlineArgs(BigInt(shape.expiry)));
        const xycSeg = segment(sdkOnly, xycSwap.xycSwapXD, new xycSwap.XycSwapXDArgs());
        const saltSeg = segment(sdkOnly, controls.salt, new controls.SaltArgs(shape.salt));

        // Byte-identical where the SDK has the instruction: Deadline right after the 35-byte
        // envelope, XYCSwap and Salt closing the program.
        assert.equal(body.slice(70, 70 + deadlineSeg.length), deadlineSeg);
        assert.ok(body.endsWith(xycSeg + saltSeg), `${body} should end with ${xycSeg}${saltSeg}`);

        // Finding 2 again, for this shape: the fee between them is three bytes, the SDK's is four.
        const ourFee = body.slice(body.length - (xycSeg + saltSeg).length - 10, body.length - (xycSeg + saltSeg).length);
        const sdkFee = segment(sdkOnly, fee.flatFeeAmountInXD, new fee.FlatFeeArgs(shape.feeBps));
        assert.equal(ourFee, `7003${shape.feeBps.toString(16).padStart(6, '0')}`);
        assert.equal(sdkFee, `7004${shape.feeBps.toString(16).padStart(8, '0')}`);

        // Finding 1 again: the SDK's recommended AquaProgramBuilder writes the same three instructions
        // under its dense numbering.
        const stock = new sdk.AquaProgramBuilder()
            .deadline({ deadline: BigInt(shape.expiry) })
            .xycSwapXD()
            .salt({ salt: shape.salt })
            .build().toString().slice(2);
        assert.equal(stock, `0d05${deadlineSeg.slice(4)}1100${`14${saltSeg.slice(2)}`}`);
        assert.notEqual(stock, deadlineSeg + xycSeg + saltSeg);
    });
}

test('an SDK-built program without envelope or deadline decodes the same in both decoders', () => {
    // The shapes toProgram will not produce, built on the SDK side instead.
    const program = new sdk.ProgramBuilder(sdkOnly)
        .add(xycSwap.xycSwapXD.createIx(new xycSwap.XycSwapXDArgs()))
        .add(controls.salt.createIx(new controls.SaltArgs(42n)))
        .build().toString();
    assert.deepEqual(
        officialDecode(program, sdkOnly).map(({ offset, opcode, args }) => ({ offset, opcode, args })),
        decodeProgram(program).map(({ offset, opcode, args }) => ({ offset, opcode, args })),
    );
    assert.equal(readMandate(decodeProgram(program)).maxAmountIn, null);
});

test('the SDK strategy builder writes the live 0.3% fee as different bytes', () => {
    // AquaXYCAmmStrategy is the SDK's ready-made strategy for this curve. 30 bps there is 3,000,000
    // on a 1e9 base; 30,000 on a 1e7 base here. Same fee, no byte in common beyond the salt value.
    const terms = readMandate(decodeProgram(live.program));
    assert.equal(terms.feeBps, 30_000, 'the live mandate charges 0.3%');
    const salt = BigInt(terms.salt);
    const salt8 = pad(toHex(salt), { size: 8 }).slice(2);
    const strategy = sdk.AquaXYCAmmStrategy.new().withFeeTokenIn(30).withSalt(salt).build().toString();
    assert.equal(strategy, `0x1504002dc6c011001408${salt8}`);
    assert.ok(live.program.endsWith(`700300753050000208${salt8}`));
});

test('finding 3: the SDK hashes Aqua orders the way Aqua does, but re-encodes this order as a different one', async () => {
    const [raw] = decodeAbiParameters([sdk.Order.ABI], live.strategy);

    // The SDK's Aqua-mode rule, keccak256 of the ABI-encoded order, applied to the order as shipped,
    // reproduces the strategy hash Aqua recorded.
    assert.equal(encodeAbiParameters([sdk.Order.ABI], [raw]), live.strategy);
    assert.equal(keccak256(encodeAbiParameters([sdk.Order.ABI], [raw])), live.strategyHash);

    // Round-tripped through the SDK's Order, it is not the same order.
    const order = sdk.Order.decode(new sdk.HexString(live.strategy));
    const built = order.build();
    assert.equal(raw.traits, (1n << 254n) | (0x0028002800280028n << 160n), 'as shipped: Aqua flag, data slices at 40');
    assert.equal(raw.data, concat([TOKENS[0], TOKENS[1], live.program]).toLowerCase());
    assert.equal(built.traits, 1n << 254n, 'SDK: Aqua flag, slice offsets zeroed');
    assert.equal(built.data, live.program, 'SDK: the 40-byte token prefix is gone');
    assert.notEqual(order.hash().toString(), live.strategyHash);

    // The router is the arbiter, asked through a view: it agrees with the SDK about both orders, so
    // the difference is in the order the SDK produces, not in how either side hashes.
    const client = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) });
    const hashOf = async (data) => decodeFunctionResult({
        abi: sdk.ABI.SWAP_VM_ABI, functionName: 'hash', data: (await client.call({ to: ROUTER, data })).data,
    });
    assert.equal(await hashOf(encodeFunctionData({ abi: sdk.ABI.SWAP_VM_ABI, functionName: 'hash', args: [raw] })), live.strategyHash);
    assert.equal(await hashOf(sdk.SwapVMContract.encodeHashOrderCallData(order).toString()), order.hash().toString());
});
