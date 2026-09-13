import React from 'react';
import { useCurrentFrame, interpolate, spring, useVideoConfig } from 'remotion';
import HASHES from './hashes.json';
import { C, F, p, qp, Txt, Line, State, Mark, Rose, Stage, sceneCtx } from './kit';

const Hex: React.FC<{ x: number; y: number; r?: number; c?: string; o?: number }> = ({ x, y, r = 20, c = C.structure, o = 1 }) => (
  <g opacity={o}>
    <polygon points={Array.from({ length: 6 }, (_, i) => `${x + r * Math.cos((i * Math.PI) / 3)},${y + r * Math.sin((i * Math.PI) / 3)}`).join(' ')} fill={C.paper} stroke={c} strokeWidth={3} />
    <circle cx={x} cy={y} r={4.5} fill={c} />
  </g>
);

const Plate: React.FC<{ x: number; y: number; w: number; h: number; o?: number }> = ({ x, y, w, h, o = 1 }) => (
  <rect x={x} y={y} width={w} height={h} rx={4} fill={C.paper} stroke={C.edge} strokeWidth={1.5} opacity={o} />
);

// ---------------------------------------------------------------- 01
export const ColdOpen: React.FC = () => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { w } = sceneCtx('01-cold-open');
  const S = 250 / 32, ox = 960 - 125, oy = 150;
  const stops = spring({ frame: f - 6, fps, config: { damping: 18, stiffness: 120 } });
  const span = p(f, 20, 22); // eased, no overshoot: the span stops short of the right stop
  const def = w('Indonesian');
  return (
    <Stage id="01-cold-open">
      <Rose cx={960} cy={410} r={360} o={0.22} />
      <rect x={ox + S} y={oy + S} width={30 * S} height={30 * S} rx={3 * S} fill={C.paper} stroke={C.ink} strokeWidth={6} opacity={p(f, 0, 12)} />
      <rect x={interpolate(stops, [0, 1], [ox - 300, ox + 7 * S])} y={oy + 8 * S} width={2.6 * S} height={16 * S} fill={C.boundary} opacity={Math.min(1, stops * 3)} />
      <rect x={interpolate(stops, [0, 1], [ox + 600, ox + 22.4 * S])} y={oy + 8 * S} width={2.6 * S} height={16 * S} fill={C.boundary} opacity={Math.min(1, stops * 3)} />
      <rect x={ox + 12 * S} y={oy + 14.7 * S} width={7.5 * S * span} height={2.6 * S} fill={C.ink} />
      {'BATAS'.split('').map((ch, i) => {
        const t = p(f, w('Batas') + i * 2, 12);
        return <Txt key={i} x={740 + i * 110} y={600 + (1 - t) * 30} s={190} f="display" a="middle" o={t}>{ch}</Txt>;
      })}
      <g opacity={p(f, def, 12)}>
        <Txt x={960} y={710} s={42} a="middle" c={C.ink2}>Indonesian for mandate:</Txt>
        <Txt x={960} y={776} s={42} a="middle" c={C.ink2}>
          authority entrusted within limits that <tspan fill={C.boundary} fontWeight={700}>must not be exceeded.</tspan>
        </Txt>
      </g>
    </Stage>
  );
};

