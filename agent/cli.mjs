#!/usr/bin/env node
// One command in front of the entry points that already exist.
//
//   batas decode 0x…             what these bytes permit, no network
//   batas inspect [0x…] [--paid] the live position free, or the whole answer for 0.001 HBAR
//   batas publication 0x…        when these bytes were published, from the mirror node
//   batas authority [label]      whether the mandate name still holds
//   batas mcp                    the MCP server over stdio
//
// Each subcommand loads only what it needs: `decode` never opens a transport, and nothing but
// `--paid` loads the payment client.

const [cmd, ...rest] = process.argv.slice(2);
const print = (v) => console.log(JSON.stringify(v, null, 2));
const hex = rest.find((a) => a.startsWith('0x'));

try {
    switch (cmd) {
        case 'decode': {
            if (!hex) throw new Error('usage: batas decode 0x…');
            print((await import('./swapvm.mjs')).explain(hex));
            break;
        }
        case 'inspect': {
            if (rest.includes('--paid')) {
                const { payForExplanation } = await import('./inspect.mjs');
                const { resolveProgram } = await import('./free.mjs');
                const { program, source } = await resolveProgram(hex);
                // Narration goes to stderr so stdout stays one JSON document.
                const { body, settlement } = await payForExplanation(program, { log: (m) => console.error(m) });
                print({ source, paid: true, settlement, ...body });
            } else {
                print(await (await import('./free.mjs')).decodeAnswer(hex));
            }
            break;
        }
        case 'publication':
            print(await (await import('./free.mjs')).publicationAnswer(hex));
            break;
        case 'authority':
            print(await (await import('./free.mjs')).authorityAnswer({ label: rest.find((a) => !a.startsWith('-')) }));
            break;
        case 'mcp': {
            const { createServer } = await import('./mcp.mjs');
            const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
            await createServer().connect(new StdioServerTransport());
            break;
        }
        default:
            console.error('usage: batas decode 0x… | inspect [0x…] [--paid] | publication 0x… | authority [label] | mcp');
            process.exit(cmd ? 1 : 0);
    }
} catch (e) {
    console.error(String(e.shortMessage || e.message || e));
    process.exit(1);
}
