// The mandate as a name.
//
//   node agent/ens.mjs --deploy            deploy the mandate registry (once)
//   node agent/ens.mjs --grant agent       grant a subname whose expiry matches the live mandate
//   node agent/ens.mjs --read agent        what the name currently authorises
//   node agent/ens.mjs --revoke agent      take it back before it expires
//
// A mandate is authority granted within limits, for a while, revocably, to one holder. ENSv2
// expresses all four as primitives rather than as conventions:
//
//   expiring          `expiry` is a parameter of register(), not a record someone agrees to check
//   revocable         ROLE_UNREGISTER lets the grantor end it early and burn the token
//   non-transferable  withholding ROLE_CAN_TRANSFER_ADMIN makes the name soulbound
//   scoped            the role bitmap says exactly what the holder may change, and nothing more
//
// The expiry written here is the same timestamp compiled into the program's Deadline instruction,
// so the name and the authority it stands for end at the same moment. That is the point: an
// identity that outlives the permission it represents is a lie waiting to be believed.

import { createPublicClient, createWalletClient, http, getAddress, encodeFunctionData, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import 'dotenv/config';

import { decodeProgram, readMandate } from './swapvm.mjs';
import { programFromStrategy } from './inspect.mjs';
import { AQUA, ROUTER } from './deployment.mjs';

// ENSv2 beta on Sepolia. Checked for code before use; these moved once already during the beta.
const VERIFIABLE_FACTORY = getAddress('0x10Dc6333cDfe1FCEF624c6E0A8221b91804cD7ef');
const USER_REGISTRY_IMPL = getAddress('0x624a25D67b59d587752ebEC8DdEd8827dAE52050');
const PERMISSIONED_RESOLVER = getAddress('0x9EAE5c2730a7dd16bDD1dEE6421A1b91e3b0365e');




// From the ENSv2 Permissioned Registry. Roles sit four bits apart; the admin of a role is that
// role shifted left by 128.
export const ROLE = {
    REGISTRAR: 1n << 0n,
    REGISTER_RESERVED: 1n << 4n,
    SET_PARENT: 1n << 8n,
    UNREGISTER: 1n << 12n,
    RENEW: 1n << 16n,
    SET_SUBREGISTRY: 1n << 20n,
    SET_RESOLVER: 1n << 24n,
    SET_URI: 1n << 36n,
};
export const admin = (r) => r << 128n;
// ROLE_CAN_TRANSFER_ADMIN has no regular variant and is checked against the token owner. Granting
// it would make the name transferable; withholding it is what makes the grant stick to one holder.
export const ROLE_CAN_TRANSFER_ADMIN = (1n << 28n) << 128n;

const FACTORY_ABI = [{
    name: 'deployProxy', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'implementation', type: 'address' }, { name: 'salt', type: 'uint256' }, { name: 'data', type: 'bytes' }],
    outputs: [{ type: 'address' }],
}];