// ---------------------------------------------------------------- 02
const PULL = [
  ['function pull(address maker, bytes32 strategyHash,'],
  ['    address token, uint256 amount, address to) external {'],
  ['  Balance storage balance ='],
  ['    _balances[maker][', 'msg.sender', '][strategyHash][token];'],
  ['  IERC20(token).safeTransferFrom(maker, to, amount);'],
];
export const Problem: React.FC = () => {
  const f = useCurrentFrame();
  const { w } = sceneCtx('02-problem');
  const check = w('checks'), take = w('take'), agent = w('agent'), stops = w('stops');
  const CW = 16.76; // B612 Mono advance at 26px, measured on the still
  const a = [640, 770], c = [1060, 880], b = [1470, 720];
  const drain = p(f, take + 6, agent - take + 30);
  const level = interpolate(drain, [0, 1], [1, 271.86 / 2000]);
  return (
    <Stage id="02-problem">
      <g opacity={p(f, 0, 14)}>
        <Txt x={560} y={178} s={36} f="display" c={C.ink2} ls={1.5}>AQUA.PULL() — THE WHOLE SECURITY MODEL</Txt>
        <Plate x={540} y={196} w={880} h={250} />
        {PULL.map((parts, i) => (
          <text key={i} x={570} y={250 + i * 44} fontSize={26} fontFamily={F.mono} fill={C.ink}>
            {parts.map((s, j) => <tspan key={j} fill={j === 1 ? (f >= check ? C.boundary : C.ink) : C.ink} fontWeight={j === 1 ? 700 : 400}>{s}</tspan>)}
          </text>
        ))}
      </g>
      <Line d={`M ${570 + 17 * CW - 4} ${382} h ${10 * CW + 8} v 0`} t={p(f, check, 10)} c={C.boundary} sw={5} />
      <rect x={570 + 17 * CW - 6} y={346} width={10 * CW + 12} height={46} fill="none" stroke={C.boundary} strokeWidth={3} rx={2} opacity={p(f, check, 10)} />
      <g opacity={p(f, check + 6, 12)}>
        <Txt x={1440} y={362} s={30} c={C.boundary} w={700}>the only check:</Txt>
        <Txt x={1440} y={402} s={30} c={C.boundary} w={700}>who is calling</Txt>
      </g>

      {/* maker's wallet: a fuel tape that drains while nothing refuses */}
      <g opacity={p(f, 4, 14)}>
        <rect x={120} y={520} width={70} height={310} fill={C.sunk} stroke={C.edge} strokeWidth={1.5} rx={2} />
        <rect x={120} y={520 + 310 * (1 - level)} width={70} height={310 * level} fill={drain > 0.99 ? C.never : C.inside} opacity={0.85} />
        <Txt x={220} y={560} s={36} f="display" ls={1}>MAKER'S WALLET</Txt>
        <Txt x={220} y={598} s={24} c={C.dim}>tokens never leave it</Txt>
      </g>
      <g opacity={p(f, agent + 20, 14)}>
        <Txt x={220} y={680} s={52} w={700} c={C.never}>271.86</Txt>
        <Txt x={220} y={716} s={24} c={C.ink2}>tokenB left, 14% kept</Txt>
        <Txt x={220} y={750} s={24} c={C.ink2}>64 trades at 0.270, no mandate</Txt>
        <State k="never" x={196} y={666} r={10} />
      </g>

      <Line d={`M ${a} Q ${c} ${b}`} t={p(f, 8, 26)} c={C.structure} sw={3} dash="14 10" />
      {f >= take && Array.from({ length: 7 }, (_, i) => {
        const t = ((f - take) / 34 + i / 7) % 1;
        const [x, y] = qp(a, c, b, t);
        return <circle key={i} cx={x} cy={y} r={11} fill={C.inside} stroke={C.paper} strokeWidth={3} opacity={drain > 0.99 ? 0 : 1} />;
      })}
      <g opacity={p(f, 14, 14)}>
        <rect x={1480} y={560} width={360} height={260} rx={4} fill={C.paper} stroke={f >= agent ? C.caution : C.edge} strokeWidth={f >= agent ? 3 : 1.5} />
        <Txt x={1660} y={640} s={40} f="display" a="middle" o={1 - p(f, agent, 8)}>THE APP YOU</Txt>
        <Txt x={1660} y={684} s={40} f="display" a="middle" o={1 - p(f, agent, 8)}>SHIPPED TO</Txt>
        <g opacity={p(f, agent, 10)}>
          <State k="caution" x={1660} y={620} r={14} />
          <Txt x={1660} y={694} s={46} f="display" a="middle" c={C.caution}>AN AUTONOMOUS</Txt>
          <Txt x={1660} y={742} s={46} f="display" a="middle" c={C.caution}>AGENT</Txt>
        </g>
      </g>
      <Txt x={960} y={620} s={110} f="display" a="middle" o={p(f, stops - 4, 10)} ls={2}>WHAT STOPS IT?</Txt>
    </Stage>
  );
};

// ---------------------------------------------------------------- 03
const PROGRAM = '212100000000000000006367be30fcbd45ea00000000000000001aeff914e72b45e8802005006acd0476222e945800bd6cdd60521b64a12d7b3f12fc90916a6b39d2bae5eaeda9283535ddc98f1991c81ed5cd7e056167656e74700300753050000208000000006aa5dc37';
const BYTES = PROGRAM.match(/../g)!;
// Byte ranges verified by decoding the live program (maxAmountIn, minRate, expiry, MandateName, "agent").
const SEG = { env: [0, 1], cap: [10, 17], floor: [26, 33], expiry: [38, 41], name: [42, 43], label: [85, 89] };
const inSeg = (i: number, k: keyof typeof SEG) => i >= SEG[k][0] && i <= SEG[k][1];

