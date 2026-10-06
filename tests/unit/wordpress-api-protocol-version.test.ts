/**
 * Regression tests for the session-bound `MCP-Protocol-Version` header.
 *
 * The proxy used to hard-code `MCP-Protocol-Version: 2025-06-18` on every HTTP
 * request to the WordPress MCP endpoint. WordPress' MCP Adapter binds an HTTP
 * session to the protocol version negotiated during `initialize` (e.g.
 * 2025-11-25 for current MCP clients) and rejects any follow-up request whose
 * header disagrees with HTTP 400 / JSON-RPC -32600. Every tool call through the
 * proxy therefore failed.
 *
 * These tests capture the header the proxy actually sends (via nock reply
 * functions) and assert the negotiated version is echoed on follow-up requests.
 */

import { jest } from '@jest/globals';
import nock from 'nock';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { mockEnv } from '../utils/test-helpers.js';

// Mock the OAuth provider to avoid ESM issues with 'open' module
jest.unstable_mockModule('../../src/lib/mcp-oauth-provider.js', () => ({
  MCPOAuthProvider: jest.fn().mockImplementation(() => ({
    authorize: jest.fn().mockImplementation(() => Promise.resolve()),
    tokens: jest.fn().mockImplementation(() => Promise.resolve(null)),
  })),
}));

// Mock persistent OAuth client provider
jest.unstable_mockModule('../../src/lib/persistent-oauth-client-provider.js', () => ({
  PersistentWPOAuthClientProvider: jest.fn().mockImplementation(() => ({})),
}));

// Mock coordination module
jest.unstable_mockModule('../../src/lib/coordination.js', () => ({
  createLazyWPAuthCoordinator: jest.fn().mockReturnValue({
    waitForAuth: jest.fn().mockImplementation(() => Promise.resolve(null)),
  }),
}));

const WP_MCP_ENDPOINT = '/?rest_route=/wp/v2/wpmcp';
const BASE_URL = 'https://protocol-version.example.com';

function jsonRpcResult(id: number, result: any) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id: number, code: number, message: string) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Read a request header from inside a nock reply function. */
function headerValue(
  req: { headers: Record<string, string | string[] | undefined> },
  name: string
): string | undefined {
  const raw = req.headers[name.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : (raw as string | undefined);
}

function initializeRequest(protocolVersion: string, id = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'protocol-version-test-client', version: '1.0.0' },
    },
  };
}

function toolsListRequest(id = 2) {
  return { jsonrpc: '2.0', id, method: 'tools/list', params: {} };
}

/** Simple transport spreads the client's initialize params at the top level. */
function simpleInitializeRequest(protocolVersion: string) {
  return {
    method: 'initialize',
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 'protocol-version-test-client', version: '1.0.0' },
  };
}

