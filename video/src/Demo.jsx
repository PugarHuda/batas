import React, { useMemo } from 'react';
import { AbsoluteFill, Sequence, OffthreadVideo, Freeze, staticFile, useCurrentFrame } from 'remotion';
import { timeline } from './timing.mjs';
import { FPS } from './scenes.mjs';
import { ROWS, PRIZES } from './rows.mjs';
import { CAPTURES, CLIP_SECONDS } from './captures.js';
import { prepare, rowsAt, cutShowing, TYPE_MS } from './terminal.mjs';

// agent/world.mjs tokens, so the video sits in the page's light aeronautical-chart world.
const C = {
    ground: '#f3f6f4', paper: '#fbfcfb', sunk: '#e9eeeb', ink: '#0f1a22', ink2: '#33414d', dim: '#56636f',
    rule: '#d2dad5', grid: '#e3e9e5', edge: '#a9b5ae', boundary: '#a0146c', boundarySoft: '#f6e3ee',
    structure: '#1b4d99', inside: '#17753b', caution: '#8f5c00', never: '#c0141a',
};
const DISPLAY = '"Barlow Condensed", "Arial Narrow", sans-serif';
const TEXT = 'B612, "Segoe UI", sans-serif';
const MONO = '"B612 Mono", Consolas, monospace';
const SHADOW = '0 1px 1px rgb(15 26 34 / .06), 0 12px 32px -18px rgb(15 26 34 / .28)';

// The frame is split into three bands that never overlap: requirement captions on top, footage in the
// middle, subtitles at the bottom. Subtitles therefore cannot cover a number on screen.
const TOP = 112;
const MEDIA_H = 768;
const SUB_Y = TOP + MEDIA_H;
const PRIZE_COLOR = { hedera: C.structure, oneinch: C.boundary, ens: C.inside };

const T = timeline();

const TopBar = ({ scene, rows }) => (
    <div style={{ position: 'absolute', left: 0, top: 0, width: 1920, height: TOP, borderBottom: `1px solid ${C.rule}`, background: C.paper, display: 'flex', alignItems: 'center', padding: '0 56px', boxSizing: 'border-box', gap: 32 }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rows.length === 0 ? (
                <div style={{ font: `700 44px/1 ${DISPLAY}`, letterSpacing: '.06em', textTransform: 'uppercase', color: C.ink }}>Batas <span style={{ color: C.boundary }}>· a mandate a machine enforces</span></div>
            ) : rows.slice(0, 2).map((id) => {
                const r = ROWS.find((x) => x.id === id);
                return (
                    <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 16, height: rows.length > 1 ? 40 : 56 }}>
                        <span style={{ font: `700 ${rows.length > 1 ? 20 : 24}px/1 ${DISPLAY}`, letterSpacing: '.08em', textTransform: 'uppercase', color: '#fff', background: PRIZE_COLOR[r.prize], padding: '6px 10px', whiteSpace: 'nowrap' }}>{PRIZES[r.prize]}</span>
                        <span style={{ font: `700 ${rows.length > 1 ? 27 : 32}px/1.1 ${TEXT}`, color: C.ink }}>{r.caption}</span>
                    </div>
                );
            })}
        </div>
        <div style={{ textAlign: 'right', font: `400 20px/1.3 ${MONO}`, color: C.dim }}>
            <div>{String(scene.index + 1).padStart(2, '0')} / {T.scenes.length}</div>
            <div style={{ color: C.ink2 }}>{scene.title}</div>
        </div>
    </div>
);

const Frame = ({ w, h, children }) => (
    <div style={{ position: 'absolute', top: TOP + (MEDIA_H - h) / 2, left: (1920 - w) / 2, width: w, height: h, overflow: 'hidden', border: `1px solid ${C.edge}`, boxShadow: SHADOW, background: C.paper }}>{children}</div>
);

const Footage = ({ shot }) => {
    const frame = useCurrentFrame();
    const z = shot.zoom ?? { x: 0, y: 0, w: 1920, h: 1080 };
    const s = Math.min((1920 - 40) / z.w, (MEDIA_H - 24) / z.h);
    const lastLocal = Math.max(0, Math.floor((CLIP_SECONDS[shot.clip] - shot.from) * FPS));
    const video = (
        <OffthreadVideo muted src={staticFile(`footage/${shot.clip}.mp4`)} startFrom={Math.round(shot.from * FPS)}
            style={{ position: 'absolute', left: -z.x * s, top: -z.y * s, width: 1920 * s, height: 1080 * s }} />
    );
    return (
        <Frame w={Math.round(z.w * s)} h={Math.round(z.h * s)}>
            {frame > lastLocal ? <Freeze frame={lastLocal}>{video}</Freeze> : video}
        </Frame>
    );
};

const VIEW = 24;
const rowColor = (r) => (/✔|\bPASS\b|VERIFIED|passed|settled|vouches\s+true|linked/.test(r) ? C.inside : /refused|Mandate[A-Z]\w+|not verified/.test(r) ? C.boundary : C.ink);

