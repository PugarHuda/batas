// Batas as a Hedera Agent Kit plugin.
//
//   import { batasPlugin } from 'batas/hedera-agent-kit';
//   new HederaLangchainToolkit({ client, configuration: { plugins: [batasPlugin] } });
//
// Every tool here is a query, and none of them touches the caller's Hedera client: the mandate and
// the name are on Sepolia, the publication and the payment trail are read from a public mirror node,
// and the one paid tool settles from the account named in HEDERA_AGENT_ID rather than from the kit's.
//
// Tools are the kit's plain `Tool` objects. This file used to subclass a `BaseTool` that the kit's
// current release (3.8) does not export, so the import failed before any tool could be listed.

import { untypedQueryOutputParser } from 'hedera-agent-kit';
import { z } from 'zod';

import { TOOLS } from '../tools.mjs';

const asTool = (method, { title, description, shape, run }) => ({
    method,
    name: title,
    description,
    parameters: z.object(shape),
    outputParser: untypedQueryOutputParser,
    // Failures come back in the shape the kit's own query tools use, `raw.error`, because the kit
    // stringifies whatever `execute` returns and a thrown error would never reach its parser.
    execute: async (_client, _context, params) => {
        try {
            const raw = await run(params ?? {});
            return { raw, humanMessage: JSON.stringify(raw, null, 2) };
        } catch (e) {
            const message = String(e.shortMessage ?? e.message ?? e);
            return { raw: { error: message }, humanMessage: message };
        }
    },
});

export const batasPlugin = {
    name: 'batas',
    version: '1.0.0',
    description: 'What a Batas mandate permits, when it was published, whether the agent behind it is still authorised, what its ENS name resolves to, and which payments to it verify.',
    tools: () => Object.entries(TOOLS).map(([method, t]) => asTool(method, t)),
};