describe('MCP-Protocol-Version header (session-bound)', () => {
  let restoreEnv: () => void;

  beforeEach(() => {
    jest.resetModules();
    nock.cleanAll();
  });

  afterEach(() => {
    if (restoreEnv) {
      restoreEnv();
    }
    nock.cleanAll();
  });

  it('sends the version the client asked for on the initialize request', async () => {
    restoreEnv = mockEnv({ WP_API_URL: BASE_URL, JWT_TOKEN: 'test-token' });

    const initHeaders: Array<string | undefined> = [];
    nock(BASE_URL)
      .post(WP_MCP_ENDPOINT, initializeRequest('2025-11-25'))
      .reply(function () {
        initHeaders.push(headerValue(this.req, 'mcp-protocol-version'));
        return [
          200,
          jsonRpcResult(1, { protocolVersion: '2025-11-25', capabilities: {} }),
          { 'Mcp-Session-Id': 'session-1' },
        ];
      });

    const { wpRequest } = await import('../../src/lib/wordpress-api.js');
    await wpRequest(initializeRequest('2025-11-25'), true);

    // The old code hard-coded '2025-06-18' here.
    expect(initHeaders).toEqual(['2025-11-25']);
    expect(nock.isDone()).toBe(true);
  });

  it('repeats the version WordPress negotiated on follow-up requests', async () => {
    restoreEnv = mockEnv({ WP_API_URL: BASE_URL, JWT_TOKEN: 'test-token' });

    const headers: Array<string | undefined> = [];
    nock(BASE_URL)
      .post(WP_MCP_ENDPOINT, initializeRequest('2025-11-25'))
      .reply(function () {
        headers.push(headerValue(this.req, 'mcp-protocol-version'));
        return [
          200,
          jsonRpcResult(1, { protocolVersion: '2025-11-25', capabilities: {} }),
          { 'Mcp-Session-Id': 'session-1' },
        ];
      });

    nock(BASE_URL)
      .post(WP_MCP_ENDPOINT, toolsListRequest())
      .matchHeader('mcp-session-id', 'session-1')
      .reply(function () {
        headers.push(headerValue(this.req, 'mcp-protocol-version'));
        return [200, jsonRpcResult(2, { tools: [] })];
      });

    const { wpRequest } = await import('../../src/lib/wordpress-api.js');
    await wpRequest(initializeRequest('2025-11-25'), true);
    await expect(wpRequest(toolsListRequest(), true)).resolves.toEqual({ tools: [] });

    // Follow-up must carry the negotiated version, not the legacy constant.
    expect(headers).toEqual(['2025-11-25', '2025-11-25']);
    expect(nock.isDone()).toBe(true);
  });

  it("uses WordPress' reported version even when it differs from the client's request", async () => {
    restoreEnv = mockEnv({ WP_API_URL: BASE_URL, JWT_TOKEN: 'test-token' });

    const headers: Array<string | undefined> = [];
    // Client asks for 2025-11-25; the server negotiates down to 2025-06-18.
    nock(BASE_URL)
      .post(WP_MCP_ENDPOINT, initializeRequest('2025-11-25'))
      .reply(function () {
        headers.push(headerValue(this.req, 'mcp-protocol-version'));
        return [
          200,
          jsonRpcResult(1, { protocolVersion: '2025-06-18', capabilities: {} }),
          { 'Mcp-Session-Id': 'session-1' },
        ];
      });

    nock(BASE_URL)
      .post(WP_MCP_ENDPOINT, toolsListRequest())
      .matchHeader('mcp-session-id', 'session-1')
      .reply(function () {
        headers.push(headerValue(this.req, 'mcp-protocol-version'));
        return [200, jsonRpcResult(2, { tools: [] })];
      });

    const { wpRequest } = await import('../../src/lib/wordpress-api.js');
    await wpRequest(initializeRequest('2025-11-25'), true);
    await wpRequest(toolsListRequest(), true);

    // init echoes the request; the follow-up repeats the *negotiated* version.
    expect(headers).toEqual(['2025-11-25', '2025-06-18']);
    expect(nock.isDone()).toBe(true);
  });

  it('lets CUSTOM_HEADERS override the MCP-Protocol-Version header', async () => {
    restoreEnv = mockEnv({
      WP_API_URL: BASE_URL,
      JWT_TOKEN: 'test-token',
      CUSTOM_HEADERS: JSON.stringify({ 'MCP-Protocol-Version': '2025-03-26' }),
    });

    const headers: Array<string | undefined> = [];
    nock(BASE_URL)
      .post(WP_MCP_ENDPOINT, initializeRequest('2025-11-25'))
      .reply(function () {
        headers.push(headerValue(this.req, 'mcp-protocol-version'));
        return [
          200,
          jsonRpcResult(1, { protocolVersion: '2025-11-25', capabilities: {} }),
          { 'Mcp-Session-Id': 'session-1' },
        ];
      });

    nock(BASE_URL)
      .post(WP_MCP_ENDPOINT, toolsListRequest())
      .matchHeader('mcp-session-id', 'session-1')
      .reply(function () {
        headers.push(headerValue(this.req, 'mcp-protocol-version'));
        return [200, jsonRpcResult(2, { tools: [] })];
      });

    const { wpRequest } = await import('../../src/lib/wordpress-api.js');
    await wpRequest(initializeRequest('2025-11-25'), true);
    await wpRequest(toolsListRequest(), true);

    // The user's explicit override wins on both the initialize and the follow-up.
    expect(headers).toEqual(['2025-03-26', '2025-03-26']);
    expect(nock.isDone()).toBe(true);
  });

  it("reuses the client's requested version when WordPress omits one", async () => {
    restoreEnv = mockEnv({ WP_API_URL: BASE_URL, JWT_TOKEN: 'test-token' });

    const headers: Array<string | undefined> = [];
    nock(BASE_URL)
      .post(WP_MCP_ENDPOINT, initializeRequest('2025-06-18'))
      .reply(function () {
        headers.push(headerValue(this.req, 'mcp-protocol-version'));
        // No protocolVersion in the result.
        return [200, jsonRpcResult(1, { capabilities: {} }), { 'Mcp-Session-Id': 'session-1' }];
      });

    nock(BASE_URL)
      .post(WP_MCP_ENDPOINT, toolsListRequest())
      .matchHeader('mcp-session-id', 'session-1')
      .reply(function () {
        headers.push(headerValue(this.req, 'mcp-protocol-version'));
        return [200, jsonRpcResult(2, { tools: [] })];
      });

    const { wpRequest } = await import('../../src/lib/wordpress-api.js');
    await wpRequest(initializeRequest('2025-06-18'), true);
    await wpRequest(toolsListRequest(), true);

    // The client's requested version is remembered and reused, not LATEST.
    expect(headers).toEqual(['2025-06-18', '2025-06-18']);
    expect(nock.isDone()).toBe(true);
  });

  it('uses the SDK latest version when neither negotiated nor requested is known', async () => {
    restoreEnv = mockEnv({ WP_API_URL: BASE_URL, JWT_TOKEN: 'test-token' });

    const headers: Array<string | undefined> = [];
    nock(BASE_URL)
      .post(WP_MCP_ENDPOINT, toolsListRequest())
      .reply(function () {
        headers.push(headerValue(this.req, 'mcp-protocol-version'));
        return [200, jsonRpcResult(2, { tools: [] })];
      });

    const { wpRequest } = await import('../../src/lib/wordpress-api.js');
    await wpRequest(toolsListRequest(), true);

    expect(headers).toEqual([LATEST_PROTOCOL_VERSION]);
    expect(nock.isDone()).toBe(true);
  });

  it('echoes the requested version on a simple-transport initialize (top-level protocolVersion)', async () => {
    restoreEnv = mockEnv({ WP_API_URL: BASE_URL, JWT_TOKEN: 'test-token' });

    const headers: Array<string | undefined> = [];
    nock(BASE_URL)
      .post(WP_MCP_ENDPOINT, (body: any) => body?.method === 'initialize')
      .reply(function () {
        headers.push(headerValue(this.req, 'mcp-protocol-version'));
        return [
          200,
          {
            protocolVersion: '2025-06-18',
            capabilities: {},
            serverInfo: { name: 'wp', version: '1' },
          },
          { 'Mcp-Session-Id': 'session-simple' },
        ];
      });

    nock(BASE_URL)
      .post(WP_MCP_ENDPOINT, (body: any) => body?.method === 'tools/list')
      .reply(function () {
        headers.push(headerValue(this.req, 'mcp-protocol-version'));
        return [200, { tools: [] }];
      });

    const { wpRequest } = await import('../../src/lib/wordpress-api.js');
    await wpRequest(simpleInitializeRequest('2025-06-18'), false);
    await wpRequest({ method: 'tools/list' }, false);

    // Regression: the header used to fall back to the SDK latest here because the
    // version sits at the top level, not under `params`.
    expect(headers).toEqual(['2025-06-18', '2025-06-18']);
    expect(nock.isDone()).toBe(true);
  });

  it('clears the negotiated version when a new initialize reports none', async () => {
    restoreEnv = mockEnv({ WP_API_URL: BASE_URL, JWT_TOKEN: 'test-token' });

    const headers: Array<string | undefined> = [];
    // First handshake: WordPress negotiates down to 2025-06-18.
    nock(BASE_URL)
      .post(WP_MCP_ENDPOINT, initializeRequest('2025-11-25'))
      .reply(function () {
        headers.push(headerValue(this.req, 'mcp-protocol-version'));
        return [
          200,
          jsonRpcResult(1, { protocolVersion: '2025-06-18', capabilities: {} }),
          { 'Mcp-Session-Id': 'session-1' },
        ];
      });

    nock(BASE_URL)
      .post(WP_MCP_ENDPOINT, toolsListRequest())
      .reply(function () {
        headers.push(headerValue(this.req, 'mcp-protocol-version'));
        return [200, jsonRpcResult(2, { tools: [] })];
      });

    // Second handshake: the server reports no version at all.
    nock(BASE_URL)
      .post(WP_MCP_ENDPOINT, initializeRequest('2025-11-25', 3))
      .reply(function () {
        headers.push(headerValue(this.req, 'mcp-protocol-version'));
        return [200, jsonRpcResult(3, { capabilities: {} }), { 'Mcp-Session-Id': 'session-2' }];
      });

    nock(BASE_URL)
      .post(WP_MCP_ENDPOINT, toolsListRequest(4))
      .reply(function () {
        headers.push(headerValue(this.req, 'mcp-protocol-version'));
        return [200, jsonRpcResult(4, { tools: [] })];
      });

    const { wpRequest } = await import('../../src/lib/wordpress-api.js');
    await wpRequest(initializeRequest('2025-11-25'), true);
    await wpRequest(toolsListRequest(), true);
    await wpRequest(initializeRequest('2025-11-25', 3), true);
    await wpRequest(toolsListRequest(4), true);

    // The last request must NOT repeat the stale 2025-06-18 of the first session.
    expect(headers).toEqual(['2025-11-25', '2025-06-18', '2025-11-25', LATEST_PROTOCOL_VERSION]);
    expect(nock.isDone()).toBe(true);
  });

  it('keeps the negotiated version across an invalid-session refresh', async () => {
    restoreEnv = mockEnv({ WP_API_URL: BASE_URL, JWT_TOKEN: 'test-token' });

    const initHeaders: Array<string | undefined> = [];
    const toolHeaders: Array<string | undefined> = [];
    let initCallCount = 0;

    nock(BASE_URL)
      .post(WP_MCP_ENDPOINT, initializeRequest('2025-11-25'))
      .twice()
      .reply(function () {
        initHeaders.push(headerValue(this.req, 'mcp-protocol-version'));
        initCallCount += 1;
        return [
          200,
          jsonRpcResult(1, { protocolVersion: '2025-11-25', capabilities: {} }),
          { 'Mcp-Session-Id': initCallCount === 1 ? 'session-1' : 'session-2' },
        ];
      });

    nock(BASE_URL)
      .post(WP_MCP_ENDPOINT, toolsListRequest())
      .matchHeader('mcp-session-id', 'session-1')
      .reply(function () {
        toolHeaders.push(headerValue(this.req, 'mcp-protocol-version'));
        return [200, jsonRpcError(2, -32602, 'Invalid or expired session')];
      });

    nock(BASE_URL)
      .post(WP_MCP_ENDPOINT, toolsListRequest())
      .matchHeader('mcp-session-id', 'session-2')
      .reply(function () {
        toolHeaders.push(headerValue(this.req, 'mcp-protocol-version'));
        return [200, jsonRpcResult(2, { tools: [] })];
      });

    const { wpRequest } = await import('../../src/lib/wordpress-api.js');
    await wpRequest(initializeRequest('2025-11-25'), true);
    await expect(wpRequest(toolsListRequest(), true)).resolves.toEqual({ tools: [] });

    // Both the refresh initialize and the retried tool request repeat the version.
    expect(initHeaders).toEqual(['2025-11-25', '2025-11-25']);
    expect(toolHeaders).toEqual(['2025-11-25', '2025-11-25']);
    expect(nock.isDone()).toBe(true);
  });
});
