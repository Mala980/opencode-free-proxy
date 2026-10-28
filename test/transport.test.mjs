import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http2 from "node:http2";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { bundledLibcurlPath, createZenTransport } from "../lib/transport.mjs";
import { createServer as createProxyServer } from "../server.mjs";

const nativeApi = {
  CurlOpt: { HTTP_VERSION: 84, ACCEPT_ENCODING: 10_102 },
  CurlHttpVersion: { CURL_HTTP_VERSION_1_1: 2, CURL_HTTP_VERSION_2_0: 3, CURL_HTTP_VERSION_2TLS: 4 },
  NATIVE_IMPERSONATE_TARGETS: [{ target_name: "chrome150" }],
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Zen libcurl-impersonate transport", () => {
  test("fails closed when the selected native fingerprint is unavailable", async () => {
    const transport = createZenTransport({ profile: "not-a-native-browser-profile" });
    try {
      await assert.rejects(transport.prepare(), /does not provide the not-a-native-browser-profile profile/);
      assert.equal(transport.getStatus().ready, false);
      assert.equal(transport.getStatus().tlsImpersonation, false);
    } finally {
      await transport.close();
    }
  });

  test("rejects HTTP/1.1 only when strict HTTP/2 is explicitly required", async () => {
    const session = {
      async request(method, url, options) {
        options.headerCallback(Buffer.from("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n"));
        if (options.signal.aborted) throw options.signal.reason;
        return await new Promise((resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      },
      async close() {},
    };
    const transport = createZenTransport({
      profile: "chrome150",
      sessionFactory: async () => ({ session, api: nativeApi, tlsImpersonation: true }),
    });
    try {
      await assert.rejects(
        transport.request({ url: "https://opencode.ai/v1/models", stream: true, requireHttp2: true, timeoutMs: 1000 }),
        /HTTP\/1\.1.*HTTP\/2 with h2 ALPN is required/,
      );
      assert.equal(transport.getStatus().lastNegotiatedHttpVersion, null);
    } finally {
      await transport.close();
    }
  });

  test("refuses plaintext requests to OpenCode", async () => {
    const session = { async request() { throw new Error("request must not start"); }, async close() {} };
    const transport = createZenTransport({
      profile: "chrome150",
      sessionFactory: async () => ({ session, api: nativeApi, tlsImpersonation: true }),
    });

    try {
      await assert.rejects(
        transport.request({ url: "http://opencode.ai/v1/models" }),
        /OpenCode upstream requests require HTTPS/,
      );
    } finally {
      await transport.close();
    }
  });

  test("does not follow an OpenCode h2 redirect outside its host scope", async () => {
    let signalAborted = false;
    const session = {
      async request(method, url, options) {
        options.headerCallback(
          Buffer.from("HTTP/2 302 Found\r\nlocation: https://cdn.example.com/v1/models\r\n\r\n"),
        );
        signalAborted = options.signal.aborted;
        if (signalAborted) throw options.signal.reason;
        throw new Error("the external redirect should not be followed");
      },
      async close() {},
    };
    const transport = createZenTransport({
      profile: "chrome150",
      experimentalHttp2: true,
      sessionFactory: async () => ({ session, api: nativeApi, tlsImpersonation: true }),
    });

    try {
      await assert.rejects(
        transport.request({ url: "https://opencode.ai/v1/models" }),
        /HTTP\/2 upstream redirected outside its allowed host scope/,
      );
      assert.equal(signalAborted, true);
    } finally {
      await transport.close();
    }
  });

  test("uses HTTP/1.1 by default for OpenCode and other HTTPS destinations", async () => {
    const captured = [];
    const session = {
      async request(method, url, options) {
        captured.push({ method, url, options });
        options.headerCallback(Buffer.from("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n"));
        return {
          statusCode: 200,
          statusText: "OK",
          headers: { toObject: () => ({ "content-type": "application/json" }) },
          httpVersionString: "1.1",
          content: Buffer.from('{"ok":true}'),
        };
      },
      async close() {},
    };
    const transport = createZenTransport({
      profile: "chrome150",
      sessionFactory: async () => ({ session, api: nativeApi, tlsImpersonation: true }),
    });

    try {
      const zenResponse = await transport.request({ url: "https://opencode.ai/v1/models" });
      const otherResponse = await transport.request({ url: "https://models.example/api.json" });
      assert.equal(zenResponse.status, 200);
      assert.equal(otherResponse.status, 200);
      assert.equal(await zenResponse.text(), '{"ok":true}');
      assert.equal(await otherResponse.text(), '{"ok":true}');
      assert.equal(captured.length, 2);
      for (const request of captured) {
        assert.equal(request.options.httpVersion, "1.1");
        assert.equal(
          request.options.curlOptions[nativeApi.CurlOpt.HTTP_VERSION],
          nativeApi.CurlHttpVersion.CURL_HTTP_VERSION_1_1,
        );
      }
      assert.equal(transport.getStatus().lastNegotiatedHttpVersion, "1.1");
    } finally {
      await transport.close();
    }
  });

  test("mirrors Bun's experimental HTTP/2 fetch flag with an HTTP/1.1 fallback", async () => {
    const captured = [];
    const session = {
      async request(method, url, options) {
        captured.push({ method, url, options });
        options.headerCallback(Buffer.from("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n"));
        return {
          statusCode: 200,
          statusText: "OK",
          headers: { toObject: () => ({ "content-type": "application/json" }) },
          httpVersionString: "1.1",
          content: Buffer.from('{"ok":true}'),
        };
      },
      async close() {},
    };
    const transport = createZenTransport({
      profile: "chrome150",
      experimentalHttp2: true,
      sessionFactory: async () => ({ session, api: nativeApi, tlsImpersonation: true }),
    });

    try {
      const zenResponse = await transport.request({ url: "https://opencode.ai/v1/models" });
      const otherResponse = await transport.request({ url: "https://models.example/api.json" });
      assert.equal(zenResponse.status, 200, "HTTP/1.1 fallback is allowed, as with fetch() without a forced protocol");
      assert.equal(otherResponse.status, 200);
      assert.equal(captured[0].options.httpVersion, "2");
      assert.equal(
        captured[0].options.curlOptions[nativeApi.CurlOpt.HTTP_VERSION],
        nativeApi.CurlHttpVersion.CURL_HTTP_VERSION_2TLS,
      );
      assert.equal(captured[1].options.httpVersion, "1.1", "HTTP/2 opt-in is scoped to OpenCode");
      assert.equal(
        captured[1].options.curlOptions[nativeApi.CurlOpt.HTTP_VERSION],
        nativeApi.CurlHttpVersion.CURL_HTTP_VERSION_1_1,
      );
      assert.equal(transport.getStatus().http2Enabled, true);
      assert.equal(transport.getStatus().lastNegotiatedHttpVersion, "1.1");
    } finally {
      await transport.close();
    }
  });

  test("requests the Chrome HTTP/2 profile and bridges incremental SSE with decompression headers corrected", async () => {
    let captured;
    let completed = false;
    const session = {
      async request(method, url, options) {
        captured = { method, url, options };
        options.headerCallback(
          Buffer.from(
            "HTTP/2 200 OK\r\ncontent-type: text/event-stream\r\ncontent-encoding: gzip\r\ncontent-length: 50\r\n\r\n",
          ),
        );
        options.contentCallback(Buffer.from("data: first\n\n"));
        await delay(40);
        options.contentCallback(Buffer.from("data: second\n\n"));
        completed = true;
        return {
          statusCode: 200,
          statusText: "OK",
          headers: { toObject: () => ({ "content-type": "text/event-stream", "content-encoding": "gzip", "content-length": "50" }) },
          httpVersionString: "2",
        };
      },
      async close() {},
    };
    const transport = createZenTransport({
      profile: "chrome150",
      experimentalHttp2: true,
      sessionFactory: async () => ({ session, api: nativeApi, tlsImpersonation: true, transport: "test libcurl-impersonate" }),
    });

    try {
      const response = await transport.request({
        url: "https://opencode.ai/v1/chat/completions",
        method: "POST",
        headers: { "Accept-Encoding": "gzip, deflate, br, zstd", "User-Agent": "opencode/latest/2.2.0/cli" },
        body: "{}",
        stream: true,
        timeoutMs: 2000,
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-encoding"), null);
      assert.equal(response.headers.get("content-length"), null);
      assert.equal(captured.options.impersonate, "chrome150");
      assert.equal(captured.options.httpVersion, "2");
      assert.equal(captured.options.defaultHeaders, false);
      assert.equal(captured.options.curlOptions[nativeApi.CurlOpt.HTTP_VERSION], nativeApi.CurlHttpVersion.CURL_HTTP_VERSION_2TLS);
      assert.equal(captured.options.curlOptions[nativeApi.CurlOpt.ACCEPT_ENCODING], "");

      const reader = response.body.getReader();
      const first = await reader.read();
      assert.match(Buffer.from(first.value).toString(), /data: first/);
      assert.equal(completed, false, "the first SSE chunk arrives before the upstream response ends");
      const second = await reader.read();
      assert.match(Buffer.from(second.value).toString(), /data: second/);
      assert.equal((await reader.read()).done, true);
      reader.releaseLock();
      assert.equal(completed, true);
      assert.equal(transport.getStatus().lastNegotiatedHttpVersion, "2");
    } finally {
      await transport.close();
    }
  });

  test("real pinned Chrome transport negotiates h2 and streams/decompresses against local TLS", async (t) => {
    if (!bundledLibcurlPath() && !process.env.LIBCURL_IMPERSONATE_PATH && !process.env.LIBCURL_PATH) {
      t.skip("no platform libcurl-impersonate package or explicit library path installed");
      return;
    }

    const tmp = mkdtempSync(path.join(os.tmpdir(), "opencode-proxy-tls-"));
    const keyPath = path.join(tmp, "key.pem");
    const certPath = path.join(tmp, "cert.pem");
    const certResult = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-subj",
        "/CN=localhost",
        "-days",
        "1",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
      ],
      { stdio: "ignore" },
    );
    if (certResult.error || certResult.status !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      t.skip("openssl is needed to create the local self-signed test certificate");
      return;
    }

    const state = { alpn: null, finished: false, acceptEncoding: null, userAgent: null, headers: null };
    const server = http2.createSecureServer({
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
      allowHTTP1: true,
    });
    server.on("stream", (stream, headers) => {
      state.alpn = stream.session.socket.alpnProtocol;
      state.acceptEncoding = headers["accept-encoding"];
      state.userAgent = headers["user-agent"];
      state.headers = headers;

      if (headers[":path"] === "/gzip") {
        const compressed = gzipSync(Buffer.from("data: compressed\n\n"));
        stream.respond({
          ":status": 200,
          "content-type": "text/event-stream",
          "content-encoding": "gzip",
          "content-length": String(compressed.length),
        });
        stream.end(compressed);
        return;
      }

      state.finished = false;
      stream.respond({ ":status": 200, "content-type": "text/event-stream" });
      stream.write("data: first\n\n");
      setTimeout(() => {
        state.finished = true;
        stream.end("data: second\n\n");
      }, 300);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    const transport = createZenTransport({ profile: "chrome150" });
    try {
      const response = await transport.request({
        url: `https://127.0.0.1:${address.port}/sse`,
        method: "POST",
        headers: {
          "Accept-Encoding": "gzip, deflate, br, zstd",
          "User-Agent": "opencode/latest/2.2.0/cli",
          "Content-Type": "application/json",
        },
        body: "{}",
        stream: true,
        verify: false,
        requireHttp2: true,
        timeoutMs: 5000,
      });
      const reader = response.body.getReader();
      const first = await reader.read();
      assert.match(Buffer.from(first.value).toString(), /data: first/);
      assert.equal(state.finished, false, "SSE is delivered before the server ends the response");
      const second = await reader.read();
      assert.match(Buffer.from(second.value).toString(), /data: second/);
      assert.equal((await reader.read()).done, true);
      reader.releaseLock();

      assert.equal(state.alpn, "h2", "the TLS session negotiated h2 ALPN");
      assert.equal(state.acceptEncoding, "gzip, deflate, br, zstd");
      assert.equal(state.userAgent, "opencode/latest/2.2.0/cli");
      assert.equal(transport.getStatus().lastNegotiatedHttpVersion, "2");

      const gzipResponse = await transport.request({
        url: `https://127.0.0.1:${address.port}/gzip`,
        method: "GET",
        headers: { "Accept-Encoding": "gzip, deflate, br, zstd" },
        stream: true,
        verify: false,
        requireHttp2: true,
        timeoutMs: 5000,
      });
      assert.equal(await gzipResponse.text(), "data: compressed\n\n");
      assert.equal(gzipResponse.headers.get("content-encoding"), null);
      assert.equal(gzipResponse.headers.get("content-length"), null);

      const keysPath = path.join(tmp, "api-keys.json");
      const modelsPath = path.join(tmp, "models.json");
      const apiKey = "oc-local-transport-test-key";
      writeFileSync(keysPath, JSON.stringify({ test: apiKey }));
      writeFileSync(
        modelsPath,
        JSON.stringify({
          updated: "2026-10-28",
          models: [{ id: "big-pickle", name: "Big Pickle", endpoint: "chat", context: 200000, tool_call: true }],
          retired: {},
        }),
      );
      const proxyTransport = createZenTransport({ profile: "chrome150" });
      const localTlsTransport = {
        prepare: () => proxyTransport.prepare(),
        getStatus: () => proxyTransport.getStatus(),
        request: (options) => proxyTransport.request({ ...options, verify: false, requireHttp2: true }),
        close: () => proxyTransport.close(),
      };
      const app = createProxyServer({
        port: 0,
        host: "127.0.0.1",
        zenBase: `https://127.0.0.1:${address.port}/v1`,
        keysFile: keysPath,
        modelsFile: modelsPath,
        refreshModels: false,
        verify: false,
        logRequests: false,
        upstreamTransport: localTlsTransport,
      });
      try {
        const proxyAddress = await app.listen();
        await app.ready();
        const proxyResponse = await fetch(`http://127.0.0.1:${proxyAddress.port}/v1/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "big-pickle", messages: [{ role: "user", content: "hello" }], stream: true }),
        });
        assert.equal(proxyResponse.status, 200);
        const proxyReader = proxyResponse.body.getReader();
        const proxyFirst = await proxyReader.read();
        assert.match(Buffer.from(proxyFirst.value).toString(), /data: first/);
        assert.equal(state.finished, false, "the proxy forwards SSE before the upstream stream completes");
        const proxySecond = await proxyReader.read();
        assert.match(Buffer.from(proxySecond.value).toString(), /data: second/);
        assert.equal((await proxyReader.read()).done, true);
        proxyReader.releaseLock();
        assert.equal(state.alpn, "h2");
        assert.equal(state.acceptEncoding, "gzip, deflate, br, zstd");
        assert.equal(state.userAgent, "opencode/latest/2.2.0/cli");
        assert.equal(state.headers.authorization, "Bearer public");
        assert.equal(state.headers.accept, "*/*");
        assert.equal(state.headers["x-opencode-client"], "cli");
        assert.equal(state.headers["x-opencode-project"], "global");
        assert.match(state.headers["x-opencode-session"], /^ses_/);
        assert.match(state.headers["x-opencode-session-id"], /^ses_/);
        assert.match(state.headers["x-session-affinity"], /^ses_/);
        assert.match(state.headers["x-session-id"], /^ses_/);
        assert.equal(app.transport.getStatus().lastNegotiatedHttpVersion, "2");
        const health = await (await fetch(`http://127.0.0.1:${proxyAddress.port}/health`)).json();
        assert.equal(health.requestProfile.tlsImpersonation, true);
        assert.equal(health.requestProfile.tlsBackend, "BoringSSL");
        assert.match(health.requestProfile.libcurlVersion, /IMPERSONATE.*BoringSSL/i);
        assert.equal(health.requestProfile.lastNegotiatedHttpVersion, "2");
      } finally {
        await app.close();
      }
    } finally {
      await transport.close();
      await new Promise((resolve) => server.close(resolve));
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
