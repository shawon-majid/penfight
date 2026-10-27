import { describe, expect, it } from 'vitest';
import {
  apiAddress,
  homeAddress,
  parseServerOrigin,
  socketAddress,
} from '../src/client/net/server';
import { allowAnyOrigin, preflight } from '../src/server/cors';

const ownSite = { origin: 'https://penfight.shawonmajid.com' };
const itchFrame = { origin: 'https://html-classic.itch.zone' };
const server = 'https://penfight.shawonmajid.com';

describe('finding the server', () => {
  it('treats an unset or blank setting as "this page\'s own site"', () => {
    expect(parseServerOrigin(undefined)).toBeNull();
    expect(parseServerOrigin('')).toBeNull();
    expect(parseServerOrigin('   ')).toBeNull();
  });

  it('drops a trailing slash from the configured server', () => {
    expect(parseServerOrigin('https://penfight.shawonmajid.com/')).toBe(server);
  });

  it('keeps api calls relative on the server\'s own site', () => {
    expect(apiAddress(null, '/api/table')).toBe('/api/table');
  });

  it('sends api calls to the server from a hosted build', () => {
    expect(apiAddress(server, '/api/table')).toBe(`${server}/api/table`);
  });

  it('opens sockets on the page\'s own site when there is no server set', () => {
    expect(socketAddress(null, ownSite, '/api/table/ABC12/ws?player=x')).toBe(
      'wss://penfight.shawonmajid.com/api/table/ABC12/ws?player=x',
    );
    expect(socketAddress(null, { origin: 'http://localhost:5173' }, '/api/table/ABC12/ws')).toBe(
      'ws://localhost:5173/api/table/ABC12/ws',
    );
  });

  it('opens sockets on the server, not on itch, from a hosted build', () => {
    expect(socketAddress(server, itchFrame, '/api/table/ABC12/ws?player=x&name=Ann')).toBe(
      'wss://penfight.shawonmajid.com/api/table/ABC12/ws?player=x&name=Ann',
    );
  });

  it('points invite links at the server\'s site from a hosted build', () => {
    expect(homeAddress(null, ownSite)).toBe('https://penfight.shawonmajid.com');
    expect(homeAddress(server, itchFrame)).toBe(server);
  });
});

describe('asking for a table from another site', () => {
  it('lets any site read the table code', async () => {
    const response = allowAnyOrigin(Response.json({ code: 'ABC12' }));
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await response.json()).toEqual({ code: 'ABC12' });
  });

  it('keeps the status of a failed request', () => {
    const response = allowAnyOrigin(Response.json({ error: 'busy' }, { status: 503 }));
    expect(response.status).toBe(503);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('answers the browser\'s preflight check', () => {
    const response = preflight();
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });
});
