import { describe, it, expect } from 'vitest';
import { addBytes, bytePercent, formatBytes, formatNumber, formatDateTime, formatRelative, subtractBytes } from '../lib/utils';

describe('formatBytes', () => {
  it('formats zero', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats null/undefined', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
  });

  it('formats bytes', () => {
    expect(formatBytes(500)).toBe('500 B');
  });

  it('formats KB', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('formats MB', () => {
    expect(formatBytes(1048576)).toBe('1 MB');
  });

  it('formats GB', () => {
    expect(formatBytes(1073741824)).toBe('1 GB');
  });

  it('formats byte strings above Number.MAX_SAFE_INTEGER without precision loss', () => {
    expect(formatBytes('9007199254740993', 0)).toBe('8 PB');
  });

  it('sums and subtracts byte strings with bigint helpers', () => {
    expect(addBytes(['9007199254740993', '7'])?.toString()).toBe('9007199254741000');
    expect(subtractBytes('100', '45')?.toString()).toBe('55');
    expect(bytePercent('25', '200')).toBe(12.5);
  });

  it('respects decimals', () => {
    expect(formatBytes(1500, 2)).toBe('1.46 KB');
  });
});

describe('formatNumber', () => {
  it('formats null', () => {
    expect(formatNumber(null)).toBe('—');
  });

  it('formats numbers with locale', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
  });
});

describe('formatDateTime', () => {
  it('formats null', () => {
    expect(formatDateTime(null)).toBe('—');
  });

  it('formats ISO string', () => {
    const result = formatDateTime('2024-01-15T10:30:00Z');
    expect(result).toContain('2024-01-15');
    expect(result).toContain('10:30:00');
    expect(result).toContain('UTC');
  });

  it('handles invalid date', () => {
    expect(formatDateTime('not-a-date')).toBe('—');
  });
});

describe('formatRelative', () => {
  it('formats null', () => {
    expect(formatRelative(null)).toBe('—');
  });

  it('formats seconds ago', () => {
    const now = new Date(Date.now() - 30_000).toISOString();
    expect(formatRelative(now)).toContain('s ago');
  });

  it('formats minutes ago', () => {
    const now = new Date(Date.now() - 300_000).toISOString();
    expect(formatRelative(now)).toContain('m ago');
  });

  it('formats hours ago', () => {
    const now = new Date(Date.now() - 7_200_000).toISOString();
    expect(formatRelative(now)).toContain('h ago');
  });

  it('formats days ago', () => {
    const now = new Date(Date.now() - 172_800_000).toISOString();
    expect(formatRelative(now)).toContain('d ago');
  });
});
