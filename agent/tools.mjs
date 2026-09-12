// The four questions, as one table.
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

import { decodeAnswer, publicationAnswer, authorityAnswer, resolveProgram } from './free.mjs';

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

    inspect_mandate_paid: {
        title: 'Buy a full mandate inspection',
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        description:
            'Settle 0.001 HBAR on Hedera testnet and get the complete answer from the live service:'
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
