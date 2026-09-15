import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

const composePath = resolve(__dirname, '../../docker-compose.yml');
const compose = parseYaml(readFileSync(composePath, 'utf-8'));

const clueojComposePath = resolve(__dirname, '../../../clueoj/docker-compose.yml');
const clueojStorageClientComposePath = resolve(__dirname, '../../../clueoj/docker-compose.storage-client.yml');
const hasSiblingClueoj = existsSync(clueojComposePath) && existsSync(clueojStorageClientComposePath);
const clueojCompose = hasSiblingClueoj ? parseYaml(readFileSync(clueojComposePath, 'utf-8')) : null;
const clueojStorageClientCompose = hasSiblingClueoj
  ? parseYaml(readFileSync(clueojStorageClientComposePath, 'utf-8'))
  : null;

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

function processArgv(svc: { entrypoint?: unknown; command?: unknown } | undefined): string {
  const parts: string[] = [];
  for (const value of [svc?.entrypoint, svc?.command]) {
    if (Array.isArray(value)) {
      parts.push(...value.map(String));
    } else if (value) {
      parts.push(String(value));
    }
  }
  return parts.join(' ');
}

function dockerfileInstruction(source: string, instruction: string): string | undefined {
  return source.split('\n').find((line) => line.startsWith(`${instruction} `));
}

describe.skipIf(!hasSiblingClueoj)('clueoj client-only storage override', () => {
  it('does not run storage services in the base ClueOJ compose file', () => {
    expect(clueojCompose!.services['storage-db']).toBeUndefined();
    expect(clueojCompose!.services['storage-migrate']).toBeUndefined();
    expect(clueojCompose!.services['storage-rust']).toBeUndefined();
    expect(clueojCompose!.services['storage-web']).toBeUndefined();
  });

  it('runs celery worker and celery-beat as separate processes', () => {
    const worker = clueojCompose!.services['celery'];
    const beat = clueojCompose!.services['celery-beat'];
    expect(worker).toBeDefined();
    expect(beat).toBeDefined();
    const workerArgv = processArgv(worker);
    const beatArgv = processArgv(beat);
    expect(workerArgv).toMatch(/\bworker\b/);
    expect(workerArgv).not.toMatch(/\bbeat\b/);
    expect(beatArgv).toMatch(/\bbeat\b/);
    expect(beatArgv).not.toMatch(/\bworker\b/);
  });

  it('keeps the celery image entrypoint as the celery executable without worker or beat', () => {
    const dockerfilePath = resolve(__dirname, '../../../clueoj/celery/Dockerfile');
    expect(existsSync(dockerfilePath)).toBe(true);
    const dockerfile = readFileSync(dockerfilePath, 'utf-8');
    const entrypoint = dockerfileInstruction(dockerfile, 'ENTRYPOINT');
    const cmd = dockerfileInstruction(dockerfile, 'CMD');
    expect(entrypoint).toBe('ENTRYPOINT ["celery", "-A", "dmoj_celery"]');
    expect(cmd).toBe('CMD ["worker", "-l", "info", "--concurrency=2"]');
    expect(entrypoint).not.toMatch(/\bworker\b/);
    expect(entrypoint).not.toMatch(/\bbeat\b/);
  });

  it('adds storage.env and host-gateway to site, celery, and celery-beat', () => {
    for (const name of ['site', 'celery', 'celery-beat']) {
      const svc = clueojStorageClientCompose!.services[name];
      expect(svc).toBeDefined();
      expect(svc.env_file).toContain('environment/storage.env');
      expect(svc.extra_hosts).toContain('host.docker.internal:host-gateway');
    }
  });

  it('adds celery-beat using the existing celery image and ClueOJ networks', () => {
    const svc = clueojStorageClientCompose!.services['celery-beat'];
    expect(svc).toBeDefined();
    expect(svc.image).toBe('vnoj/vnoj-celery');
    expect(svc.env_file).toContain('environment/storage.env');
    expect(svc.extra_hosts).toContain('host.docker.internal:host-gateway');
    expect(svc.networks).toContain('site');
    expect(svc.networks).toContain('db');
    const beatArgv = processArgv(svc);
    expect(beatArgv).toMatch(/\bbeat\b/);
    expect(beatArgv).not.toMatch(/\bworker\b/);
  });

  it('does not define storage services in the client override', () => {
    expect(clueojStorageClientCompose!.services['storage-db']).toBeUndefined();
    expect(clueojStorageClientCompose!.services['storage-migrate']).toBeUndefined();
    expect(clueojStorageClientCompose!.services['storage-rust']).toBeUndefined();
    expect(clueojStorageClientCompose!.services['storage-web']).toBeUndefined();
  });
});
