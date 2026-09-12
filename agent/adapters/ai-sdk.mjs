// Batas tools for the Vercel AI SDK.
//
//   import { batasTools } from 'batas/ai-sdk';
//   generateText({ model, tools: batasTools, prompt: 'is the live position still bounded?' });

import { tool } from 'ai';
import { z } from 'zod';

import { TOOLS } from '../tools.mjs';

export const batasTools = Object.fromEntries(
    Object.entries(TOOLS).map(([name, { description, shape, run }]) => [
        name,
        tool({ description, inputSchema: z.object(shape), execute: (args) => run(args) }),
    ]),
);
