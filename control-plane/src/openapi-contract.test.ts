import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const specPath = resolve(__dirname, '../../packages/contracts/openapi/openapi.yaml');
const spec = parse(readFileSync(specPath, 'utf-8'));

describe('OpenAPI contract spec', () => {
  it('is valid OpenAPI 3.1', () => {
    expect(spec.openapi).toBe('3.1.0');
  });

  it('has all required paths', () => {
    const requiredPaths = [
      '/system/health',
      '/auth/login',
      '/auth/service-token',
      '/storage/volumes',
      '/catalog/problems:reconcile',
      '/catalog/snapshots:schedule',
      '/sync/changes',
      '/problems',
      '/problems/{externalId}',
      '/problems/{externalId}/usage',
      '/problems/{externalId}/dirty',
      '/problems/{externalId}/ensure-ready',
      '/problems/{externalId}/scan',
      '/problems/{externalId}/snapshot',
      '/problems/{externalId}/restore',
      '/problems/{externalId}/evict',
      '/organizations',
      '/organizations/{externalId}/usage',
      '/organizations/{externalId}/settings',
      '/snapshots',
      '/snapshots/{id}',
      '/jobs',
      '/jobs/{id}',
      '/jobs/{id}/retry',
      '/jobs/{id}/cancel',
      '/orphans',
      '/audit-events',
      '/downloads',
      '/jobs/{id}/events',
      '/backfill',
      '/backfill/{capability}/start',
      '/backfill/{capability}/pause',
      '/backfill/{capability}/progress',
      '/incident-commands',
      '/retention',
      '/retention/{entityType}',
      '/retention:apply',
      '/gc/eligible',
      '/dashboard/summary',
      '/dashboard/status-distribution',
      '/dashboard/largest-problems',
      '/dashboard/largest-organizations',
      '/dashboard/volume-timeseries',
    ];
    for (const p of requiredPaths) {
      expect(spec.paths, `missing path ${p}`).toHaveProperty(p);
    }
  });

  it('download endpoint has POST method', () => {
    expect(spec.paths['/downloads']).toHaveProperty('post');
  });

  it('all mutations are POST method', () => {
    const mutationPaths = [
      '/catalog/problems:reconcile',
      '/problems/{externalId}/scan',
      '/problems/{externalId}/snapshot',
      '/problems/{externalId}/restore',
      '/problems/{externalId}/evict',
      '/jobs/{id}/retry',
      '/jobs/{id}/cancel',
      '/downloads',
      '/auth/login',
    ];
    for (const p of mutationPaths) {
      expect(spec.paths[p], `missing path ${p}`).toHaveProperty('post');
    }
  });

  it('ErrorResponse schema has code, message, retryable, request_id', () => {
    const schema = spec.components.schemas.ErrorResponse;
    expect(schema.properties).toHaveProperty('code');
    expect(schema.properties).toHaveProperty('message');
    expect(schema.properties).toHaveProperty('retryable');
    expect(schema.properties).toHaveProperty('request_id');
  });

  it('Problem schema has external_id as PK and code mutable', () => {
    const schema = spec.components.schemas.Problem;
    expect(schema.properties).toHaveProperty('external_id');
    expect(schema.properties).toHaveProperty('code');
    expect(schema.properties).toHaveProperty('owner_organization');
    expect(schema.properties).toHaveProperty('catalog_state');
  });

  it('SyncChangesResponse schema has cursor pagination fields', () => {
    const schema = spec.components.schemas.SyncChangesResponse;
    expect(schema.properties).toHaveProperty('changes');
    expect(schema.properties).toHaveProperty('next_cursor');
    expect(schema.properties).toHaveProperty('has_more');
  });

  it('DownloadResponse has url, expires_at, method', () => {
    const schema = spec.components.schemas.DownloadResponse;
    expect(schema.properties).toHaveProperty('url');
    expect(schema.properties).toHaveProperty('expires_at');
    expect(schema.properties).toHaveProperty('method');
  });

  it('exposes orphan as a valid local usage status', () => {
    const schema = spec.components.schemas.ProblemUsage;
    expect(schema.properties.local_status.enum).toContain('orphan');
  });

  it('all byte fields use integer format', () => {
    const checkSchema = (schema: any, path: string) => {
      if (!schema?.properties) return;
      for (const [key, prop] of Object.entries(schema.properties)) {
        const p = prop as any;
        if (key.endsWith('_bytes') || key === 'total_bytes' || key === 'size_bytes') {
          const types = [p.type, ...(p.oneOf ?? []).map((entry: any) => entry.type), ...(p.anyOf ?? []).map((entry: any) => entry.type)];
          expect(types, `${path}.${key} should allow integer`).toContain('integer');
        }
      }
    };
    for (const [name, schema] of Object.entries(spec.components.schemas)) {
      checkSchema(schema, name);
    }
  });
});
