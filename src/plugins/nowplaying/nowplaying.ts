// Pure parsing/formatting logic for the nowplaying plugin, kept free of I/O
// so it is directly unit-testable without a network call.
//
// The schema below intentionally covers only the fields this plugin uses. It
// is not a mirror of 1a2n-track-id's internal ClientSnapshot type — that repo
// is separately versioned and pre-1.0, so its response shape is not a
// contract ghostclauf controls. Zod ignores unrecognized fields by default,
// so additive changes on their side never break parsing here.

import { z } from 'zod';

const DeckSchema = z.object({
  onAir: z.boolean(),
  track: z.object({ title: z.string(), artist: z.string() }).nullable(),
});

const StateSchema = z.object({
  decks: z.object({
    A: DeckSchema,
    B: DeckSchema,
    C: DeckSchema,
    D: DeckSchema,
  }),
});

export interface OnAirTrack {
  title: string;
  artist: string;
}

/**
 * Extract the on-air tracks from a fetched /state JSON body, in deck order
 * A through D. Returns null when the body does not match the expected shape
 * (caller treats that the same as "server unreachable").
 */
export function parseState(json: unknown): OnAirTrack[] | null {
  const parsed = StateSchema.safeParse(json);
  if (!parsed.success) return null;

  const tracks: OnAirTrack[] = [];
  for (const deck of Object.values(parsed.data.decks)) {
    if (!deck.onAir || !deck.track || !deck.track.title) continue;
    tracks.push({ title: deck.track.title, artist: deck.track.artist });
  }
  return tracks;
}

/** Format on-air tracks as "Artist - Title", joining multiple decks with " / ". */
export function formatNowPlaying(tracks: readonly OnAirTrack[]): string {
  return tracks
    .map(({ title, artist }) => (artist ? `${artist} - ${title}` : title))
    .join(' / ');
}
