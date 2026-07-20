// Internal types for the streak (attendance / watch-streak) plugin.
// These are NOT part of the public BotContext contract; they describe this
// plugin's own config block and on-disk state.

/** Configurable trigger words (without the command prefix). */
export interface StreakTriggers {
  checkin: string;
  streak: string;
  reset: string;
  set: string;
  open: string;
}

/** Message templates. Tokens: {user}, {streak}, {longest}, {day}. */
export interface StreakMessages {
  started: string;
  extended: string;
  already: string;
  notOpen: string;
  lookupSelf: string;
  lookupOther: string;
  lookupNone: string;
  reset: string;
  setDone: string;
  opened: string;
  adminUsage: string;
  adminNotFound: string;
}

/** The plugin's config block (`plugins.config.streak`), all optional. */
export interface StreakConfig {
  dataPath?: string;
  timezone?: string;
  requireStreamDay?: boolean;
  triggers?: Partial<StreakTriggers>;
  messages?: Partial<StreakMessages>;
}

/** Per-viewer streak record, keyed by chatterId within a channel. */
export interface ViewerRecord {
  /** Chatter login (lowercase), kept so admin commands can target @user. */
  chatterName: string;
  /** Most recent display name, for friendly replies. */
  displayName: string;
  currentStreak: number;
  longestStreak: number;
  /** Stream-day key (YYYY-MM-DD) of the last counted check-in, or null. */
  lastCheckinDay: string | null;
  totalCheckins: number;
}

/** Per-channel state, keyed by broadcasterId. */
export interface ChannelRecord {
  /** Ordered, deduped stream-day keys (ascending). */
  streamDays: string[];
  /** Viewer records keyed by chatterId. */
  viewers: Record<string, ViewerRecord>;
}

/** Versioned on-disk shape. */
export interface StreakData {
  version: 1;
  channels: Record<string, ChannelRecord>;
}

/** Outcome of applying a check-in to a viewer record. */
export type CheckinOutcome = 'started' | 'extended' | 'already';
