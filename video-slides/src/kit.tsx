import React from 'react';
import { AbsoluteFill, continueRender, delayRender, staticFile, useCurrentFrame, interpolate, Easing } from 'remotion';
import { Cue, SCENES, timeScene, wordAt } from './narration';

export const C = {
  ground: '#f3f6f4', paper: '#fbfcfb', sunk: '#e9eeeb', ink: '#0f1a22', ink2: '#33414d', dim: '#56636f',
  rule: '#d2dad5', grid: '#e3e9e5', edge: '#a9b5ae', boundary: '#a0146c', bsoft: '#f6e3ee',
  structure: '#1b4d99', inside: '#17753b', caution: '#8f5c00', cfill: '#f0b429', never: '#c0141a', unread: '#98a49e',
};
export const F = { display: '"Barlow Condensed", sans-serif', text: 'B612, sans-serif', mono: '"B612 Mono", monospace' };

const faces: [string, string, string][] = [
  ['B612', 'b612-400', '400'], ['B612', 'b612-700', '700'], ['B612 Mono', 'b612-mono-400', '400'], ['Barlow Condensed', 'barlow-condensed-700', '700'],
];
if (typeof document !== 'undefined') {
  const h = delayRender('fonts');
  Promise.all(faces.map(([fam, file, weight]) =>
    new FontFace(fam, `url(${staticFile(file + '.woff2')})`, { weight }).load().then((ff) => document.fonts.add(ff)),
  )).then(() => continueRender(h));
}

export const p = (f: number, s: number, d = 20) =>
  interpolate(f, [s, s + d], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.2, 0.7, 0.2, 1) });

export const qp = (a: number[], c: number[], b: number[], t: number) =>
  [0, 1].map((i) => (1 - t) * (1 - t) * a[i] + 2 * (1 - t) * t * c[i] + t * t * b[i]);

export const Txt: React.FC<{
  x: number; y: number; s: number; f?: keyof typeof F; c?: string; w?: number; a?: 'start' | 'middle' | 'end'; o?: number; ls?: number; halo?: boolean; children: React.ReactNode;
}> = ({ x, y, s, f = 'text', c = C.ink, w, a = 'start', o = 1, ls = 0, halo, children }) => (
  <text x={x} y={y} fontSize={s} fontFamily={F[f]} fill={c} fontWeight={w ?? (f === 'display' ? 700 : 400)}
    textAnchor={a} opacity={o} letterSpacing={ls} stroke={halo ? C.ground : undefined} strokeWidth={halo ? 18 : undefined} strokeLinejoin="round" paintOrder="stroke" style={{ fontVariantNumeric: 'tabular-nums lining-nums' }}>{children}</text>
);

// A line that draws on. Dashed lines are revealed through a mask so the dash pattern survives.
export const Line: React.FC<{ d: string; t: number; c?: string; sw?: number; dash?: string; o?: number }> = ({ d, t, c = C.ink, sw = 2, dash, o = 1 }) => {
  const id = 'm' + React.useId().replace(/:/g, '');
  if (t <= 0) return null;
  if (!dash) return <path d={d} fill="none" stroke={c} strokeWidth={sw} opacity={o} pathLength={1} strokeDasharray={1} strokeDashoffset={1 - t} />;
  return (
    <g>
      <mask id={id} maskUnits="userSpaceOnUse" x={0} y={0} width={1920} height={1080}>
        <path d={d} fill="none" stroke="#fff" strokeWidth={sw + 10} pathLength={1} strokeDasharray={1} strokeDashoffset={1 - t} />
      </mask>
      <path d={d} fill="none" stroke={c} strokeWidth={sw} strokeDasharray={dash} opacity={o} mask={`url(#${id})`} />
    </g>
  );
};

