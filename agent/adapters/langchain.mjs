// Batas tools for LangChain.
//
//   import { batasTools } from 'batas/langchain';
//   createReactAgent({ llm, tools: batasTools });

import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import { TOOLS } from '../tools.mjs';

// LangChain tools answer in text; the JSON is the answer, so it goes out as-is.
export const batasTools = Object.entries(TOOLS).map(([name, { description, shape, run }]) =>
    tool(async (input) => JSON.stringify(await run(input)), { name, description, schema: z.object(shape) }));
