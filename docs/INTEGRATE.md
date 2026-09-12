# Integrate in five minutes

Batas answers four questions about a position on 1inch Aqua: what its bytes permit, when those
exact bytes were published, whether the agent behind it is still authorised, and — for 0.001 HBAR —
all of that plus the ERC-8004 identity that vouches for it. Three of the four cost nothing and
need no key. This page is every way software can ask.

## As an MCP server

Over stdio, from a clone:

```bash
claude mcp add batas -- node /path/to/agent/mcp.mjs
```

Or, once the package is published, without cloning anything:

```bash
claude mcp add batas -- npx -y batas mcp
```

The same command works in Cursor, Windsurf and anything else that speaks MCP; the server is
`agent/mcp.mjs`, and `batas mcp` is the same thing behind the CLI. Four tools:

| Tool | Cost | Answers |
|---|---|---|
| `read_mandate` | free | what these bytes permit, and whether `PolicyEnvelope` is outermost |
| `check_publication` | free | when these exact bytes were published, from the mirror node |
| `check_agent_authority` | free | whether the ENS name still holds, and if not, lapsed or revoked |
| `inspect_mandate_paid` | **0.001 HBAR** | all of it, plus the ERC-8004 identity and whether it vouches |

Every answer goes out as text and as `structuredContent`, so a client that reads the latter never
parses the former. Omit `program` and the tools read the live Sepolia position; if the maker has
docked it, the answer says `docked: true` and a note explains that the terms are no longer on offer.

## As a library

```js
import { explain, client } from 'batas';         // or './agent/index.mjs' from a clone

explain('0x2121…');                               // no network: the limits these bytes enforce

const batas = client();                           // https://batas-one.vercel.app by default
await batas.decode('0x2121…');                    // free
await batas.publication('0x2121…');               // free
await batas.authority({ label: 'agent' });        // free
await batas.reputation();                         // free
await batas.inspect('0x2121…', {                  // 0.001 HBAR, settled through x402
    accountId: '0.0.…', privateKey: '…',          // or HEDERA_AGENT_ID / HEDERA_AGENT_KEY
});
```

Importing `batas` reads no `.env` and opens no connection; the x402 client loads on the first
paid call. Everything the CLI tools use is exported too — `decode`, `toProgram`, `decideMandate`,
`clearsFloor`, `lookupMandate`, `lookupRevocations`, `mandateNameStatus`, `classifyName`,
`resolveAgent`, `vouchesFor`, `readReputation`, `latestProgramOnChain`, `programFromStrategy`, the
four free answers, and `deployment` with every live address.

## In an agent framework

One table of tools, `batas/tools`, and an adapter per framework over it. Each is a dozen lines;
read it before trusting it.

```js
import { batasTools } from 'batas/ai-sdk';            // Vercel AI SDK: tools: batasTools
import { batasTools } from 'batas/langchain';         // @langchain/core tools, an array
import { batasTools } from 'batas/openai-agents';     // OpenAI Agents SDK, optional → nullable
import { batasServer } from 'batas/claude-agent-sdk'; // in-process MCP server for query()
import { batasPlugin } from 'batas/hedera-agent-kit'; // Hedera Agent Kit v4 plugin
```

None of these frameworks is a dependency of this package. Install the one you use; the adapter
imports it.

## Over HTTP

```bash
curl -X POST https://batas-one.vercel.app/v1/mandate/decode \
  -H 'Content-Type: application/json' -d '{"program":"0x2121…"}'

curl -X POST https://batas-one.vercel.app/v1/mandate/publication \
  -H 'Content-Type: application/json' -d '{"program":"0x2121…"}'

curl 'https://batas-one.vercel.app/v1/agent/authority?label=agent'
curl 'https://batas-one.vercel.app/v1/agent/reputation'
curl https://batas-one.vercel.app/.well-known/x402      # what the paid route costs

curl -X POST https://batas-one.vercel.app/v1/mandate/explain \
  -H 'Content-Type: application/json' -d '{"program":"0x2121…"}'   # answers 402; settle and retry
```

## From the shell

```bash
npx batas decode 0x2121…          # no network
npx batas inspect                 # the live position, free
npx batas inspect --paid          # the whole answer, 0.001 HBAR
npx batas publication 0x2121…
npx batas authority agent
npx batas mcp
```

## What needs which variable

Nothing is required to read. `agent/deployment.mjs` carries every public address as a default.

| Command | Needs |
|---|---|
| `batas decode`, `read_mandate`, `explain()` | nothing, and no network |
| `batas inspect`, `batas publication`, `batas authority`, the free tools and routes | nothing; `SEPOLIA_RPC_URL` to use your own node |
| `batas inspect --paid`, `inspect_mandate_paid`, `client().inspect()` | `HEDERA_AGENT_ID`, `HEDERA_AGENT_KEY`; `X402_MAX_TINYBAR` caps one payment (default 0.01 HBAR); `BATAS_SERVICE_URL` to point at another deployment |
| `node agent/ens.mjs --read` | nothing |
| `node agent/ens.mjs --deploy / --grant / --revoke` | `SEPOLIA_PRIVATE_KEY`; revoke also notes itself on HCS when `HEDERA_SERVICE_ID` and `BATAS_HCS_TOPIC` are set |
| `node agent/service.mjs` | `HEDERA_SERVICE_ID` |
| `node agent/batas-agent.mjs` | `SEPOLIA_PRIVATE_KEY`, and `HEDERA_SERVICE_ID` / `HEDERA_SERVICE_KEY` to publish |
| `node agent/counterparty.mjs --trade` | `BATAS_COUNTERPARTY_KEY` |

Any `BATAS_*` from `.env.example` overrides the matching default in `deployment.mjs`.

## Publishing the package

`package.json` is `private: true`; publishing is a decision, not a side effect of this file.
When it is made:

1. Remove `"private": true`, add `"mcpName": "io.github.PugarHuda/batas"`, and `npm publish`.
   `files` already limits the tarball to `agent/`, the adapters and this page.
2. Write `server.json` for the MCP registry next to `package.json`:
   ```json
   {
     "$schema": "https://static.modelcontextprotocol.io/schemas/2025-07-09/server.schema.json",
     "name": "io.github.PugarHuda/batas",
     "description": "What a 1inch Aqua mandate permits, when it was published, and whether the agent behind it is still authorised",
     "version": "0.1.0",
     "packages": [{ "registryType": "npm", "identifier": "batas", "version": "0.1.0", "transport": { "type": "stdio" }, "runtimeHint": "npx", "packageArguments": [{ "type": "positional", "value": "mcp" }] }]
   }
   ```
3. `mcp-publisher login github` and `mcp-publisher publish`. The registry checks that the npm
   package's `mcpName` matches the `name` above, which is why step 1 sets it.
