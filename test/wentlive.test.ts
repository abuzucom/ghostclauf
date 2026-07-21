import { describe, expect, it } from 'vitest';
import wentlive, { formatTimestamp, renderAnnouncement } from '../src/plugins/wentlive/index.js';
import type { StreamOnlineEvent } from '../src/core/types.js';
import { flush, makeHarness } from './helpers.js';

const STARTED_AT = new Date('2026-07-12T18:04:05.000Z');

function onlineEvent(displayName = 'SomeStreamer'): StreamOnlineEvent {
  return {
    broadcasterId: '1',
    broadcasterName: 'somestreamer',
    broadcasterDisplayName: displayName,
    startedAt: STARTED_AT,
  };
}

describe('wentlive helpers', () => {
  it('formats ISO and UTC timestamps', () => {
    expect(formatTimestamp(STARTED_AT, 'iso')).toBe('2026-07-12T18:04:05.000Z');
    expect(formatTimestamp(STARTED_AT, 'utc')).toBe(STARTED_AT.toUTCString());
  });

  it('substitutes template tokens', () => {
    expect(renderAnnouncement('{streamer} up at {timestamp}', 'Foo', STARTED_AT, 'iso')).toBe(
      'Foo up at 2026-07-12T18:04:05.000Z',
    );
  });
});

describe('wentlive plugin', () => {
  it('announces with the default template on stream online', async () => {
    const { bus, say, ctx } = makeHarness('wentlive');
    await wentlive.init(ctx);
    bus.emit('streamOnline', onlineEvent('SomeStreamer'));
    await flush();
    expect(say).toHaveBeenCalledWith(
      'SomeStreamer has gone live at 2026-07-12T18:04:05.000Z',
      undefined,
      '1',
    );
  });

  it('respects a configured template and UTC format', async () => {
    const { bus, say, ctx } = makeHarness('wentlive', {
      template: '{streamer} @ {timestamp}',
      timestampFormat: 'utc',
    });
    await wentlive.init(ctx);
    bus.emit('streamOnline', onlineEvent('Foo'));
    await flush();
    expect(say).toHaveBeenCalledWith(`Foo @ ${STARTED_AT.toUTCString()}`, undefined, '1');
  });

  it('does not repeat an announcement for recovered live state', async () => {
    const { bus, say, ctx } = makeHarness('wentlive');
    await wentlive.init(ctx);
    bus.emit('streamOnline', { ...onlineEvent(), recovered: true });
    await flush();
    expect(say).not.toHaveBeenCalled();
  });
});
