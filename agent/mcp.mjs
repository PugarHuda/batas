// Batas as a tool an assistant can reach for.
//
// The premise of this project is that anyone about to trade against a position, or about to let an
// agent run one, needs to know what its bytes actually permit. Until now the only ways to ask were
// a shell and a curl. MCP is how the software people actually delegate to — Claude, Cursor,
// Windsurf — reaches an outside service, so this exposes the same questions there.
//
//   node agent/mcp.mjs        speaks JSON-RPC over stdin/stdout
//
// Register it with a client, for example in Claude Code:
//
//   claude mcp add batas -- node /path/to/agent/mcp.mjs
//
// Three of the four tools cost nothing and one settles a payment on Hedera. That split is
// deliberate: an assistant can establish whether a mandate was ever published, and whether the
// agent behind it is still authorised, before deciding the full decode is worth 0.001 HBAR. That
// is the shape of the thing the payment is for — not a subscription, a decision.
//
// Nothing here may write to stdout except the protocol. A stray console.log corrupts the stream,
// which is why the paying client takes an injected logger and this file gives it a silent one.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import 'dotenv/config';

import { decodeAnswer, publicationAnswer, authorityAnswer, resolveProgram } from './free.mjs';
import { payForExplanation } from './inspect.mjs';

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

/**
 * A server per connection.
 *
 * A factory rather than a shared instance: the SDK binds one transport per server, so a single
 * exported instance can be connected exactly once. That is fine for one stdio process and wrong
 * for anything else — including a test that opens two clients.
 */
export function createServer() {
    const server = new McpServer({ name: 'batas', version: '1.0.0' });

    server.registerTool(
        'read_mandate',
        {
            title: 'Read a mandate from its bytes',
            description:
                'Decode a SwapVM program into the limits it enforces: the size cap, the floor price, the'
                + ' expiry, the fee and the curve. Free — this is arithmetic on bytes you already hold.'
                + ' Reports whether PolicyEnvelope is in the outermost position, which is what makes the'
                + ' limits binding rather than advisory. Omit `program` to read the live Sepolia position.',
            inputSchema: { program: z.string().optional().describe('0x SwapVM instruction stream') },
        },
        async ({ program }) => {
            try {
                return text(JSON.stringify(await decodeAnswer(program), null, 2));
            } catch (e) {
                return fail(String(e.message ?? e));
            }
        },
    );

    server.registerTool(
        'check_publication',
        {
            title: 'Check when a mandate was published',
            description:
                'Ask Hedera Consensus Service when these exact bytes were first published, and by whom.'
                + ' Free, and read from a public mirror node rather than from us. A program that decodes'
                + ' cleanly but has no record is a set of terms someone handed you a minute ago, which is'
                + ' a different thing from a grant that has been standing. The match is on the whole'
                + ' program: a mandate differing by one byte is a different grant.',
            inputSchema: { program: z.string().optional().describe('0x SwapVM instruction stream') },
        },
        async ({ program }) => {
            try {
                return text(JSON.stringify(await publicationAnswer(program), null, 2));
            } catch (e) {
                return fail(String(e.message ?? e));
            }
        },
    );

    server.registerTool(
        'check_agent_authority',
        {
            title: 'Check whether the agent is still authorised',
            description:
                'Read the ENSv2 mandate name that gates the agent. Free. Returns whether the name is held'
                + ' and unexpired, and if not, whether it lapsed or was revoked ahead of its term — the'
                + ' owner can end the agent\'s authority at any moment without touching the position.',
            inputSchema: {
                label: z.string().optional().describe('mandate name label, default "agent"'),
                grantedUntil: z.number().optional()
                    .describe('the mandate\'s own deadline, unix seconds; supply it to tell revocation from lapse'),
            },
        },
        async ({ label, grantedUntil }) => {
            try {
                return text(JSON.stringify(await authorityAnswer({ label, grantedUntil }), null, 2));
            } catch (e) {
                return fail(String(e.shortMessage ?? e.message ?? e));
            }
        },
    );

    server.registerTool(
        'inspect_mandate_paid',
        {
            title: 'Buy a full mandate inspection',
            description:
                'Settle 0.001 HBAR on Hedera testnet and get the complete answer from the live service:'
                + ' the decoded limits, the publication record, and the ERC-8004 identity behind the'
                + ' position with a check that it is held by the address that granted the mandate.'
                + ' THIS SPENDS MONEY — one payment per call, capped at 0.01 HBAR by the client. Prefer'
                + ' the free tools first and reach for this when the operator behind a position matters.',
            inputSchema: { program: z.string().optional().describe('0x SwapVM instruction stream') },
            annotations: { readOnlyHint: false, openWorldHint: true },
        },
        async ({ program }) => {
            try {
                const { program: p, source } = await resolveProgram(program);
                // Silent logger: the narration the CLI prints would land in the JSON-RPC stream here.
                const { body, settlement } = await payForExplanation(p, { log: () => {} });
                return text(JSON.stringify({ source, paid: true, settlement, ...body }, null, 2));
            } catch (e) {
                return fail(String(e.message ?? e));
            }
        },
    );

    return server;
}

if (import.meta.filename === process.argv[1]) {
    await createServer().connect(new StdioServerTransport());
}
