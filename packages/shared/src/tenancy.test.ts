import { describe, expect, it } from 'vitest';
import { businessHostname, isValidSlug, locationHostname, normalizeHostname } from './tenancy';

describe('slug', () => {
  it('приема валидни', () => {
    for (const s of ['hasan', 'sladkarnica-f', 'a', 'x1']) expect(isValidSlug(s)).toBe(true);
  });
  it('отхвърля невалидни', () => {
    for (const s of ['', '-a', 'a-', 'A', 'a_b', 'а', 'a--b', 'x'.repeat(33)]) expect(isValidSlug(s)).toBe(false);
  });
});

describe('hostname', () => {
  it('строи поддомейни на едно ниво', () => {
    expect(businessHostname('hasan', 'Example.bg')).toBe('hasan.example.bg');
    expect(locationHostname('hasan', 'center', 'example.bg')).toBe('hasan--center.example.bg');
  });
  it('нормализира', () => {
    expect(normalizeHostname('Hasan.Example.BG:8080')).toBe('hasan.example.bg');
    expect(normalizeHostname('hasan.example.bg.')).toBe('hasan.example.bg');
  });
});
