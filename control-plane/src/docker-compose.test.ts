import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

const composePath = resolve(__dirname, '../../docker-compose.yml');
const compose = parseYaml(readFileSync(composePath, 'utf-8'));

const clueojComposePath = resolve(__dirname, '../../../clueoj/docker-compose.yml');
const clueojCompose = parseYaml(readFileSync(clueojComposePath, 'utf-8'));

describe('storage app docker-compose.yml', () => {
  it('has storage-db service with healthcheck and volume', () => {
    const svc = compose.services['storage-db'];
    expect(svc).toBeDefined();
    expect(svc.image).toContain('postgres');
    expect(svc.healthcheck).toBeDefined();
    expect(svc.volumes).toBeDefined();
  });

  it('has storage-migrate one-shot service', () => {
    const svc = compose.services['storage-migrate'];
    expect(svc).toBeDefined();
    expect(svc.restart).toBe('no');
  });

  it('storage-rust has no host port published', () => {
    const svc = compose.services['storage-rust'];
    expect(svc).toBeDefined();
    expect(svc.ports).toBeUndefined();
  });

  it('storage-web publishes port 2907', () => {
    const svc = compose.services['storage-web'];
    expect(svc).toBeDefined();
    const ports = svc.ports ?? [];
    expect(ports.some((p: string) => p.includes('2907'))).toBe(true);
  });

  it('storage-db has no host port published', () => {
    const svc = compose.services['storage-db'];
    expect(svc.ports).toBeUndefined();
  });

  it('has storage-net network', () => {
    expect(compose.networks).toHaveProperty('storage-net');
  });

  it('migrate depends on db being healthy', () => {
    const svc = compose.services['storage-migrate'];
    const dep = svc.depends_on?.['storage-db'];
    expect(dep?.condition).toBe('service_healthy');
  });

  it('rust and web depend on migrate completing', () => {
    expect(compose.services['storage-rust']?.depends_on?.['storage-migrate']?.condition).toBe('service_completed_successfully');
    expect(compose.services['storage-web']?.depends_on?.['storage-migrate']?.condition).toBe('service_completed_successfully');
  });
});

describe('clueoj docker-compose.yml storage integration', () => {
  it('has storage-db service', () => {
    expect(clueojCompose.services['storage-db']).toBeDefined();
  });

  it('has storage-migrate service', () => {
    expect(clueojCompose.services['storage-migrate']).toBeDefined();
  });

  it('has storage-rust service with problems volume mount', () => {
    const svc = clueojCompose.services['storage-rust'];
    expect(svc).toBeDefined();
    const vols = svc.volumes ?? [];
    expect(vols.some((v: string) => v.includes('./problems/:/problems/'))).toBe(true);
  });

  it('storage-rust has no host port', () => {
    const svc = clueojCompose.services['storage-rust'];
    expect(svc.ports).toBeUndefined();
  });

  it('has storage-web publishing 2907', () => {
    const svc = clueojCompose.services['storage-web'];
    expect(svc).toBeDefined();
    const ports = svc.ports ?? [];
    expect(ports.some((p: string) => p.includes('2907'))).toBe(true);
  });

  it('has celery-beat service', () => {
    expect(clueojCompose.services['celery-beat']).toBeDefined();
  });

  it('storage-db has no host port', () => {
    const svc = clueojCompose.services['storage-db'];
    expect(svc.ports).toBeUndefined();
  });

  it('has storage-net network', () => {
    expect(clueojCompose.networks).toHaveProperty('storage-net');
  });

  it('storage-web is on both storage-net and site networks', () => {
    const svc = clueojCompose.services['storage-web'];
    const nets = svc.networks ?? [];
    expect(nets).toContain('storage-net');
    expect(nets).toContain('site');
  });
});