const REGISTRY_ABI = [
    {
        name: 'initialize', type: 'function', stateMutability: 'nonpayable',
        inputs: [{ name: 'rootAccount', type: 'address' }, { name: 'roleBitmap', type: 'uint256' }],
        outputs: [],
    },
    {
        name: 'register', type: 'function', stateMutability: 'nonpayable',
        inputs: [
            { name: 'label', type: 'string' }, { name: 'owner', type: 'address' },
            { name: 'registry', type: 'address' }, { name: 'resolver', type: 'address' },
            { name: 'roleBitmap', type: 'uint256' }, { name: 'expiry', type: 'uint64' },
        ],
        outputs: [{ type: 'uint256' }],
    },
    { name: 'unregister', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'anyId', type: 'uint256' }], outputs: [] },
    { name: 'findExpiry', type: 'function', stateMutability: 'view', inputs: [{ name: 'label', type: 'string' }], outputs: [{ type: 'uint64' }] },
    { name: 'getExpiry', type: 'function', stateMutability: 'view', inputs: [{ name: 'anyId', type: 'uint256' }], outputs: [{ type: 'uint64' }] },
    { name: 'roles', type: 'function', stateMutability: 'view', inputs: [{ name: 'anyId', type: 'uint256' }, { name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
    { name: 'hasRoles', type: 'function', stateMutability: 'view', inputs: [{ name: 'anyId', type: 'uint256' }, { name: 'roleBitmap', type: 'uint256' }, { name: 'account', type: 'address' }], outputs: [{ type: 'bool' }] },
    { name: 'ownerOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ type: 'address' }] },
    { name: 'findTokenId', type: 'function', stateMutability: 'view', inputs: [{ name: 'label', type: 'string' }], outputs: [{ type: 'uint256' }] },
];

const AQUA_SHIPPED = {
    type: 'event', name: 'Shipped',
    inputs: [
        { name: 'maker', type: 'address' }, { name: 'app', type: 'address' },
        { name: 'strategyHash', type: 'bytes32' }, { name: 'strategy', type: 'bytes' },
    ],
};

const clients = () => {
    const account = privateKeyToAccount(process.env.SEPOLIA_PRIVATE_KEY);
    const transport = http(process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com');
    return {
        account,
        pub: createPublicClient({ chain: sepolia, transport }),
        wallet: createWalletClient({ account, chain: sepolia, transport }),
    };
};

const registryAddress = () => {
    const a = process.env.BATAS_ENS_REGISTRY;
    if (!a) throw new Error('BATAS_ENS_REGISTRY not set; run --deploy first and put the address in .env');
    return getAddress(a);
};

/**
 * Base id for a label: the labelhash with its low 32 bits cleared.
 *
 * Those bits are a version counter the registry bumps when a name is re-registered, which is how
 * ENSv2 stops a stale approval from carrying over to a name someone re-registered later. Using a
 * plain `keccak256(label)` as the token id looks right and is wrong by exactly those 32 bits —
 * `ownerOf` then answers about a token that does not exist and reports the zero address, which
 * reads as "revoked" rather than as "you asked the wrong question".
 *
 * Prefer `findTokenId` on the registry itself where a call is possible; this is for when it is not.
 */
export const labelId = (label) => BigInt(keccak256(toHex(label))) & ~0xffffffffn;

/** The expiry of the newest mandate this owner shipped, so the name cannot outlive it. */
async function liveMandateExpiry(pub, owner) {
    const head = await pub.getBlockNumber();
    for (let to = head, scanned = 0n; scanned < 60_000n && to > 0n; ) {
        const from = to > 9_000n ? to - 9_000n : 0n;
        const batch = await pub.getLogs({ address: AQUA, event: AQUA_SHIPPED, fromBlock: from, toBlock: to });
        const mine = batch.filter(
            (l) => l.args.maker?.toLowerCase() === owner.toLowerCase()
                && l.args.app?.toLowerCase() === ROUTER.toLowerCase(),
        );
        if (mine.length > 0) {
            const program = programFromStrategy(mine[mine.length - 1].args.strategy);
            const terms = readMandate(decodeProgram(program));
            if (terms.expiry === null) throw new Error('the live mandate carries no expiry to match');
            return { expiry: terms.expiry, terms, strategyHash: mine[mine.length - 1].args.strategyHash };
        }
        scanned += to - from;
        to = from - 1n;
    }
    throw new Error('no mandate found for this owner; run agent/batas-agent.mjs --ship first');
}

/** What the grantor keeps: enough to run the registry and to take a name back. */
export const grantorRootRoles = () =>
    ROLE.REGISTRAR | ROLE.UNREGISTER | ROLE.RENEW | ROLE.SET_RESOLVER
    | admin(ROLE.REGISTRAR) | admin(ROLE.UNREGISTER) | admin(ROLE.RENEW) | admin(ROLE.SET_RESOLVER);

/** What the holder gets: the records it needs, and nothing that lets it escape or erase the grant. */
export const holderRoles = () => ROLE.SET_RESOLVER | ROLE.SET_SUBREGISTRY;

export const isSoulbound = (bitmap) => (bitmap & ROLE_CAN_TRANSFER_ADMIN) === 0n;

/**
 * Whether a mandate name still authorises its holder to act.
 *
 * This is what turns the name from a label into a control. The grantor can end an agent's
 * authority at any moment by calling `unregister`, and the agent is expected to notice: it reads
 * this before it acts, and stops when the answer is no. Expiry does the same thing on a timer
 * without anyone having to be awake for it.
 */
export const ZERO = '0x0000000000000000000000000000000000000000';
const iso = (unix) => new Date(unix * 1000).toISOString();

/**
 * Decide what the registry's answers mean, given nothing but those answers.
 *
 * Split out from the reads because this is where the judgement lives, and judgement that can only
 * be exercised by sending a transaction does not get exercised. The two mistakes it exists to
 * prevent were both silent: treating a burned name as merely expired, and treating a name the
 * owner pulled as one that ran out on its own.
 *
 * `grantedUntil` is the live mandate's deadline. `grant()` sets the name to expire with the
 * mandate, so a name expiring earlier than that was cut short by someone.
 */
export function classifyName({ label, registry, expiry, owner, holder, now, grantedUntil }) {
    if (expiry === 0) {
        return { valid: false, revoked: false, reason: `no mandate name "${label}" in ${registry}`, expiry: 0, secondsLeft: 0 };
    }

    const burned = !owner || owner === ZERO;
    if (burned || expiry <= now) {
        // Revoking sets the expiry to the moment of revocation, so a pulled name and a lapsed one
        // look identical from the timestamp alone. These two signals separate them: an expiry that
        // falls short of the granted term, or a name already burned while its term still runs.
        const revoked = (grantedUntil !== undefined && expiry < Number(grantedUntil)) || (burned && expiry > now);
        return {
            valid: false,
            revoked,
            reason: revoked
                ? `mandate name "${label}" was revoked at ${iso(expiry)}, ahead of its term`
                : `mandate name "${label}" expired at ${iso(expiry)}`,
            expiry,
            secondsLeft: 0,
        };
    }

    if (owner.toLowerCase() !== holder.toLowerCase()) {
        return { valid: false, revoked: false, reason: `mandate name "${label}" is held by ${owner}, not ${holder}`, expiry, secondsLeft: 0 };
    }

    return { valid: true, revoked: false, reason: 'held and unexpired', expiry, secondsLeft: expiry - now, owner };
}

/**
 * Is the agent still authorised, and if not, why not.
 *
 * Reads the registry and hands the answers to `classifyName`. Pass the live mandate's deadline as
 * `grantedUntil` to have a withdrawal reported as one rather than as a lapse.
 */
export async function mandateNameStatus(pub, registry, label, holder, { grantedUntil } = {}) {
    // Ask the registry for the current token id rather than deriving one: it carries a version
    // counter in its low bits that only the registry knows the value of, and `unregister` bumps it.
    const id = await pub.readContract({
        address: registry, abi: REGISTRY_ABI, functionName: 'findTokenId', args: [label],
    });
    const expiry = Number(
        await pub.readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'findExpiry', args: [label] }),
    );

    // This registry answers `ownerOf` for a burned name with the zero address instead of reverting,
    // so a try/catch around it catches nothing. It is checked as a value, which is what it is.
    let owner = ZERO;
    try {
        owner = await pub.readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'ownerOf', args: [id] });
    } catch { /* some registries do revert; that is burned too */ }

    return classifyName({
        label, registry, expiry, owner, holder, now: Math.floor(Date.now() / 1000), grantedUntil,
    });
}