// Airspeed-indicator states: never colour alone. Disc inside, open square caution, drawn cross never.
export const State: React.FC<{ k: 'inside' | 'caution' | 'never'; x: number; y: number; r?: number }> = ({ k, x, y, r = 11 }) =>
  k === 'inside' ? <circle cx={x} cy={y} r={r} fill={C.inside} />
    : k === 'caution' ? <rect x={x - r} y={y - r} width={2 * r} height={2 * r} fill="none" stroke={C.caution} strokeWidth={3.5} rx={2} />
      : <g stroke={C.never} strokeWidth={4.5}><line x1={x - r} y1={y - r} x2={x + r} y2={y + r} /><line x1={x - r} y1={y + r} x2={x + r} y2={y - r} /></g>;

export const Mark: React.FC<{ x: number; y: number; s: number }> = ({ x, y, s }) => (
  <g transform={`translate(${x},${y}) scale(${s / 32})`}>
    <rect x={1} y={1} width={30} height={30} rx={3} fill="none" stroke={C.ink} strokeWidth={1.5} />
    <rect x={7} y={8} width={2.6} height={16} fill={C.boundary} />
    <rect x={22.4} y={8} width={2.6} height={16} fill={C.boundary} />
    <rect x={12} y={14.7} width={7.5} height={2.6} fill={C.ink} />
  </g>
);

// VOR compass rose: a navaid, so it is drawn in structure blue, faint, and never behind text.
export const Rose: React.FC<{ cx: number; cy: number; r: number; start?: number; o?: number }> = ({ cx, cy, r, start = 0, o = 0.3 }) => {
  const f = useCurrentFrame();
  const t = p(f, start, 36);
  const rot = interpolate(t, [0, 1], [-35, 0]);
  return (
    <g opacity={o} transform={`rotate(${rot} ${cx} ${cy})`}>
      <Line d={`M ${cx} ${cy - r} a ${r} ${r} 0 1 1 -0.1 0`} t={t} c={C.structure} sw={2.5} />
      <Line d={`M ${cx} ${cy - r * 0.62} a ${r * 0.62} ${r * 0.62} 0 1 1 -0.1 0`} t={t} c={C.structure} sw={1.5} />
      {Array.from({ length: 72 }, (_, i) => {
        if (i / 72 > t) return null;
        const a = (i * 5 * Math.PI) / 180, len = i % 6 === 0 ? 30 : i % 2 === 0 ? 16 : 9;
        return <line key={i} x1={cx + Math.sin(a) * r} y1={cy - Math.cos(a) * r} x2={cx + Math.sin(a) * (r - len)} y2={cy - Math.cos(a) * (r - len)} stroke={C.structure} strokeWidth={i % 6 === 0 ? 3 : 1.6} />;
      })}
      {Array.from({ length: 12 }, (_, i) => {
        const a = (i * 30 * Math.PI) / 180;
        return (
          <text key={i} x={cx + Math.sin(a) * (r - 58)} y={cy - Math.cos(a) * (r - 58) + 10} fontSize={28} fontFamily={F.text} fontWeight={700}
            fill={C.structure} textAnchor="middle" opacity={p(f, start + 10 + i * 1.5, 12)}
            transform={`rotate(${i * 30} ${cx + Math.sin(a) * (r - 58)} ${cy - Math.cos(a) * (r - 58)})`}>{i === 0 ? 'N' : i * 3}</text>
        );
      })}
    </g>
  );
};

