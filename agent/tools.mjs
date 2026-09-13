// The questions, as one table.
//
// mcp.mjs used to hold these inline. Now the same names, descriptions, schemas and handlers are
// read by the MCP server, by the AI SDK adapter, by LangChain's, and by whichever framework comes
// next — and a description is the interface the model picks a tool by, so there is exactly one
// copy of each to keep honest.
//
// `shape` is a zod raw shape (a plain object of zod fields) rather than a `z.object`, because
// MCP's `registerTool` and the Claude Agent SDK both want it that way and wrapping is one line for
// everyone else. `run` returns plain JSON and throws on failure; each adapter decides how its
// framework wants an error told.

import { z } from 'zod';

import {
    decodeAnswer, publicationAnswer, authorityAnswer, nameAnswer, paymentsAnswer, resolveProgram, PAYMENTS_DEFAULT, PAYMENTS_MAX,
} from './free.mjs';
import { AGENT_ID, ENS_NAME, ENS_PARENT_LABEL, HCS_TOPIC } from './deployment.mjs';

// Unannotated, a tool is presumed destructive and non-idempotent by clients that honour hints —
// the spec's defaults — so a free read looked like a write until this was said.
const FREE = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export const TOOLS = {
    read_mandate: {
        title: 'Read a mandate from its bytes',
        annotations: FREE,
        description:
            'Decode a SwapVM program into the limits it enforces: the size cap, the floor price, the'
            + ' expiry, the fee and the curve. Free — this is arithmetic on bytes you already hold.'
            + ' Reports whether PolicyEnvelope is in the outermost position, which is what makes the'
            + ' limits binding rather than advisory. Omit `program` to read the live Sepolia position.',
        shape: { program: z.string().optional().describe('0x SwapVM instruction stream') },
        run: ({ program }) => decodeAnswer(program),
    },

    check_publication: {
        title: 'Check when a mandate was published',
        annotations: FREE,
        description:
            'Ask Hedera Consensus Service when these exact bytes were first published, and by whom.'
            + ' Free, and read from a public mirror node rather than from us. A program that decodes'
            + ' cleanly but has no record is a set of terms someone handed you a minute ago, which is'
            + ' a different thing from a grant that has been standing. The match is on the whole'
            + ' program: a mandate differing by one byte is a different grant.',
        shape: { program: z.string().optional().describe('0x SwapVM instruction stream') },
        run: ({ program }) => publicationAnswer(program),
    },

    check_agent_authority: {
        title: 'Check whether the agent is still authorised',
        annotations: FREE,
        description:
            'Read the ENSv2 mandate name that gates the agent. Free. Returns whether the name is held'
            + ' and unexpired, and if not, whether it lapsed or was revoked ahead of its term — the'
            + ' owner can end the agent\'s authority at any moment without touching the position.',
        shape: {
            label: z.string().optional().describe('mandate name label, default "agent"'),
            grantedUntil: z.number().optional()
                .describe('the mandate\'s own deadline, unix seconds; supply it to tell revocation from lapse'),
        },
        run: ({ label, grantedUntil }) => authorityAnswer({ label, grantedUntil }),
    },

    resolve_agent_name: {
        title: 'Resolve the agent\'s ENS name',
        annotations: FREE,
        description:
            `Resolve ${ENS_NAME}, or another name under ${ENS_PARENT_LABEL}.eth, through the ENS UniversalResolver on Sepolia:`
            + ' its resolver, address and ENSIP-26 agent records, including the web, MCP and x402 endpoints.'
            + ' Free — a handful of Sepolia reads, and no payment is asked for or made.'
            + ` It also checks the ENSIP-25 link to ERC-8004 agent #${AGENT_ID} in both directions: \`erc8004.linked\``
            + ' is true only when the name names the identity and the identity names the name back. Names outside'
            + ` ${ENS_PARENT_LABEL}.eth are refused; this is not a general ENS resolver.`,
        shape: { name: z.string().optional().describe(`a name under ${ENS_PARENT_LABEL}.eth, default ${ENS_NAME}`) },
        run: ({ name }) => nameAnswer({ name }),
    },

    check_payment_trail: {
        title: 'Check the x402 payment audit trail',
        annotations: FREE,
        description:
            `Read the batas.payment records on Hedera Consensus Service topic ${HCS_TOPIC} from a public mirror node,`
            + ' each checked against the ledger: the HCS message was paid for by the account the record names as payer,'
            + ' no earlier verified record claimed the same transaction, and the transaction succeeded and moved at least'
            + ' the stated HBAR from payer to payee. Free — mirror node reads only; nothing is paid, and reading the trail'
            + ' adds nothing to it. A record that fails is listed with `verified: false` and its reason rather than'
            + ' dropped, and `verified: null` means the mirror node could not answer. Returns the newest `limit` records'
            + ` (default ${PAYMENTS_DEFAULT}, at most ${PAYMENTS_MAX}), oldest first, with \`total\` and \`verifiedCount\` for the whole trail.`,
        shape: {
            payer: z.string().optional().describe('a Hedera account id, shard.realm.num; only the records that account published'),
            limit: z.number().int().min(1).max(PAYMENTS_MAX).optional()
                .describe(`how many of the newest records to return, 1 to ${PAYMENTS_MAX}; default ${PAYMENTS_DEFAULT}`),
        },
        run: ({ payer, limit }) => paymentsAnswer({ payer, limit }),
    },

    inspect_mandate_paid: {
        title: 'Buy a full mandate inspection',
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        description:
            'Settle a metered price (0.001 HBAR for a live mandate alone, at most 0.0037 HBAR) on Hedera testnet and get the complete answer from the live service:'
            + ' the decoded limits, the publication record, and the ERC-8004 identity behind the'
            + ' position with a check that it is held by the address that granted the mandate.'
            + ' THIS SPENDS MONEY — one payment per call, capped at 0.01 HBAR by the client. Prefer'
            + ' the free tools first and reach for this when the operator behind a position matters.',
        shape: { program: z.string().optional().describe('0x SwapVM instruction stream') },
        run: async ({ program }) => {
            const { program: p, source } = await resolveProgram(program);
            // The payment client is loaded on the first paid call, not when the table is.
            const { payForExplanation } = await import('./inspect.mjs');
            // Silent logger: any narration would land in the caller's protocol stream.
            const { body, settlement } = await payForExplanation(p, { log: () => {} });
            return { source, paid: true, settlement, ...body };
        },
    },
};
