import { describe, expect, it } from 'vitest';
import { isAllowed, resolveRoles } from '../src/core/permissions.js';
import type { Role } from '../src/core/types.js';

describe('resolveRoles', () => {
  it('always includes everyone', () => {
    expect(resolveRoles({}).has('everyone')).toBe(true);
  });

  it('maps known badges to roles', () => {
    expect(resolveRoles({ broadcaster: '1' }).has('broadcaster')).toBe(true);
    expect(resolveRoles({ moderator: '1' }).has('moderator')).toBe(true);
    expect(resolveRoles({ vip: '1' }).has('vip')).toBe(true);
    expect(resolveRoles({ subscriber: '12' }).has('subscriber')).toBe(true);
  });

  it('treats founder as subscriber', () => {
    expect(resolveRoles({ founder: '0' }).has('subscriber')).toBe(true);
  });

  it('ignores unknown badges', () => {
    expect([...resolveRoles({ glitchcon2020: '1', 'clip-the-halls-2019': '1' })]).toEqual([
      'everyone',
    ]);
  });
});

describe('isAllowed', () => {
  const allowPrivileged: Role[] = ['broadcaster', 'moderator', 'vip', 'subscriber'];

  it('opens to all when allow includes everyone', () => {
    expect(isAllowed(new Set<Role>(['everyone']), ['everyone'])).toBe(true);
  });

  it('permits on a role intersection', () => {
    expect(isAllowed(new Set<Role>(['everyone', 'subscriber']), allowPrivileged)).toBe(true);
    expect(isAllowed(new Set<Role>(['everyone', 'moderator']), allowPrivileged)).toBe(true);
  });

  it('denies a plain viewer against a privileged allow-list', () => {
    expect(isAllowed(new Set<Role>(['everyone']), allowPrivileged)).toBe(false);
  });

  it('denies against an empty allow-list', () => {
    expect(isAllowed(new Set<Role>(['everyone', 'broadcaster']), [])).toBe(false);
  });
});
