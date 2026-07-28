import { describe, expect, it } from 'vitest';
import { formatNowPlaying, parseState } from '../src/plugins/nowplaying/nowplaying.js';

function deck(overrides: Record<string, unknown> = {}) {
    return { onAir: false, track: null, ...overrides };
}

function track(title: string, artist: string) {
    return { title, artist };
}

describe('parseState', () => {
    it('returns an empty list when no deck is on air', () => {
        const body = { decks: { A: deck(), B: deck(), C: deck(), D: deck() } };
        expect(parseState(body)).toEqual([]);
    });

    it('returns the on-air track for a single deck', () => {
        const body = {
            decks: {
                A: deck({ onAir: true, track: track('Night Drive', 'DJ Rae') }),
                B: deck(),
                C: deck(),
                D: deck(),
            },
        };
        expect(parseState(body)).toEqual([{ title: 'Night Drive', artist: 'DJ Rae' }]);
    });

    it('returns on-air tracks for multiple decks in A-D order', () => {
        const body = {
            decks: {
                A: deck({ onAir: true, track: track('Track A', 'Artist A') }),
                B: deck(),
                C: deck({ onAir: true, track: track('Track C', 'Artist C') }),
                D: deck(),
            },
        };
        expect(parseState(body)).toEqual([
            { title: 'Track A', artist: 'Artist A' },
            { title: 'Track C', artist: 'Artist C' },
        ]);
    });

    it('excludes a deck that is on air but has no track', () => {
        const body = {
            decks: {
                A: deck({ onAir: true, track: null }),
                B: deck(),
                C: deck(),
                D: deck(),
            },
        };
        expect(parseState(body)).toEqual([]);
    });

    it('excludes a deck whose track has an empty title', () => {
        const body = {
            decks: {
                A: deck({ onAir: true, track: track('', 'DJ Rae') }),
                B: deck(),
                C: deck(),
                D: deck(),
            },
        };
        expect(parseState(body)).toEqual([]);
    });

    it('ignores unrecognized extra fields (forward compatibility)', () => {
        const body = {
            decks: {
                A: deck({
                    onAir: true,
                    track: { ...track('Night Drive', 'DJ Rae'), bpm: 128, extra: 'x' },
                }),
                B: deck(),
                C: deck(),
                D: deck(),
            },
            history: [],
            mixer: { channels: [] },
            unknownTopLevelField: true,
        };
        expect(parseState(body)).toEqual([{ title: 'Night Drive', artist: 'DJ Rae' }]);
    });

    it.each([
        ['missing decks', {}],
        [
            'a deck missing onAir',
            { decks: { A: { track: null }, B: deck(), C: deck(), D: deck() } },
        ],
        ['non-object JSON', 'not an object'],
        ['an array instead of an object', [1, 2, 3]],
        ['null', null],
    ])('returns null for %s', (_label, body) => {
        expect(parseState(body)).toBeNull();
    });
});

describe('formatNowPlaying', () => {
    it('formats a single track with an artist', () => {
        expect(formatNowPlaying([{ title: 'Night Drive', artist: 'DJ Rae' }])).toBe(
            'DJ Rae - Night Drive',
        );
    });

    it('formats a single track with no artist as title only', () => {
        expect(formatNowPlaying([{ title: 'Night Drive', artist: '' }])).toBe('Night Drive');
    });

    it('joins multiple decks with " / "', () => {
        expect(
            formatNowPlaying([
                { title: 'Track A', artist: 'Artist A' },
                { title: 'Track C', artist: '' },
            ]),
        ).toBe('Artist A - Track A / Track C');
    });
});