export const Mandate: React.FC = () => {
  const f = useCurrentFrame();
  const { w } = sceneCtx('03-mandate-is-the-strategy');
  const enc = w('encode'), env = w('PolicyEnvelope'), hashes = w('hashes'), drop = w('Drop');
  const PER = 27, BW = 56, X0 = 204, Y0 = 470, RH = 52;
  const pos = (i: number) => [X0 + (i % PER) * BW, Y0 + Math.floor(i / PER) * RH];
  const typed = Math.floor(interpolate(f, [enc + 8, enc + 50], [0, BYTES.length], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
  const dropped = f >= drop;
  const terms = [
    { k: 'cap' as const, label: 'SIZE CAP', value: '7.162902849964033514 A', sub: 'maxAmountIn', c: C.boundary, at: w('cap'), x: 150 },
    { k: 'floor' as const, label: 'FLOOR', value: '1.941043832593008104', sub: 'minRate, B per A', c: C.never, at: w('floor'), x: 720 },
    { k: 'expiry' as const, label: 'EXPIRY', value: '2026-10-12 16:01:58', sub: 'UTC, 1791820918', c: C.ink, at: w('expiry'), x: 1290 },
  ];
  const settle = p(f, hashes + 4, 30);
  return (
    <Stage id="03-mandate-is-the-strategy">
      {terms.map((t) => {
        const o = p(f, t.at - 2, 10);
        const [bx, by] = pos(SEG[t.k][0]);
        const [ex] = pos(SEG[t.k][1]);
        return (
          <g key={t.k}>
            <g opacity={o} transform={`translate(0 ${(1 - o) * -16})`}>
              <line x1={t.x} y1={150} x2={t.x + 480} y2={150} stroke={t.c} strokeWidth={4} />
              <Txt x={t.x} y={194} s={34} f="display" c={t.c} ls={1.5}>{t.label}</Txt>
              <Txt x={t.x} y={246} s={36} w={700}>{t.value}</Txt>
              <Txt x={t.x} y={288} s={24} c={C.dim}>{t.sub}</Txt>
            </g>
            <Line d={`M ${t.x + 40} 304 C ${t.x + 40} 380, ${(bx + ex) / 2 + 26} 360, ${(bx + ex) / 2 + 26} ${by - 34}`} t={p(f, Math.max(t.at, enc + 30), 16)} c={t.c} sw={2.5} dash="8 6" />
            {t.k !== 'expiry' && dropped && (
              <g stroke={C.never} strokeWidth={6}>
                <Line d={`M ${t.x - 10} 150 L ${t.x + 490} 300`} t={p(f, drop, 8)} c={C.never} sw={6} />
                <Line d={`M ${t.x - 10} 300 L ${t.x + 490} 150`} t={p(f, drop + 3, 8)} c={C.never} sw={6} />
              </g>
            )}
          </g>
        );
      })}

      <Txt x={X0 + PER * BW - 8} y={Y0 + 3 * RH + 46} s={22} c={C.dim} a="end" o={p(f, enc, 10)}>abi.encode(mandate), 107 bytes</Txt>
      {BYTES.slice(0, typed).map((b, i) => {
        const [x, y] = pos(i);
        const k = (['env', 'cap', 'floor', 'expiry', 'name', 'label'] as const).find((s) => inSeg(i, s));
        const col = k === 'env' ? C.boundary : k === 'cap' ? C.boundary : k === 'floor' ? C.never : k === 'expiry' ? C.ink : k === 'name' || k === 'label' ? C.structure : C.dim;
        const cut = dropped && i < HASHES.envelopeBytes;
        return (
          <g key={i} opacity={cut ? 1 - 0.55 * p(f, drop, 12) : 1}>
            <text x={x} y={y} fontSize={30} fontFamily={F.mono} fill={col} fontWeight={k ? 700 : 400}>{b}</text>
            {cut && <line x1={x - 4} y1={y - 10} x2={x - 4 + 44 * p(f, drop + (i % PER) * 0.4, 8)} y2={y - 10} stroke={C.never} strokeWidth={4} />}
          </g>
        );
      })}
      {/* PolicyEnvelope: the outermost frame around the whole program */}
      <g opacity={p(f, env, 8)}>
        <Line d={`M ${X0 - 22} ${Y0 - 30} H ${X0 + PER * BW - 8} V ${Y0 + 3 * RH + 16} H ${X0 - 22} Z`} t={p(f, env, 22)} c={C.boundary} sw={3.5} />
        <rect x={X0 - 22} y={Y0 + 3 * RH + 16} width={560} height={40} fill={C.boundary} />
        <Txt x={X0 - 8} y={Y0 + 3 * RH + 46} s={28} f="display" c="#fff" ls={1.2}>POLICYENVELOPE 0x21 · OUTERMOST FRAME</Txt>
        <Txt x={X0 + 580} y={Y0 + 3 * RH + 46} s={24} c={C.structure}>0x22 MandateName reads "agent"</Txt>
      </g>

      <g opacity={p(f, hashes - 2, 10)}>
        <Txt x={X0 - 22} y={722} s={30} f="display" c={C.ink2} ls={1.5}>AQUA.SHIP() HASHES IT · STRATEGY HASH = MANDATE HASH</Txt>
        <text x={X0 - 22} y={768} fontSize={30} fontFamily={F.mono} fill={settle >= 1 ? C.inside : C.ink} fontWeight={700}>
          {HASHES.shipped.slice(0, Math.max(2, Math.ceil(HASHES.shipped.length * settle)))}
        </text>
        {settle >= 1 && <g><State k="inside" x={1512} y={758} r={12} /><Txt x={1536} y={768} s={24} w={700} c={C.inside}>shipped, funded</Txt></g>}
      </g>
      <g opacity={p(f, drop + 4, 10)}>
        <Txt x={X0 - 22} y={814} s={24} c={C.never} w={700}>the same order, program without PolicyEnvelope: a strategy nobody shipped tokens to</Txt>
        <text x={X0 - 22} y={856} fontSize={30} fontFamily={F.mono} fill={C.never} fontWeight={700}>
          {HASHES.unguarded.slice(0, Math.max(2, Math.ceil(HASHES.unguarded.length * p(f, drop + 6, 24))))}
        </text>
        <State k="never" x={1512} y={846} r={12} />
        <Txt x={1536} y={856} s={24} w={700} c={C.never}>no reserves</Txt>
      </g>
    </Stage>
  );
};

// ---------------------------------------------------------------- 04
export const KillSwitch: React.FC = () => {
  const f = useCurrentFrame();
  const { w } = sceneCtx('04-kill-switch');
  const reads = w('reads'), revoke = w('Revoke'), every = w('every', 1);
  const router = [1440, 470];
  const callers = [[620, 800], [940, 820], [1260, 800]];
  const revoked = f >= revoke + 4;
  const ping = (s: number) => p(f, s, 14);
  const flight = (s: number, i: number) => {
    const t = interpolate(f, [s, s + 22, s + 36], [0, 1, 0.7], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
    const a = callers[i], c = [(a[0] + router[0]) / 2, 760];
    return { t, pt: qp(a, c, router, t), d: `M ${a} Q ${c} ${router}` };
  };
  const first = flight(reads, 1);
  return (
    <Stage id="04-kill-switch">
      <Rose cx={400} cy={430} r={300} o={0.14} />
      <g opacity={p(f, 0, 12)}>
        <Plate x={110} y={180} w={640} h={380} />
        <Txt x={140} y={234} s={34} f="display" c={C.ink2} ls={1.5}>ENSV2 SUBNAME · THE AGENT'S AUTHORITY</Txt>
        <Txt x={140} y={316} s={64} w={700}>agent.batas.eth</Txt>
        <Txt x={140} y={372} s={24} f="mono" c={C.dim}>registry 0x945800Bd…90916a6B</Txt>
        <Txt x={140} y={408} s={24} f="mono" c={C.dim}>expires  2026-10-12 16:01:58 UTC</Txt>
        <line x1={140} y1={440} x2={720} y2={440} stroke={C.rule} strokeWidth={1.5} />
        {!revoked ? (
          <g><State k="inside" x={156} y={500} r={13} /><Txt x={186} y={512} s={40} w={700} c={C.inside}>HELD</Txt></g>
        ) : (
          <g><State k="never" x={156} y={500} r={13} /><Txt x={186} y={512} s={40} w={700} c={C.never}>REVOKED</Txt></g>
        )}
      </g>
      {revoked && <Line d="M 130 290 L 730 330" t={p(f, revoke + 4, 8)} c={C.never} sw={7} />}

      <g opacity={p(f, 6, 12)}>
        <Plate x={1160} y={180} w={640} h={290} />
        <Txt x={1190} y={234} s={34} f="display" c={C.ink2} ls={1.5}>BATASROUTER · SETTLEMENT</Txt>
        <rect x={1190} y={262} width={580} height={180} fill="none" stroke={C.boundary} strokeWidth={3} rx={3} />
        <Txt x={1206} y={296} s={26} f="display" c={C.boundary} ls={1}>0x21 POLICYENVELOPE</Txt>
        <rect x={1214} y={316} width={300} height={100} fill={C.bsoft} stroke={C.structure} strokeWidth={2.5} rx={3} />
        <Txt x={1234} y={358} s={30} w={700} c={C.structure}>0x22</Txt>
        <Txt x={1234} y={396} s={28} w={700} c={C.structure}>MandateName</Txt>
        <Txt x={1540} y={372} s={24} c={C.dim}>then the rest</Txt>
        <Txt x={1540} y={402} s={24} c={C.dim}>of the program</Txt>
      </g>

      {/* the read: settlement asks the name, every time */}
      <Line d="M 1214 366 C 1000 366, 960 380, 750 380" t={p(f, reads - 4, 14)} c={C.structure} sw={3} dash="12 8" />
      {[reads + 20, revoke + 30, revoke + 40].map((s, i) => {
        const t = ping(s);
        if (t <= 0 || t >= 1) return null;
        const x = interpolate(t, [0, 1], [1214, 750]);
        return <circle key={i} cx={x} cy={372} r={10 + 8 * t} fill="none" stroke={i ? C.never : C.structure} strokeWidth={4} opacity={1 - t * 0.6} />;
      })}

      {/* first settlement: inside the mandate */}
      <Line d={first.d} t={p(f, reads - 6, 14)} c={C.edge} sw={2} dash="8 8" />
      {f < revoke && first.t > 0 && <circle cx={first.pt[0]} cy={first.pt[1]} r={13} fill={C.inside} stroke={C.paper} strokeWidth={3} />}
      <g opacity={f < revoke ? p(f, reads + 34, 8) : 0}>
        <State k="inside" x={1500} y={540} r={12} />
        <Txt x={1528} y={552} s={34} w={700} c={C.inside}>quote 1 A → 1.95 B</Txt>
        <Txt x={1528} y={594} s={28} c={C.inside}>name held</Txt>
      </g>

      {callers.map(([x, y], i) => (
        <g key={i} opacity={p(f, reads - 8 + i * 3, 10)}>
          <polygon points={`${x},${y - 18} ${x - 16},${y + 14} ${x + 16},${y + 14}`} fill={C.paper} stroke={C.ink} strokeWidth={3} />
          <Txt x={x} y={y + 50} s={24} a="middle" c={C.ink2}>{['a keeper', 'a taker', 'any caller'][i]}</Txt>
        </g>
      ))}
      {revoked && callers.map((_, i) => {
        const fl = flight(every + i * 5, i);
        return (
          <g key={i}>
            <Line d={fl.d} t={p(f, every - 6 + i * 5, 12)} c={C.edge} sw={2} dash="8 8" />
            {fl.t > 0 && <circle cx={fl.pt[0]} cy={fl.pt[1]} r={13} fill={f > every + i * 5 + 22 ? C.never : C.caution} stroke={C.paper} strokeWidth={3} />}
          </g>
        );
      })}
      <g opacity={revoked ? p(f, every + 24, 8) : 0}>
        <State k="never" x={1500} y={540} r={12} />
        <Txt x={1528} y={552} s={34} w={700} c={C.never}>refused:</Txt>
        <Txt x={1528} y={594} s={30} w={700} c={C.never}>MandateNameNotHeld</Txt>
      </g>
    </Stage>
  );
};

// ---------------------------------------------------------------- 05
const N = {
  agent: { x: 250, y: 520, label: 'COUNTERPARTY AGENT', id: '0.0.10388401' },
  batas: { x: 1120, y: 520, label: 'BATAS SERVICE', id: '0.0.10388560' },
  blocky: { x: 690, y: 250, label: 'BLOCKY402', id: 'x402 facilitator' },
  hcs: { x: 850, y: 780, label: 'HCS TOPIC', id: '0.0.10394165' },
  hol: { x: 250, y: 220, label: 'HOL HCS-10 REGISTRY', id: '0.0.6913983 #384' },
  erc: { x: 250, y: 790, label: 'ERC-8004', id: 'agent #10123' },
};
type NK = keyof typeof N;
const route = (from: NK, to: NK, bend: number) => {
  const a = [N[from].x, N[from].y], b = [N[to].x, N[to].y];
  const c = [(a[0] + b[0]) / 2 - (b[1] - a[1]) * bend, (a[1] + b[1]) / 2 + (b[0] - a[0]) * bend];
  return { a, b, c, d: `M ${a} Q ${c} ${b}` };
};

export const Hedera: React.FC = () => {
  const f = useCurrentFrame();
  const { w, dur } = sceneCtx('05-hedera-economy');
  const legs: { r: ReturnType<typeof route>; at: number; c: string; dash?: string; loop?: boolean }[] = [
    { r: route('agent', 'blocky', 0.12), at: w('pay'), c: C.structure },
    { r: route('blocky', 'batas', 0.12), at: w('pay') + 12, c: C.structure },
    { r: route('agent', 'batas', -0.1), at: w('BIC'), c: C.caution },
    { r: route('agent', 'hcs', 0.12), at: w('logged'), c: C.ink },
    { r: route('agent', 'batas', 0.06), at: w('negotiate'), c: C.boundary, dash: '4 8' },
    { r: route('agent', 'batas', 0.3), at: w('schedule'), c: C.inside, loop: true },
    { r: route('agent', 'hol', 0.25), at: w('directory'), c: C.structure, dash: '12 8' },
    { r: route('hol', 'erc', -0.25), at: w('directory') + 8, c: C.structure, dash: '12 8' },
  ];
  const log = [
    { at: w('x402'), head: 'X402, METERED PER REQUEST', lines: ['40,000 decode + 6 × 1,000 per instruction', '+ 34,000 publication + 20,000 authority', '= 100,000 tinybar = 0.001 HBAR'] },
    { at: w('BIC'), head: 'HTS TOKEN BIC 0.0.10523367', lines: ['1.01 BIC left the agent:', '1.00 price + 0.01 custom fee'] },
    { at: w('logged'), head: 'HCS PAYMENT AUDIT TRAIL', lines: ['batas.payment record per settlement', 'first record: message #16'] },
    { at: w('negotiate'), head: 'A2A OVER X402', lines: ['14.33 A at 1.747 → counter 5.1538 A', 'at 1.9410 → accept → pay 0.001 HBAR'] },
    { at: w('schedule'), head: 'SCHEDULED STANDING ORDER', lines: ['0.0.10523344 · 46 · 47 executed'] },
    { at: w('directory'), head: 'DISCOVERY', lines: ['HOL registry #384 → ERC-8004 #10123'] },
  ];
  const a2a = ['NEGOTIATE', 'COUNTER', 'ACCEPT', 'PAY'];
  const neg = w('negotiate');
  return (
    <Stage id="05-hedera-economy">
      <Rose cx={690} cy={520} r={330} o={0.13} />
      {legs.map((l, i) => {
        const t = p(f, l.at, 20);
        const moving = (f - l.at) / 26;
        return (
          <g key={i}>
            <Line d={l.r.d} t={t} c={l.c} sw={3.5} dash={l.dash} o={0.9} />
            {l.loop
              ? [0, 1, 2].map((k) => {
                const s = (f - l.at - k * 10) / 30;
                if (s < 0 || s > 1) return null;
                const [x, y] = qp(l.r.a, l.r.c, l.r.b, s);
                return <circle key={k} cx={x} cy={y} r={10} fill={C.inside} stroke={C.paper} strokeWidth={3} />;
              })
              : moving > 0 && moving < 1 && (() => {
                const [x, y] = qp(l.r.a, l.r.c, l.r.b, moving);
                return <circle cx={x} cy={y} r={12} fill={l.c} stroke={C.paper} strokeWidth={3} />;
              })()}
          </g>
        );
      })}
      {a2a.map((s, i) => {
        const at = neg + 6 + i * 9;
        const o = f >= at && f < (i === 3 ? dur : neg + 6 + (i + 1) * 9) ? 1 : 0;
        const [x, y] = qp(legs[4].r.a, legs[4].r.c, legs[4].r.b, i % 2 ? 0.66 : 0.34);
        return o ? (
          <g key={s}>
            <rect x={x - 90} y={y - 32} width={180} height={46} rx={3} fill={C.boundary} />
            <Txt x={x} y={y + 2} s={30} f="display" a="middle" c="#fff" ls={1.5}>{s}</Txt>
          </g>
        ) : null;
      })}
      {(Object.keys(N) as NK[]).map((k, i) => {
        const n = N[k];
        const o = p(f, 2 + i * 3, 12);
        const right = n.x > 1000;
        return (
          <g key={k} opacity={o}>
            <Hex x={n.x} y={n.y} r={k === 'agent' || k === 'batas' ? 28 : 20} c={k === 'batas' ? C.boundary : C.structure} />
            <Txt x={n.x} y={n.y - 44} s={28} f="display" a="middle" ls={1.2} halo>{n.label}</Txt>
            <Txt x={n.x} y={n.y + 56} s={24} a="middle" c={C.dim} halo>{n.id}</Txt>
          </g>
        );
      })}

      <line x1={1330} y1={130} x2={1330} y2={860} stroke={C.rule} strokeWidth={1.5} />
      <Txt x={1360} y={160} s={30} f="display" c={C.ink2} ls={1.5}>FLIGHT LOG · HEDERA TESTNET</Txt>
      {log.map((e, i) => {
        const o = p(f, e.at, 10);
        const y = 214 + [0, 140, 250, 360, 470, 540][i];
        return (
          <g key={i} opacity={o} transform={`translate(${(1 - o) * 20} 0)`}>
            <Txt x={1360} y={y} s={28} f="display" c={C.structure} ls={1}>{e.head}</Txt>
            {e.lines.map((l, j) => <Txt key={j} x={1360} y={y + 34 + j * 30} s={22} c={C.ink}>{l}</Txt>)}
          </g>
        );
      })}
    </Stage>
  );
};

// ---------------------------------------------------------------- 06
export const Ens: React.FC = () => {
  const f = useCurrentFrame();
  const { w } = sceneCtx('06-ens-hierarchy');
  const under = w('batas'), res = w('resolver'), sub = w('subname'), alias = w('alias'), cp = w('counterparty'), links = w('links');
  const node = (x: number, y: number, label: string, at: number, opts: { c?: string; dashed?: boolean; big?: boolean } = {}) => {
    const o = p(f, at, 10);
    const W = opts.big ? 380 : 320;
    return (
      <g opacity={o}>
        <rect x={x - W / 2} y={y - 34} width={W} height={68} rx={3} fill={C.paper} stroke={opts.c ?? C.ink} strokeWidth={opts.big ? 3 : 2} strokeDasharray={opts.dashed ? '10 7' : undefined} />
        <Txt x={x} y={y + 12} s={opts.big ? 38 : 32} w={700} a="middle" c={opts.c ?? C.ink}>{label}</Txt>
      </g>
    );
  };
  return (
    <Stage id="06-ens-hierarchy">
      <Line d="M 960 204 V 266" t={p(f, 6, 10)} c={C.ink} sw={2.5} />
      <Line d="M 960 334 V 396" t={p(f, 14, 10)} c={C.ink} sw={2.5} />
      <Line d="M 960 464 C 960 540, 560 520, 560 590" t={p(f, under + 8, 16)} c={C.ink} sw={2.5} />
      <Line d="M 960 464 C 960 540, 1080 520, 1080 590" t={p(f, sub, 14)} c={C.structure} sw={2.5} dash="10 7" />
      <Line d="M 960 464 C 960 540, 1560 520, 1560 590" t={p(f, sub + 4, 14)} c={C.structure} sw={2.5} dash="10 7" />
      {node(960, 170, '[root]', 0)}
      {node(960, 300, 'eth', 8)}
      {node(960, 430, 'batas.eth', under, { big: true })}
      {node(560, 624, 'agent.batas.eth', under + 10, { big: true, c: C.boundary })}
      {node(1080, 624, 'mandate.batas.eth', alias - 6, { dashed: true, c: C.structure })}
      {node(1560, 624, 'anything.batas.eth', sub, { dashed: true, c: C.structure })}
      <Txt x={1560} y={690} s={22} c={C.structure} a="middle" o={p(f, sub + 6, 10)}>wildcard: no resolver of its own</Txt>

      {/* PermissionedResolver, shared by batas.eth and agent */}
      <g opacity={p(f, res, 10)}>
        <Plate x={1250} y={370} w={620} h={120} />
        <Txt x={1270} y={414} s={32} f="display" c={C.structure} ls={1.2}>PERMISSIONEDRESOLVER</Txt>
        <Txt x={1270} y={452} s={20} f="mono" c={C.dim}>0x671C506Aaa2a123bE802Fe51975Ca9515AEC2516</Txt>
        <Txt x={1270} y={478} s={20} c={C.dim}>name-scoped roles · ENSIP-26 agent records</Txt>
      </g>
      <Line d="M 1150 430 H 1250" t={p(f, res + 4, 8)} c={C.structure} sw={2.5} />

      {/* alias: mandate answers with agent's records */}
      <Line d="M 920 640 C 850 705, 800 704, 782 686" t={p(f, alias, 16)} c={C.boundary} sw={3.5} />
      <polygon points="0,0 -22,-11 -22,11" fill={C.boundary} opacity={p(f, alias + 14, 4)} transform="translate(768 672) rotate(-135)" />
      <Txt x={1080} y={690} s={22} c={C.boundary} a="middle" o={p(f, alias + 8, 10)} w={700}>alias → agent.batas.eth</Txt>

      {/* Enhanced Access Control: one text key delegated */}
      <Line d="M 400 658 C 300 720, 250 740, 250 770" t={p(f, cp, 14)} c={C.caution} sw={2.5} dash="8 6" />
      <g opacity={p(f, cp + 6, 10)}>
        <Plate x={70} y={770} w={470} h={90} />
        <State k="caution" x={100} y={806} r={11} />
        <Txt x={124} y={816} s={28} w={700} c={C.caution}>counterparty account</Txt>
        <Txt x={96} y={848} s={21} f="mono" c={C.ink2}>ROLE_SET_TEXT on one key only</Txt>
      </g>

      {/* ENSIP-25: two-way link to ERC-8004 */}
      <Line d="M 700 658 C 760 760, 900 800, 1060 800" t={p(f, links, 14)} c={C.inside} sw={3.5} />
      {[0, 1].map((k) => {
        const s = ((f - links - 10) / 24 + k * 0.5) % 1;
        if (f < links + 10) return null;
        const tt = k ? 1 - s : s;
        const x = (1 - tt) ** 3 * 700 + 3 * (1 - tt) ** 2 * tt * 760 + 3 * (1 - tt) * tt * tt * 900 + tt ** 3 * 1060;
        const y = (1 - tt) ** 3 * 658 + 3 * (1 - tt) ** 2 * tt * 760 + 3 * (1 - tt) * tt * tt * 800 + tt ** 3 * 800;
        return <circle key={k} cx={x} cy={y} r={9} fill={C.inside} stroke={C.paper} strokeWidth={3} />;
      })}
      <g opacity={p(f, links + 8, 10)}>
        <Plate x={1060} y={752} w={780} h={104} />
        <State k="inside" x={1088} y={790} r={11} />
        <Txt x={1112} y={800} s={30} w={700} c={C.inside}>ERC-8004 agent #10123 · ENSIP-25, both ways</Txt>
        <Txt x={1084} y={840} s={20} f="mono" c={C.dim}>agent-registration[0x0001…a494bd9e][10123] = 1</Txt>
      </g>
    </Stage>
  );
};

// ---------------------------------------------------------------- 07
export const Close: React.FC = () => {
  const f = useCurrentFrame();
  const { w } = sceneCtx('07-close');
  const three = w('three'), live = w('live');
  const tracks = [
    { name: '1INCH AQUA', claim: ['Two new SwapVM instructions,', 'PolicyEnvelope 0x21 and', 'MandateName 0x22, enforce', 'the mandate inside settlement.'] },
    { name: 'ENS', claim: ['Revoke agent.batas.eth on', 'ENSv2 and every swap', 'reverts, for every caller.'] },
    { name: 'HEDERA', claim: ['Agents discover, negotiate,', 'pay over x402 and audit', 'each payment on HCS.'] },
  ];
  return (
    <Stage id="07-close">
      {tracks.map((t, i) => {
        const at = three + 4 + i * 7;
        const x = 130 + i * 575;
        return (
          <g key={t.name}>
            <Line d={`M ${x} 170 H ${x + 520}`} t={p(f, at, 14)} c={C.ink} sw={4} />
            <g opacity={p(f, at + 4, 10)}>
              <rect x={x} y={194} width={14} height={50} fill={C.boundary} />
              <rect x={x + 506} y={194} width={14} height={50} fill={C.boundary} />
              <Txt x={x + 36} y={238} s={54} f="display" ls={2}>{t.name}</Txt>
              {t.claim.map((l, j) => <Txt key={j} x={x} y={320 + j * 46} s={32} c={C.ink2}>{l}</Txt>)}
            </g>
          </g>
        );
      })}
      <g opacity={p(f, live - 2, 12)}>
        <line x1={130} y1={560} x2={1790} y2={560} stroke={C.rule} strokeWidth={1.5} />
        <Mark x={130} y={630} s={150} />
        <Txt x={330} y={712} s={92} w={700} c={C.structure}>batas-one.vercel.app</Txt>
        <Txt x={334} y={780} s={44} f="mono" c={C.ink2}>github.com/PugarHuda/batas</Txt>
      </g>
    </Stage>
  );
};
