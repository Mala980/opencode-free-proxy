import { createRequire } from "node:module";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";

const require = createRequire(import.meta.url);

const PLATFORM_LIBRARIES = Object.freeze({
  "linux:x64": ["@searchcast/libcurl-linux-x64", "libcurl-impersonate.so"],
  "linux:arm64": ["@searchcast/libcurl-linux-arm64", "libcurl-impersonate.so"],
  "darwin:x64": ["@searchcast/libcurl-darwin-x64", "libcurl-impersonate.dylib"],
  "darwin:arm64": ["@searchcast/libcurl-darwin-arm64", "libcurl-impersonate.dylib"],
  "win32:x64": ["@searchcast/libcurl-win32-x64", "libcurl-impersonate.dll"],
});

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_PROFILE = "chrome150";
const OPENCODE_HOST = "opencode.ai";

function isOpenCodeHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === OPENCODE_HOST || host.endsWith(`.${OPENCODE_HOST}`);
}

/** Resolve the pinned platform library installed from this package's optional dependencies. */
export function bundledLibcurlPath(platform = process.platform, arch = process.arch) {
  const library = PLATFORM_LIBRARIES[`${platform}:${arch}`];
  if (!library) return null;

  try {
    const packageJsonPath = require.resolve(`${library[0]}/package.json`);
    return path.join(path.dirname(packageJsonPath), library[1]);
  } catch {
    return null;
  }
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  let settled = false;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve(value) {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    },
    reject(error) {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
    get settled() {
      return settled;
    },
  };
}

function parseHeaderBlock(block) {
  const lines = block.split(/\r?\n/);
  const statusLine = lines.shift()?.trim() || "";
  const statusMatch = /^HTTP\/(\S+)\s+(\d{3})(?:\s+(.*))?$/i.exec(statusLine);
  if (!statusMatch) return null;

  const headers = Object.create(null);
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }

  return {
    protocol: statusMatch[1],
    status: Number(statusMatch[2]),
    statusText: statusMatch[3] || "",
    headers,
  };
}

function headersToObject(headers) {
  if (!headers) return Object.create(null);
  if (typeof headers.toObject === "function") return headers.toObject();
  if (typeof headers.entries === "function") return Object.fromEntries(headers.entries());
  return { ...headers };
}

function makeHeaders(values, decompressed) {
  const normalized = Object.create(null);
  for (const [name, value] of Object.entries(values || {})) {
    normalized[name.toLowerCase()] = String(value);
  }
  if (decompressed) {
    // libcurl has already decoded the body, so these wire-level fields are stale.
    delete normalized["content-encoding"];
    delete normalized["content-length"];
  }

  if (typeof globalThis.Headers === "function") return new globalThis.Headers(normalized);
  return {
    get(name) {
      return normalized[String(name).toLowerCase()] ?? null;
    },
    has(name) {
      return Object.hasOwn(normalized, String(name).toLowerCase());
    },
    entries() {
      return Object.entries(normalized)[Symbol.iterator]();
    },
    [Symbol.iterator]() {
      return this.entries();
    },
  };
}

async function readWebStream(body) {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function createFetchLikeResponse({ status, statusText, headers, body, bufferedContent = null, decompressed = false }) {
  const responseHeaders = makeHeaders(headers, decompressed);
  let bodyUsed = false;

  return {
    status,
    statusText: statusText || "",
    ok: status >= 200 && status < 300,
    headers: responseHeaders,
    body,
    get bodyUsed() {
      return bodyUsed;
    },
    async text() {
      if (bodyUsed) throw new TypeError("Response body is already used");
      bodyUsed = true;
      const content = bufferedContent === null ? await readWebStream(body) : bufferedContent;
      return content.toString("utf8");
    },
    async json() {
      return JSON.parse(await this.text());
    },
    async arrayBuffer() {
      if (bodyUsed) throw new TypeError("Response body is already used");
      bodyUsed = true;
      const content = bufferedContent === null ? await readWebStream(body) : bufferedContent;
      return content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength);
    },
  };
}

function responseInfoFromImpers(response) {
  return {
    status: response.statusCode ?? response.status ?? 0,
    statusText: response.statusText || "",
    headers: headersToObject(response.headers),
  };
}