const Terminal = ({ shot }) => {
    const frame = useCurrentFrame();
    const p = useMemo(() => prepare(CAPTURES[shot.term]), [shot.term]);
    // `hold` returns to a run the previous shot already played, so it opens on the finished output
    // rather than replaying the same command a second time.
    const ms = (frame / FPS) * 1000 + (shot.hold ? p.doneAt : 0);
    const command = `${shot.env ? `${shot.env} ` : ''}${p.command}`;
    const typed = command.slice(0, Math.ceil(command.length * Math.min(1, ms / (TYPE_MS - 250))));
    const rows = rowsAt(p, ms);
    const all = [null, ...rows];
    const top = shot.pin != null ? Math.min(shot.pin, Math.max(0, all.length - VIEW)) : Math.max(0, all.length - VIEW);
    const stamp = p.startedAt.replace('T', ' ').slice(0, 19);
    return (
        <Frame w={1840} h={MEDIA_H - 24}>
            <div style={{ height: 52, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px', borderBottom: `1px solid ${C.rule}`, background: C.sunk, font: `400 19px/1 ${MONO}`, color: C.dim }}>
                <span>batas · terminal</span>
                <span>
                    {cutShowing(p, ms) ? <span style={{ color: '#fff', background: C.caution, padding: '4px 10px', marginRight: 16 }}>wait trimmed</span> : null}
                    recorded {stamp} UTC · real pace, silences over 1.5 s shortened
                </span>
            </div>
            {/* A terminal face for the output itself: B612 Mono gives punctuation a full cell, so "0.0.10388560" read as if spaces had been added to what the command printed. */}
            <div style={{ padding: '14px 24px', font: '400 23px/28px Consolas, "DejaVu Sans Mono", monospace', whiteSpace: 'pre', color: C.ink }}>
                {all.slice(top, top + VIEW).map((r, i) => (r === null
                    ? <div key={i}><span style={{ color: C.boundary }}>$ </span>{typed}{ms < TYPE_MS ? <span style={{ background: C.ink }}> </span> : null}</div>
                    : <div key={i} style={{ color: rowColor(r) }}>{r || ' '}</div>))}
            </div>
        </Frame>
    );
};

const Card = () => (
    <AbsoluteFill style={{ top: TOP, height: MEDIA_H, alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ background: C.paper, border: `1px solid ${C.edge}`, boxShadow: SHADOW, padding: '64px 96px', textAlign: 'center' }}>
            <div style={{ font: `700 150px/1 ${DISPLAY}`, letterSpacing: '.06em', textTransform: 'uppercase', color: C.ink }}>Batas</div>
            <div style={{ font: `400 30px/1.4 ${TEXT}`, color: C.ink2, marginTop: 18 }}>The agent trades. The settlement holds the limits. The maker takes the authority back.</div>
            <div style={{ font: `700 34px/1.6 ${MONO}`, color: C.boundary, marginTop: 36 }}>batas-one.vercel.app</div>
            <div style={{ font: `400 30px/1.6 ${MONO}`, color: C.structure }}>github.com/PugarHuda/batas · open source</div>
            <div style={{ font: `400 22px/1.6 ${MONO}`, color: C.dim, marginTop: 20 }}>ETHOnline 2026 · this video {Math.floor(T.totalFrames / FPS / 60)}:{String(Math.round(T.totalFrames / FPS) % 60).padStart(2, '0')}, real footage, no speed-ups</div>
        </div>
    </AbsoluteFill>
);

const Subtitles = ({ scene }) => {
    const t = (useCurrentFrame() + scene.startFrame) / FPS;
    const cue = [...scene.cues].reverse().find((c) => c.start <= t) ?? scene.cues[0];
    return (
        <div style={{ position: 'absolute', left: 0, top: SUB_Y, width: 1920, height: 1080 - SUB_Y, background: C.paper, borderTop: `1px solid ${C.rule}`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            {cue.lines.map((line, i) => (
                <div key={i} style={{ font: `700 50px/72px ${TEXT}`, whiteSpace: 'nowrap' }}>
                    {line.map((w, j) => {
                        const now = t >= w.start && t < w.end;
                        const read = t >= w.end;
                        return (
                            <span key={j} style={{ color: now ? C.boundary : read ? C.structure : C.dim, background: now ? C.boundarySoft : 'transparent', borderBottom: now ? `4px solid ${C.boundary}` : '4px solid transparent', padding: '0 6px' }}>{w.text}</span>
                        );
                    })}
                </div>
            ))}
        </div>
    );
};

const Shot = ({ scene, shot }) => (
    <AbsoluteFill>
        {shot.clip ? <Footage shot={shot} /> : shot.term ? <Terminal shot={shot} /> : <Card />}
        <TopBar scene={scene} rows={shot.rows ?? []} />
    </AbsoluteFill>
);

export const Demo = () => (
    <AbsoluteFill style={{ background: C.ground, backgroundImage: `linear-gradient(${C.grid} 1px, transparent 1px), linear-gradient(90deg, ${C.grid} 1px, transparent 1px)`, backgroundSize: '48px 48px' }}>
        {T.scenes.map((scene) => (
            <React.Fragment key={scene.id}>
                {scene.shots.map((shot, i) => (
                    <Sequence key={i} from={shot.startFrame} durationInFrames={shot.durFrames} layout="none">
                        <Shot scene={scene} shot={shot} />
                    </Sequence>
                ))}
                <Sequence from={scene.startFrame} durationInFrames={scene.durFrames} layout="none">
                    <Subtitles scene={scene} />
                </Sequence>
            </React.Fragment>
        ))}
    </AbsoluteFill>
);