async function deploy() {
    const { account, pub, wallet } = clients();
    for (const [name, addr] of [['factory', VERIFIABLE_FACTORY], ['implementation', USER_REGISTRY_IMPL]]) {
        const code = await pub.getCode({ address: addr });
        if (!code || code === '0x') throw new Error(`${name} has no code at ${addr} on this chain`);
    }

    // The grantor keeps everything needed to run the registry and to take a name back. Nothing
    // here is granted to the agent; that happens per name, in --grant.
    const rootRoles = grantorRootRoles();

    const initData = encodeFunctionData({
        abi: REGISTRY_ABI, functionName: 'initialize', args: [account.address, rootRoles],
    });
    const salt = BigInt(keccak256(toHex('batas.mandate.registry')));

    const { result, request } = await pub.simulateContract({
        account, address: VERIFIABLE_FACTORY, abi: FACTORY_ABI, functionName: 'deployProxy',
        args: [USER_REGISTRY_IMPL, salt, initData],
    });
    console.log(`registry will deploy at ${result}`);

    const hash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    console.log(`tx      ${hash}`);
    console.log(`status  ${receipt.status}  gas ${receipt.gasUsed}`);
    console.log(`\nadd this to .env:\n  BATAS_ENS_REGISTRY=${result}`);
}

