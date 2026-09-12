// Batas as a Hedera Agent Kit plugin.
//
//   import { batasPlugin } from 'batas/hedera-agent-kit';
//   new HederaLangchainToolkit({ client, configuration: { plugins: [batasPlugin] } });
//
// Every tool here is a query, and none of them touches the caller's Hedera client: the mandate is
// on Sepolia, the publication is read from a public mirror node, and the one paid tool settles
// from the account named in HEDERA_AGENT_ID rather than from the kit's.

import { BaseTool, untypedQueryOutputParser } from 'hedera-agent-kit';
import { z } from 'zod';

import { TOOLS } from '../tools.mjs';

const toolClass = (method, { title, description, shape, run }) => class extends BaseTool {
    method = method;
    name = title;
    description = description;
    parameters = z.object(shape);
    outputParser = untypedQueryOutputParser;
    async coreAction(params) {
        const raw = await run(params);
        return { raw, humanMessage: JSON.stringify(raw, null, 2) };
    }
    shouldSecondaryAction() { return false; }
};

export const batasPlugin = {
    name: 'batas',
    version: '1.0.0',
    description: 'What a Batas mandate permits, when it was published, and whether the agent behind it is still authorised.',
    tools: () => Object.entries(TOOLS).map(([method, t]) => new (toolClass(method, t))()),
};
