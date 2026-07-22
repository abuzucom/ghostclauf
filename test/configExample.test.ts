// Guard against config.example.yaml drifting into an unparseable state
// (e.g. duplicate map keys), which would crash anyone who copies it.

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

describe('config.example.yaml', () => {
  it('parses as strict YAML', () => {
    const raw = readFileSync('config.example.yaml', 'utf8');
    const config = parse(raw) as Record<string, any>;
    expect(config.plugins).toBeDefined();
    expect(Array.isArray(config.plugins.enabled)).toBe(true);
  });

  it('has a config block only for known enabled plugins', () => {
    const raw = readFileSync('config.example.yaml', 'utf8');
    const config = parse(raw) as Record<string, any>;
    const enabled = new Set<string>(config.plugins.enabled);
    for (const name of Object.keys(config.plugins.config ?? {})) {
      expect(enabled.has(name)).toBe(true);
    }
  });
});
