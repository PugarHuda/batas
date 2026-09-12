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
import 'dotenv/config';

import { TOOLS } from './tools.mjs';

/**
 * A server per connection.
 *
 * A factory rather than a shared instance: the SDK binds one transport per server, so a single
 * exported instance can be connected exactly once. That is fine for one stdio process and wrong
 * for anything else — including a test that opens two clients.
 *
 * The tools themselves live in tools.mjs, one table shared with every other framework adapter.
 * Each answer goes out twice: as text, for clients that only read text, and as
 * `structuredContent`, for the ones that would otherwise parse the text back into JSON.
 */
export function createServer() {
    const server = new McpServer({ name: 'batas', version: '1.0.0' });

    for (const [name, { title, description, annotations, shape, run }] of Object.entries(TOOLS)) {
        server.registerTool(name, { title, description, annotations, inputSchema: shape }, async (args) => {
            try {
                const answer = await run(args);
                return { content: [{ type: 'text', text: JSON.stringify(answer, null, 2) }], structuredContent: answer };
            } catch (e) {
                return { content: [{ type: 'text', text: String(e.shortMessage ?? e.message ?? e) }], isError: true };
            }
        });
    }

    return server;
}

if (import.meta.filename === process.argv[1]) {
    await createServer().connect(new StdioServerTransport());
}