function setStatusProtocol(status, response) {
  status.lastNegotiatedHttpVersion = response?.httpVersionString || null;
  status.lastRequestAt = new Date().toISOString();
  status.lastError = null;
}

function makeTimeoutError(timeoutMs) {
  const error = new Error(`Upstream request timed out after ${timeoutMs} ms`);
  error.name = "TimeoutError";
  return error;
}

function makeHttp2Error(protocol) {
  return new Error(`Upstream negotiated HTTP/${protocol || "unknown"}; HTTP/2 with h2 ALPN is required`);
}

function supportedNativeProfile(api, profile) {
  return Array.isArray(api.NATIVE_IMPERSONATE_TARGETS)
    && api.NATIVE_IMPERSONATE_TARGETS.some((target) => target.target_name === profile);
}

/**
 * Shared Zen client built on libcurl-impersonate. It refuses ordinary libcurl
 * fallback, requires Chrome/BoringSSL HTTP/2 only for HTTPS OpenCode hosts, and
 * presents a Fetch-shaped response to the existing proxy/probe code.
 */
export function createZenTransport({
  profile = process.env.ZEN_TLS_PROFILE || DEFAULT_PROFILE,
  maxConnections = 32,
  maxStreamBufferBytes = 16 * 1024 * 1024,
  sessionFactory,
} = {}) {
  const status = {
    ready: false,
    tlsImpersonation: false,
    tlsBackend: null,
    libcurlVersion: null,
    profile,
    transport: "libcurl-impersonate (not ready)",
    lastNegotiatedHttpVersion: null,
    lastRequestAt: null,
    lastError: null,
  };
  let session = null;
  let api = null;
  let initialization = null;
  let closed = false;

  const initialize = async () => {
    if (closed) throw new Error("Zen transport is closed");
    if (initialization) return initialization;

    initialization = (async () => {
      if (sessionFactory) {
        const injected = await sessionFactory({ profile });
        session = injected.session || injected;
        api = injected.api || injected;
        status.ready = true;
        status.tlsImpersonation = injected.tlsImpersonation === true;
        status.tlsBackend = injected.tlsBackend || null;
        status.libcurlVersion = injected.libcurlVersion || null;
        status.transport = injected.transport || "test/mock transport";
        status.lastError = null;
        return;
      }

      if (!process.env.LIBCURL_IMPERSONATE_PATH && !process.env.LIBCURL_PATH) {
        const bundled = bundledLibcurlPath();
        if (bundled) process.env.LIBCURL_IMPERSONATE_PATH = bundled;
      }

      api = await import("impers");
      const usingImpersonate = await api.isUsingImpersonate();
      const nativeSupport = await api.Curl.hasImpersonateSupport();
      if (!usingImpersonate || !nativeSupport) {
        throw new Error(
          "The native libcurl-impersonate library is unavailable. Install the platform optional dependency or set LIBCURL_IMPERSONATE_PATH; ordinary libcurl fallback is disabled.",
        );
      }
      const libcurlVersion = api.Curl.version();
      if (!/BoringSSL/i.test(libcurlVersion)) {
        throw new Error(`A BoringSSL-backed Chrome transport is required; loaded ${libcurlVersion}`);
      }
      if (!supportedNativeProfile(api, profile)) {
        throw new Error(`The installed libcurl-impersonate does not provide the ${profile} profile`);
      }

      session = new api.Session({
        maxConnections,
        maxHostConnections: maxConnections,
        http2Multiplexing: true,
        decodeContent: true,
      });
      status.ready = true;
      status.tlsImpersonation = true;
      status.tlsBackend = "BoringSSL";
      status.libcurlVersion = libcurlVersion;
      status.transport = "libcurl-impersonate / BoringSSL Chrome profile";
      status.lastError = null;
    })().catch((error) => {
      status.ready = false;
      status.tlsImpersonation = false;
      status.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    });

    return initialization;
  };

  const transport = {
    async prepare() {
      await initialize();
      return this.getStatus();
    },

    getStatus() {
      return { ...status };
    },

    async request({
      url,
      method = "GET",
      headers = {},
      body,
      signal,
      timeoutMs = 120_000,
      stream = false,
      verify = true,
      requireHttp2 = false,
    }) {
      await initialize();
      if (closed) throw new Error("Zen transport is closed");
      const parsedUrl = new URL(url);
      const isOpenCode = isOpenCodeHost(parsedUrl.hostname);
      if (isOpenCode && parsedUrl.protocol !== "https:") {
        throw new Error("OpenCode upstream requests require HTTPS with HTTP/2 h2");
      }
      const requiresHttp2 = isOpenCode || requireHttp2 === true;
      if (requiresHttp2 && parsedUrl.protocol !== "https:") {
        throw new Error("HTTP/2 h2 can only be required over HTTPS");
      }

      const requestHeaders = { ...headers };
      const acceptEncodingHeader = Object.keys(requestHeaders).find((name) => name.toLowerCase() === "accept-encoding");
      if (!acceptEncodingHeader) {
        requestHeaders["Accept-Encoding"] = stream ? "gzip, deflate, br, zstd" : "gzip, deflate, br";
      } else if (!stream) {
        // Buffered model-list responses use impers' gzip/deflate/br decoder;
        // avoid advertising zstd there until its buffered decoder is supported.
        requestHeaders[acceptEncodingHeader] = "gzip, deflate, br";
      }

      const requestAbort = new AbortController();
      let timedOut = false;
      let timeoutTimer = null;
      const onCallerAbort = () => requestAbort.abort(signal.reason || new Error("Client disconnected"));
      if (signal?.aborted) onCallerAbort();
      else signal?.addEventListener("abort", onCallerAbort, { once: true });
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          requestAbort.abort(makeTimeoutError(timeoutMs));
        }, timeoutMs);
        timeoutTimer.unref?.();
      }

      const requestTimeoutSeconds = Math.max(1, Math.ceil((timeoutMs > 0 ? timeoutMs : 120_000) / 1000));
      const streamOutput = stream ? new PassThrough({ highWaterMark: 64 * 1024 }) : null;
      const webBody = streamOutput ? Readable.toWeb(streamOutput) : null;
      const responseHeaders = deferred();
      let rawHeaderBuffer = "";
      let discardRedirectBody = false;
      let redirectError = null;

      const settleHeaderBlock = (block) => {
        const info = parseHeaderBlock(block);
        if (!info) return;
        if (info.status >= 100 && info.status < 200 && info.status !== 101) return;
        if (requiresHttp2 && stream && info.protocol !== "2") {
          const error = makeHttp2Error(info.protocol);
          status.lastRequestAt = new Date().toISOString();
          status.lastError = error.message;
          requestAbort.abort(error);
          if (streamOutput && !streamOutput.destroyed) streamOutput.destroy(error);
          responseHeaders.reject(error);
          return;
        }

        const isRedirect = REDIRECT_STATUSES.has(info.status) && Boolean(info.headers.location);
        if (isRedirect) {
          if (requiresHttp2) {
            let target;
            try {
              target = new URL(info.headers.location, parsedUrl);
            } catch {
              target = null;
            }
            const withinHttp2Scope = target && (isOpenCode
              ? target.protocol === "https:" && isOpenCodeHost(target.hostname)
              : target.origin === parsedUrl.origin);
            if (!withinHttp2Scope) {
              redirectError = new Error(
                `HTTP/2 upstream redirected outside its allowed host scope: ${info.headers.location}`,
              );
              status.lastRequestAt = new Date().toISOString();
              status.lastError = redirectError.message;
              requestAbort.abort(redirectError);
              if (streamOutput && !streamOutput.destroyed) streamOutput.destroy(redirectError);
              if (stream) responseHeaders.reject(redirectError);
              return;
            }
          }
          discardRedirectBody = true;
          return;
        }

        discardRedirectBody = false;
        responseHeaders.resolve(info);
      };

      const onHeader = (chunk) => {
        rawHeaderBuffer += Buffer.from(chunk).toString("latin1");
        while (true) {
          const separator = /\r?\n\r?\n/.exec(rawHeaderBuffer);
          if (!separator) return;
          const block = rawHeaderBuffer.slice(0, separator.index);
          rawHeaderBuffer = rawHeaderBuffer.slice(separator.index + separator[0].length);
          settleHeaderBlock(block);
        }
      };

      const onContent = (chunk) => {
        if (discardRedirectBody || !streamOutput || streamOutput.destroyed) return;
        streamOutput.write(chunk);
        if (streamOutput.writableLength > maxStreamBufferBytes) {
          const error = new Error("Upstream stream exceeded the configured buffer limit");
          requestAbort.abort(error);
          streamOutput.destroy(error);
        }
      };

      const httpVersion = requiresHttp2 ? "2" : "1.1";
      const curlHttpVersion = requiresHttp2
        ? api.CurlHttpVersion.CURL_HTTP_VERSION_2TLS
        : api.CurlHttpVersion.CURL_HTTP_VERSION_1_1;
      const curlOptions = {
        [api.CurlOpt.HTTP_VERSION]: curlHttpVersion,
        ...(stream ? { [api.CurlOpt.ACCEPT_ENCODING]: "" } : {}),
      };

      let operation;
      try {
        operation = session.request(method, url, {
          headers: requestHeaders,
          ...(body !== undefined ? { content: body } : {}),
          timeout: requestTimeoutSeconds,
          connectTimeout: Math.min(requestTimeoutSeconds, 30),
          readTimeout: requestTimeoutSeconds,
          signal: requestAbort.signal,
          verify,
          allowRedirects: true,
          maxRedirects: 5,
          httpVersion,
          impersonate: profile,
          defaultHeaders: false,
          stream,
          curlOptions,
          headerCallback: onHeader,
          ...(stream ? { contentCallback: onContent } : {}),
        });
      } catch (error) {
        clearTimeout(timeoutTimer);
        signal?.removeEventListener("abort", onCallerAbort);
        status.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      }

      const finishRequest = (response) => {
        if (redirectError) throw redirectError;
        if (requiresHttp2 && response?.httpVersionString !== "2") {
          const error = makeHttp2Error(response?.httpVersionString);
          status.lastRequestAt = new Date().toISOString();
          status.lastError = error.message;
          if (streamOutput && !streamOutput.destroyed) streamOutput.destroy(error);
          responseHeaders.reject(error);
          return response;
        }
        setStatusProtocol(status, response);
        if (streamOutput && !streamOutput.destroyed) streamOutput.end();
        if (!responseHeaders.settled) responseHeaders.resolve(responseInfoFromImpers(response));
        return response;
      };
      const failRequest = (error) => {
        const failure = redirectError || error;
        status.lastRequestAt = new Date().toISOString();
        status.lastError = failure instanceof Error ? failure.message : String(failure);
        if (streamOutput && !streamOutput.destroyed) streamOutput.destroy(failure);
        responseHeaders.reject(failure);
      };
      const cleanup = () => {
        clearTimeout(timeoutTimer);
        signal?.removeEventListener("abort", onCallerAbort);
      };

      if (!stream) {
        try {
          const response = await operation;
          if (requiresHttp2 && response?.httpVersionString !== "2") throw makeHttp2Error(response?.httpVersionString);
          finishRequest(response);
          const info = responseInfoFromImpers(response);
          const content = Buffer.from(response.content || []);
          const bodyStream = Readable.toWeb(Readable.from(content.length ? [content] : []));
          return createFetchLikeResponse({
            ...info,
            body: bodyStream,
            bufferedContent: content,
          });
        } catch (error) {
          const failure = redirectError || error;
          status.lastRequestAt = new Date().toISOString();
          status.lastError = failure instanceof Error ? failure.message : String(failure);
          if (timedOut) throw makeTimeoutError(timeoutMs);
          throw failure;
        } finally {
          cleanup();
        }
      }

      operation.then(finishRequest, failRequest).finally(cleanup).catch(() => {});
      try {
        const info = await responseHeaders.promise;
        return createFetchLikeResponse({
          ...info,
          body: webBody,
          decompressed: true,
        });
      } catch (error) {
        if (timedOut) throw makeTimeoutError(timeoutMs);
        throw error;
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      if (initialization) {
        try {
          await initialization;
        } catch {
          return;
        }
      }
      if (session?.close) await session.close();
      status.ready = false;
      status.tlsImpersonation = false;
    },
  };

  return transport;
}

let sharedTransport;

/** Lazily shared client for standalone probes and maintenance scripts. */
export function defaultZenTransport(options) {
  sharedTransport ||= createZenTransport(options);
  return sharedTransport;
}