const Chart: React.FC<{ n: number; title: string }> = ({ n, title }) => {
  const f = useCurrentFrame();
  const xs = [160, 480, 800, 1120, 1440, 1760], ys = [160, 400, 640];
  return (
    <g>
      {xs.map((x, i) => <Line key={'x' + i} d={`M ${x} 24 V 1056`} t={p(f, i * 1.5, 24)} c={C.grid} sw={2} />)}
      {ys.map((y, i) => <Line key={'y' + i} d={`M 24 ${y} H 1896`} t={p(f, 3 + i * 1.5, 24)} c={C.grid} sw={2} />)}
      <rect x={24} y={24} width={1872} height={1032} fill="none" stroke={C.rule} strokeWidth={1.5} />
      {Array.from({ length: 78 }, (_, i) => <line key={'t' + i} x1={24 + i * 24} y1={24} x2={24 + i * 24} y2={i % 5 === 0 ? 38 : 31} stroke={C.edge} strokeWidth={1.2} />)}
      {Array.from({ length: 36 }, (_, i) => <line key={'l' + i} x1={24} y1={24 + i * 24} x2={i % 5 === 0 ? 38 : 31} y2={24 + i * 24} stroke={C.edge} strokeWidth={1.2} />)}
      <Mark x={66} y={52} s={42} />
      <Txt x={124} y={88} s={40} f="display" ls={3}>BATAS</Txt>
      {title !== 'Batas' && <line x1={238} y1={56} x2={238} y2={92} stroke={C.rule} strokeWidth={2} />}
      {title !== 'Batas' && <Txt x={260} y={88} s={40} f="display" c={C.ink2} ls={1.5}>{title.toUpperCase()}</Txt>}
      <Txt x={1850} y={86} s={26} f="mono" c={C.dim} a="end">{String(n).padStart(2, '0')} / 07</Txt>
    </g>
  );
};

function rows(cue: Cue): { i: number; text: string }[][] {
  // balanced wrap: two rows of similar length rather than a long row and an orphan; never a third row
  const balanced = wrap(cue, Math.max(Math.ceil(cue.text.length / 2) + 3, ...cue.words.map((w) => w.text.length)));
  return cue.text.length > 42 && balanced.length <= 2 ? balanced : wrap(cue, 42);
}

function wrap(cue: Cue, max: number) {
  const out: { i: number; text: string }[][] = [[]];
  let len = 0;
  cue.words.forEach((w, i) => {
    if (len && len + 1 + w.text.length > max) { out.push([]); len = 0; }
    out[out.length - 1].push({ i, text: w.text });
    len += (len ? 1 : 0) + w.text.length;
  });
  return out;
}

const Karaoke: React.FC<{ cues: Cue[] }> = ({ cues }) => {
  const f = useCurrentFrame();
  let k = 0;
  cues.forEach((c, i) => { if (f >= c.start - 4) k = i; });
  const cue = cues[k];
  return (
    <div style={{
      position: 'absolute', left: 0, right: 0, bottom: 0, height: 196, background: C.paper, borderTop: `2px solid ${C.ink}`,
      display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: 6,
      fontFamily: F.text, fontWeight: 700, fontSize: 54, lineHeight: 1.22,
    }}>
      {rows(cue).map((r, ri) => (
        <div key={ri} style={{ whiteSpace: 'nowrap' }}>
          {r.map(({ i, text }) => {
            const w = cue.words[i];
            const now = f >= w.start && f < w.end;
            return (
              <span key={i} style={{
                color: now ? C.boundary : f >= w.end ? C.ink : C.unread,
                textDecoration: now ? `underline ${C.boundary} 5px` : 'none', textUnderlineOffset: 10,
              }}>{text}{' '}</span>
            );
          })}
        </div>
      ))}
    </div>
  );
};

export type SceneCtx = { cues: Cue[]; w: (word: string, nth?: number) => number; dur: number };

export function sceneCtx(id: string): SceneCtx {
  const s = SCENES.find((x) => x.id === id)!;
  const { cues, duration } = timeScene(s.en);
  return { cues, dur: duration, w: (word, nth) => wordAt(cues, word, nth) };
}

export const Stage: React.FC<{ id: string; children: React.ReactNode }> = ({ id, children }) => {
  const i = SCENES.findIndex((x) => x.id === id);
  const { cues } = sceneCtx(id);
  return (
    <AbsoluteFill style={{ background: C.ground }}>
      <svg width={1920} height={1080} viewBox="0 0 1920 1080" style={{ position: 'absolute', inset: 0 }}>
        <Chart n={i + 1} title={SCENES[i].title} />
        {children}
      </svg>
      <Karaoke cues={cues} />
    </AbsoluteFill>
  );
};
