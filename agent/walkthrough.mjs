// Everything, in one command.
//
//   node agent/walkthrough.mjs           free: what anyone can verify without us
//   node agent/walkthrough.mjs --paid    and then settle 0.001 HBAR for the rest
//
// The order matters more than the output. Steps 1 to 5 read public chains and a public mirror node;
// none of them route through this project's service, and none of them cost anything. Only step 6
// does, and it is worth stating plainly what the payment buys: not the limits, which are arithmetic
// on bytes anyone holds, but one answer assembled across three networks that a stranger would
// otherwise have to gather themselves.
//
// No logic lives here. It composes the same functions the agent, the service and the tests use, so
// a walkthrough that passes is evidence about the system rather than about itself.

import { getAddress, createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import 'dotenv/config';

import { explain } from './swapvm.mjs';
import { lookupMandate } from './hcs.mjs';
import { mandateNameStatus } from './ens.mjs';
import { resolveAgent, vouchesFor } from './erc8004.mjs';
import { latestProgramOnChain, programFromStrategy, payForExplanation } from './inspect.mjs';
import { OWNER, ENS_REGISTRY, MANDATE_NAME, AGENT_ID, HCS_TOPIC } from './deployment.mjs';

const step = (n, title) => console.log(`\n${n}. ${title}\n${'─'.repeat(60)}`);
const line = (k, v) => console.log(`   ${k.padEnd(12)} ${v}`);

async function main() {
    const owner = OWNER;

    step(1, 'The position, read off Sepolia');
    const found = await latestProgramOnChain();
    if (!found) throw new Error('no mandate shipped to this router yet; run script/Demo.s.sol first');
    const program = programFromStrategy(found.strategy);
    line('mandate', found.strategyHash);
    line('program', `${program.slice(0, 42)}… (${(program.length - 2) / 2} bytes)`);
    line('verify', `https://sepolia.etherscan.io/address/${owner}`);

    step(2, 'What those bytes permit — arithmetic, free, reproducible');
    const answer = explain(program);
    const m = answer.mandate;
    line('guarded', `${answer.guarded}   (PolicyEnvelope outermost, so later instructions run inside it)`);
    line('max input', m.maxAmountInFormatted ?? '—');
    line('floor rate', m.minRateFormatted ?? '—');
    line('fee', m.feePercent === null ? '—' : `${m.feePercent}%`);
    line('expires', m.expiryISO ?? 'never');
    line(
        'kill switch',
        m.killSwitch
            ? `"${m.killSwitch.label}" in ${m.killSwitch.registry}, held by ${m.killSwitch.holder}`
            : 'none — only the expiry and Aqua.dock() end this grant',
    );
    for (const n of answer.notes) console.log(`   note         ${n}`);

    step(3, 'When those exact bytes became public — Hedera, free, not ours');
    const pub = await lookupMandate(HCS_TOPIC, program);
    if (pub.published) {
        line('published', pub.publishedAt);
        line('consensus', `topic ${pub.topic} #${pub.sequenceNumber}`);
        line('verify', pub.mirror);
    } else {
        line('published', `no — ${pub.reason}`);
    }

    step(4, 'Whether the agent may still act — ENSv2, free, the owner\'s switch');
    const registry = ENS_REGISTRY;
    {
        const client = createPublicClient({
            chain: sepolia,
            transport: http(process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com'),
        });
        const status = await mandateNameStatus(
            client, registry, MANDATE_NAME, owner,
            { grantedUntil: m.expiry ?? undefined },
        );
        line('authority', status.valid ? 'live' : (status.revoked ? 'revoked by the owner' : 'ended'));
        line('reason', status.reason);
        if (status.valid) line('remaining', `${Math.floor(status.secondsLeft / 3600)} hours`);
        // The distinction worth drawing here, because it is the one the project got wrong for most
        // of its life: this step used to describe a control the agent chose to obey. With the name
        // compiled into the program it is a control the settlement obeys, and the difference is
        // every caller who is not this agent.
        line(
            'enforced',
            m.killSwitch
                ? 'on chain — the settlement asks the registry, so revocation binds every caller'
                : 'by the agent only — nothing on chain reads this name',
        );
    }

    step(5, 'Who is behind it — ERC-8004');
    const agentId = AGENT_ID;
    {
        const agent = await resolveAgent(agentId);
        line('agent', `#${agent.agentId}  ${agent.registration?.name ?? '(unnamed)'}`);
        line('held by', agent.owner);
        const check = vouchesFor(agent, owner);
        line('vouches', `${check.vouched ? 'yes' : 'no'} — ${check.reason}`);

        // The registry the project used to skip. Identity answers who; this answers whether anyone
        // has traded against them and said so — and the contract refuses to let the agent say it.
        try {
            const { readReputation } = await import('./reputation.mjs');
            const rep = await readReputation(agentId);
            line(
                'reputation',
                rep.count === 0
                    ? 'no client feedback yet (and the agent itself is barred from leaving any)'
                    : `${rep.count} client(s), ${rep.summaryValue}bps above the floor on average`,
            );
        } catch (e) {
            line('reputation', `could not read: ${String(e.shortMessage ?? e.message ?? e)}`);
        }
    }

    if (!process.argv.includes('--paid')) {
        console.log('\nEverything above was free and none of it went through this project\'s service.');
        console.log('Run again with --paid to settle 0.001 HBAR and get the same answer from the');
        console.log('live endpoint, which is the part a stranger cannot compute for themselves.\n');
        return;
    }

    step(6, 'The paid answer — x402 on Hedera, no key and no account');
    const { body, settlement } = await payForExplanation(program, { log: (s) => console.log(`   ${s}`) });
    line('settled', settlement ? 'yes' : 'no payment header returned');
    line('agrees', String(body.mandate.minRateFormatted === m.minRateFormatted));
    if (body.operator?.check) line('vouches', `${body.operator.check.vouched} — ${body.operator.check.reason}`);
    console.log('');
}

if (import.meta.filename === process.argv[1]) {
    main().catch((e) => {
        console.error(String(e.shortMessage || e.message || e));
        process.exit(1);
    });
}
