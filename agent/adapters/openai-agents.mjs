// Batas tools for the OpenAI Agents SDK.
//
//   import { batasTools } from 'batas/openai-agents';
//   new Agent({ name: 'trader', tools: batasTools });

import { tool } from '@openai/agents';
import { z } from 'zod';

import { TOOLS } from '../tools.mjs';

// Structured outputs want every field present, so `.optional()` becomes `.nullable()` on the way
// in and a null becomes an absent field on the way out — the handlers only know about absence.
const nullable = (shape) => z.object(Object.fromEntries(Object.entries(shape).map(([k, v]) =>
    [k, (v instanceof z.ZodOptional ? v.unwrap() : v).nullable().describe(v.description ?? '')])));
const dropNulls = (args) => Object.fromEntries(Object.entries(args).filter(([, v]) => v !== null));

export const batasTools = Object.entries(TOOLS).map(([name, { description, shape, run }]) =>
    tool({ name, description, parameters: nullable(shape), execute: (args) => run(dropNulls(args)) }));
