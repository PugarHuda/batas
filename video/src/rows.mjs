// Every row of the three prize tables in SUBMISSION.md, with the short on-screen caption that names
// the requirement. Scenes cite rows by id, and tools/build.mjs fails if any row is never shown, so
// coverage is checked by the build rather than by eye.
export const PRIZES = {
    hedera: 'Hedera · AI & Agentic Payments',
    oneinch: '1inch · Build an Aqua App',
    ens: 'ENS · Best Use of ENSv2',
};

export const ROWS = [
    { id: 'H-Q1', prize: 'hedera', caption: 'Agent executes a payment on Hedera Testnet' },
    { id: 'H-Q2', prize: 'hedera', caption: 'Uses x402, A2A, Hedera SDKs and a Hedera Agent Kit adapter' },
    { id: 'H-Q3', prize: 'hedera', caption: 'Public repo, README: setup, architecture, payment flow' },
    { id: 'H-Q4', prize: 'hedera', caption: 'Demo video under 5 minutes of autonomous payments' },
    { id: 'H-E1', prize: 'hedera', caption: 'On-chain agent identity: ERC-8004 #10123 and HCS-14' },
    { id: 'H-E2', prize: 'hedera', caption: 'Pay-per-call metering, not a flat charge' },
    { id: 'H-E3', prize: 'hedera', caption: 'Multi-agent negotiation and settlement via A2A' },
    { id: 'H-E4', prize: 'hedera', caption: 'Discovery: ERC-8004 registry and HOL HCS-10 directory' },
    { id: 'H-E5', prize: 'hedera', caption: 'HTS token and custom fee in the settlement path' },
    { id: 'H-E6', prize: 'hedera', caption: 'Verifiable payment audit trail on HCS' },
    { id: 'H-E7', prize: 'hedera', caption: 'Recurring payments with Scheduled Transactions' },
    { id: 'I-1', prize: 'oneinch', caption: 'Sophisticated Aqua position, shown in tests and a UI' },
    { id: 'I-2', prize: 'oneinch', caption: 'Own SwapVM instructions: 0x21 and 0x22' },
    { id: 'I-3', prize: 'oneinch', caption: 'Official Aqua contract used as-is' },
    { id: 'I-4', prize: 'oneinch', caption: 'On-chain token transfers on Sepolia' },
    { id: 'I-5', prize: 'oneinch', caption: 'Proper Git commit history' },
    { id: 'E-Q1', prize: 'ens', caption: 'Built on ENSv2 (Sepolia)' },
    { id: 'E-Q2', prize: 'ens', caption: 'ENSv2 central: settlement reads the registry' },
    { id: 'E-Q3', prize: 'ens', caption: 'Functional, no hard-coded values' },
    { id: 'E-Q4', prize: 'ens', caption: 'Video and live demo, open source' },
    { id: 'E-F1', prize: 'ens', caption: 'Own subname registry under batas.eth' },
    { id: 'E-F2', prize: 'ens', caption: 'Expiring, revocable, non-transferable' },
    { id: 'E-F3', prize: 'ens', caption: 'Enhanced access control: one delegated right' },
    { id: 'E-F4', prize: 'ens', caption: 'Subname with its own PermissionedResolver' },
    { id: 'E-F5', prize: 'ens', caption: 'Wildcard resolution off the parent resolver' },
    { id: 'E-F6', prize: 'ens', caption: 'Record aliasing at the resolver' },
    { id: 'E-F7', prize: 'ens', caption: 'Agent as a namespace: ENSIP-25 link to ERC-8004' },
];
