// Register the Batas agent in the canonical ERC-8004 Identity Registry.
//
//   node agent/identity.mjs             build the registration and show what would be sent
//   node agent/identity.mjs --register  mint the identity on Sepolia
//   node agent/identity.mjs --read 123  read an existing agent's registration back
//   node agent/identity.mjs --update 123  bring an existing identity up to date in place
//
// ERC-8004 gives an autonomous agent an identity other software can look up: an ERC-721 whose
// token URI resolves to a registration file describing what the agent is and where to reach it.
// The registry lives at the same address on Sepolia and Hedera testnet, which happen to be the two
// chains this project runs on.
//
// The registration is stored as a data: URI rather than a hosted link. A hosted file is a promise
// that some server stays up; the point of an identity registry is that the answer survives.

import { createPublicClient, createWalletClient, http, getAddress, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import 'dotenv/config';

import { AQUA, ROUTER, APP, IDENTITY_REGISTRY, HCS_TOPIC, ENS_REGISTRY, SEPOLIA_RPC } from './deployment.mjs';

const REGISTRY_ABI = [
    {
        name: 'register', type: 'function', stateMutability: 'nonpayable',
        inputs: [
            { name: 'agentURI', type: 'string' },
            {
                name: 'metadata', type: 'tuple[]',
                components: [{ name: 'metadataKey', type: 'string' }, { name: 'metadataValue', type: 'bytes' }],
            },
        ],
        outputs: [{ type: 'uint256' }],
    },
    {
        name: 'tokenURI', type: 'function', stateMutability: 'view',
        inputs: [{ name: 'tokenId', type: 'uint256' }],
        outputs: [{ type: 'string' }],
    },
    {
        name: 'ownerOf', type: 'function', stateMutability: 'view',
        inputs: [{ name: 'tokenId', type: 'uint256' }],
        outputs: [{ type: 'address' }],
    },
    // The identity is meant to be kept current rather than re-minted. A second registration would
    // leave the first one standing, describing the same agent wrongly, with nothing to say which
    // of the two a reader should believe.
    {
        name: 'setAgentURI', type: 'function', stateMutability: 'nonpayable',
        inputs: [{ name: 'agentId', type: 'uint256' }, { name: 'newURI', type: 'string' }],
        outputs: [],
    },
    {
        name: 'setMetadata', type: 'function', stateMutability: 'nonpayable',
        inputs: [
            { name: 'agentId', type: 'uint256' },
            { name: 'metadataKey', type: 'string' },
            { name: 'metadataValue', type: 'bytes' },
        ],
        outputs: [],
    },
    {
        name: 'getMetadata', type: 'function', stateMutability: 'view',
        inputs: [{ name: 'agentId', type: 'uint256' }, { name: 'metadataKey', type: 'string' }],
        outputs: [{ type: 'bytes' }],
    },
];


const MIRROR_TOPIC = `https://testnet.mirrornode.hedera.com/api/v1/topics/${HCS_TOPIC}/messages`;

/**
 * The registration file. Everything in here is checkable: the addresses hold code on Sepolia and
 * the source is public, so a reader never has to take a claim on faith. Nothing is listed that
 * cannot be verified — in particular no endpoint is advertised that this repo does not actually
 * serve, because an identity registry full of dead links is worse than an empty one.
 */
function registrationFile(operator) {
    return {
        type: 'https://eips.ethereum.org/EIPS/eip-8004',
        name: 'Batas',
        description:
            'An autonomous market maker on 1inch Aqua that cannot exceed the mandate it was granted. '
            + 'It reads the live position, derives a floor price from the observed spot, compiles a SwapVM '
            + 'program, and ships it. PolicyEnvelope enforces the size cap and floor inside the VM, so the '
            + 'limits hold no matter which caller reaches the position.',
        services: [
            { name: 'source', endpoint: 'https://github.com/PugarHuda/batas', version: '1' },
            // Live and paid for per call. Listed because it answers, not because it is planned.
            { name: 'x402', endpoint: 'https://batas-one.vercel.app/v1/mandate/explain', version: '2' },
            // Where the mandates this agent grants are published. Listed so a reader who trusts
            // neither this repository nor the paid endpoint can still check a grant: the mirror
            // node is public, unauthenticated, and not ours.
            { name: 'mandates', endpoint: MIRROR_TOPIC, version: '1' },
        ],
        operator,
        registrations: [{ agentAddress: operator, chainId: sepolia.id }],
    };
}

/** Metadata entries are the on-chain facts, kept queryable without fetching the URI at all. */
function metadataEntries() {
    const utf8 = (v) => toHex(new TextEncoder().encode(v));
    return [
        { metadataKey: 'batas.chain', metadataValue: utf8(`eip155:${sepolia.id}`) },
        { metadataKey: 'batas.router', metadataValue: utf8(ROUTER) },
        { metadataKey: 'batas.app', metadataValue: utf8(APP) },
        { metadataKey: 'batas.aqua', metadataValue: utf8(AQUA) },
        { metadataKey: 'batas.enforcement', metadataValue: utf8('swapvm-opcode:0x21,0x22') },
        { metadataKey: 'batas.x402.network', metadataValue: utf8('hedera:testnet') },
        { metadataKey: 'batas.x402.payTo', metadataValue: utf8(process.env.HEDERA_SERVICE_ID || '0.0.10388560') },
        { metadataKey: 'batas.hcs.topic', metadataValue: utf8(HCS_TOPIC) },
        // The kill switch, so that revocation is discoverable from the identity rather than only
        // from this repository.
        { metadataKey: 'batas.ens.registry', metadataValue: utf8(ENS_REGISTRY) },
    ].filter((m) => m.metadataValue !== '0x');
}

const toDataUri = (obj) =>
    `data:application/json;base64,${Buffer.from(JSON.stringify(obj)).toString('base64')}`;

async function main() {
    const key = process.env.SEPOLIA_PRIVATE_KEY;
    if (!key) throw new Error('SEPOLIA_PRIVATE_KEY missing; copy .env.example to .env');

    const account = privateKeyToAccount(key);
    const transport = http(SEPOLIA_RPC);
    const pub = createPublicClient({ chain: sepolia, transport });

    const readIdx = process.argv.indexOf('--read');
    if (readIdx !== -1) {
        const tokenId = BigInt(process.argv[readIdx + 1]);
        const [uri, owner] = await Promise.all([
            pub.readContract({ address: IDENTITY_REGISTRY, abi: REGISTRY_ABI, functionName: 'tokenURI', args: [tokenId] }),
            pub.readContract({ address: IDENTITY_REGISTRY, abi: REGISTRY_ABI, functionName: 'ownerOf', args: [tokenId] }),
        ]);
        console.log(`agent    #${tokenId}`);
        console.log(`owner    ${owner}`);
        const json = uri.startsWith('data:')
            ? JSON.parse(Buffer.from(uri.split(',')[1], 'base64').toString())
            : { hostedAt: uri };
        console.log(JSON.stringify(json, null, 2));
        return;
    }

    const file = registrationFile(account.address);
    const agentURI = toDataUri(file);
    const metadata = metadataEntries();

    // Bring an existing identity up to date rather than minting a second one. Only what actually
    // differs is written: the registry charges for every word, and a transaction that changes
    // nothing is noise in the history of an agent people are meant to be able to audit.
    const updateIdx = process.argv.indexOf('--update');
    if (updateIdx !== -1) {
        const agentId = BigInt(process.argv[updateIdx + 1]);
        const owner = await pub.readContract({
            address: IDENTITY_REGISTRY, abi: REGISTRY_ABI, functionName: 'ownerOf', args: [agentId],
        });
        if (owner.toLowerCase() !== account.address.toLowerCase()) {
            throw new Error(`agent #${agentId} is held by ${owner}, not by this key`);
        }

        const currentURI = await pub.readContract({
            address: IDENTITY_REGISTRY, abi: REGISTRY_ABI, functionName: 'tokenURI', args: [agentId],
        });
        const stale = [];
        for (const m of metadata) {
            const onChain = await pub.readContract({
                address: IDENTITY_REGISTRY, abi: REGISTRY_ABI, functionName: 'getMetadata',
                args: [agentId, m.metadataKey],
            });
            if (onChain.toLowerCase() !== m.metadataValue.toLowerCase()) stale.push(m);
        }

        const uriChanged = currentURI !== agentURI;
        console.log(`\nagent #${agentId}`);
        console.log(`  uri       ${uriChanged ? 'differs, will be replaced' : 'already current'}`);
        console.log(`  metadata  ${stale.length === 0 ? 'all current' : `${stale.length} to write`}`);
        for (const m of stale) console.log(`    ${m.metadataKey}`);

        if (!uriChanged && stale.length === 0) return;
        if (!process.argv.includes('--write')) {
            console.log('\nrun again with --write to send it');
            return;
        }

        const wallet = createWalletClient({ account, chain: sepolia, transport });
        if (uriChanged) {
            const hash = await wallet.writeContract({
                address: IDENTITY_REGISTRY, abi: REGISTRY_ABI, functionName: 'setAgentURI',
                args: [agentId, agentURI],
            });
            await pub.waitForTransactionReceipt({ hash });
            console.log(`\nuri      ${hash}`);
        }
        for (const m of stale) {
            const hash = await wallet.writeContract({
                address: IDENTITY_REGISTRY, abi: REGISTRY_ABI, functionName: 'setMetadata',
                args: [agentId, m.metadataKey, m.metadataValue],
            });
            await pub.waitForTransactionReceipt({ hash });
            console.log(`${m.metadataKey.padEnd(24)} ${hash}`);
        }
        return;
    }

    console.log(`registry ${IDENTITY_REGISTRY}`);
    console.log(`operator ${account.address}`);
    console.log(`uri      ${agentURI.length} chars, self-contained`);
    console.log('metadata');
    for (const m of metadata) console.log(`  ${m.metadataKey}`);

    // Simulate first: the registry tells us the id it would mint, which is also a check that the
    // call is well formed before any gas is spent.
    const { result: predictedId } = await pub.simulateContract({
        account,
        address: IDENTITY_REGISTRY,
        abi: REGISTRY_ABI,
        functionName: 'register',
        args: [agentURI, metadata],
    });
    console.log(`\nwould mint agent #${predictedId}`);

    if (!process.argv.includes('--register')) {
        console.log('run again with --register to mint it');
        return;
    }

    const wallet = createWalletClient({ account, chain: sepolia, transport });
    const hash = await wallet.writeContract({
        address: IDENTITY_REGISTRY, abi: REGISTRY_ABI, functionName: 'register', args: [agentURI, metadata],
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    console.log(`tx       ${hash}`);
    console.log(`status   ${receipt.status}  gas ${receipt.gasUsed}`);
    console.log(`\nhttps://sepolia.etherscan.io/tx/${hash}`);
}

// Only run when invoked directly. Importing this file — a test does, and so could any other
// tool — must not fire off the whole flow as a side effect of loading it.
if (import.meta.filename === process.argv[1]) {
    main().catch((e) => {
        console.error(String(e.shortMessage || e.message || e));
        process.exit(1);
    });
}
