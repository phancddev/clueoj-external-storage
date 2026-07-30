import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export type ByteInput = number | string | bigint | null | undefined;

export function toBigIntBytes(bytes: ByteInput): bigint | null {
  if (bytes == null) return null;
  if (typeof bytes === 'bigint') return bytes >= 0n ? bytes : null;
  if (typeof bytes === 'number') {
    if (!Number.isFinite(bytes) || bytes < 0 || !Number.isSafeInteger(bytes)) return null;
    return BigInt(bytes);
  }
  if (!/^\d+$/.test(bytes)) return null;
  return BigInt(bytes);
}

export function addBytes(values: ByteInput[]): bigint | null {
  let total = 0n;
  for (const value of values) {
    const parsed = toBigIntBytes(value);
    if (parsed == null) return null;
    total += parsed;
  }
  return total;
}

export function subtractBytes(left: ByteInput, right: ByteInput): bigint | null {
  const a = toBigIntBytes(left);
  const b = toBigIntBytes(right);
  if (a == null || b == null || b > a) return null;
  return a - b;
}

export function bytePercent(used: ByteInput, total: ByteInput): number | null {
  const usedBytes = toBigIntBytes(used);
  const totalBytes = toBigIntBytes(total);
  if (usedBytes == null || totalBytes == null || totalBytes === 0n) return null;
  return Number((usedBytes * 10_000n) / totalBytes) / 100;
}

export function formatBytes(bytes: ByteInput, decimals = 1): string {
  const parsed = toBigIntBytes(bytes);
  if (parsed == null) return '—';
  if (parsed === 0n) return '0 B';
  const k = 1024n;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let unit = 0;
  let divisor = 1n;
  while (unit < sizes.length - 1 && parsed >= divisor * k) {
    divisor *= k;
    unit += 1;
  }
  if (unit === 0) return `${parsed.toLocaleString('en-US')} B`;
  const scale = 10n ** BigInt(decimals);
  const scaled = (parsed * scale * 10n / divisor + 5n) / 10n;
  const whole = scaled / scale;
  const fraction = scaled % scale;
  const fractionText = decimals > 0
    ? fraction.toString().padStart(decimals, '0').replace(/0+$/, '')
    : '';
  return `${whole.toLocaleString('en-US')}${fractionText ? `.${fractionText}` : ''} ${sizes[unit]}`;
}

export function formatNumber(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString('en-US');
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const diff = Date.now() - d.getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