async function grant(label) {
    const { account, pub, wallet } = clients();
    const registry = registryAddress();
    const { expiry, terms, strategyHash } = await liveMandateExpiry(pub, account.address);

    console.log(`mandate ${strategyHash}`);
    console.log(`  cap    ${terms.maxAmountIn}`);
    console.log(`  floor  ${terms.minRateE18}`);
    console.log(`  expiry ${new Date(expiry * 1000).toISOString()}`);

    // What the holder may do with the name, and nothing else. ROLE_CAN_TRANSFER_ADMIN is absent,
    // so the grant cannot be sold or handed on; ROLE_UNREGISTER is absent, so the holder cannot
    // destroy the record of it either.
    const roles = holderRoles();
    const agentAddress = getAddress(process.env.BATAS_AGENT_ADDRESS || account.address);

    console.log(`\ngranting "${label}" to ${agentAddress}`);
    console.log(`  roles      SET_RESOLVER | SET_SUBREGISTRY`);
    console.log(`  withheld   CAN_TRANSFER_ADMIN (soulbound), UNREGISTER (grantor keeps it)`);

    const { result: tokenId, request } = await pub.simulateContract({
        account, address: registry, abi: REGISTRY_ABI, functionName: 'register',
        args: [label, agentAddress, '0x0000000000000000000000000000000000000000', PERMISSIONED_RESOLVER, roles, BigInt(expiry)],
    });

    const hash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    console.log(`\ntoken   ${tokenId}`);
    console.log(`tx      ${hash}`);
    console.log(`status  ${receipt.status}  gas ${receipt.gasUsed}`);
}

async function read(label) {
    const { account, pub } = clients();
    const registry = registryAddress();
    const id = await pub.readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'findTokenId', args: [label] });

    const [expiry, holderRoles, grantorRoles] = await Promise.all([
        pub.readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'findExpiry', args: [label] }),
        pub.readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'roles', args: [id, getAddress(process.env.BATAS_AGENT_ADDRESS || account.address)] }),
        pub.readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'roles', args: [id, account.address] }),
    ]);

    const now = Math.floor(Date.now() / 1000);
    console.log(`name       ${label}`);
    console.log(`registry   ${registry}`);
    console.log(`expiry     ${expiry === 0n ? 'not registered' : new Date(Number(expiry) * 1000).toISOString()}`);
    if (expiry !== 0n) {
        const left = Number(expiry) - now;
        console.log(`           ${left > 0 ? `${Math.floor(left / 60)} minutes left` : 'expired; it authorises nothing'}`);
    }
    console.log(`holder     0x${holderRoles.toString(16)}`);
    console.log(`transferable ${(holderRoles & ROLE_CAN_TRANSFER_ADMIN) !== 0n}`);
    console.log(`grantor can revoke ${((grantorRoles & ROLE.UNREGISTER) !== 0n) || 'via root roles'}`);
}

async function revoke(label) {
    const { account, pub, wallet } = clients();
    const registry = registryAddress();
    const id = await pub.readContract({ address: registry, abi: REGISTRY_ABI, functionName: 'findTokenId', args: [label] });

    const { request } = await pub.simulateContract({
        account, address: registry, abi: REGISTRY_ABI, functionName: 'unregister', args: [id],
    });
    const hash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    console.log(`revoked "${label}"`);
    console.log(`tx      ${hash}`);
    console.log(`status  ${receipt.status}`);
}

async function main() {
    if (!process.env.SEPOLIA_PRIVATE_KEY) throw new Error('SEPOLIA_PRIVATE_KEY missing; copy .env.example to .env');

    const argv = process.argv.slice(2);
    const at = (flag) => argv.indexOf(flag);

    if (at('--deploy') !== -1) return deploy();
    if (at('--grant') !== -1) return grant(argv[at('--grant') + 1] || 'agent');
    if (at('--read') !== -1) return read(argv[at('--read') + 1] || 'agent');
    if (at('--revoke') !== -1) return revoke(argv[at('--revoke') + 1] || 'agent');

    console.log('usage: --deploy | --grant <label> | --read <label> | --revoke <label>');
}

if (import.meta.filename === process.argv[1]) {
    main().catch((e) => {
        console.error(String(e.shortMessage || e.message || e));
        process.exit(1);
    });
}
