// Batas as an in-process MCP server for the Claude Agent SDK.
//
//   import { batasServer } from 'batas/claude-agent-sdk';
//   query({ prompt, options: { mcpServers: { batas: batasServer } } });
//
// The stdio server in agent/mcp.mjs does the same job for any MCP client; this one skips the
// process boundary when the caller is already the SDK.

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

import { TOOLS } from '../tools.mjs';

const text = (s) => ({ content: [{ type: 'text', text: s }] });

export const batasTools = Object.entries(TOOLS).map(([name, { description, shape, run, annotations }]) =>
    tool(name, description, shape, async (args) => {
        try {
            return text(JSON.stringify(await run(args), null, 2));
        } catch (e) {
            return { ...text(String(e.shortMessage ?? e.message ?? e)), isError: true };
        }
    }, { annotations }));

export const batasServer = createSdkMcpServer({ name: 'batas', version: '1.0.0', tools: batasTools });
