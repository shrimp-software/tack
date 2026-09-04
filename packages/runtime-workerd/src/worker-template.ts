const COMPATIBILITY_DATE = "2026-07-01";

export function renderWorkerModule(input: {
  readonly token: string;
  readonly code: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxToolCalls: number;
}): string {
  return `
const RUNNER_TOKEN = ${JSON.stringify(input.token)};
const USER_CODE = ${JSON.stringify(input.code)};
const TIMEOUT_MS = ${input.timeoutMs};
const MAX_OUTPUT_BYTES = ${input.maxOutputBytes};
const MAX_TOOL_CALLS = ${input.maxToolCalls};

const formatLogArg = (value) => {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
};

const makeConsole = (logs) => ({
  log: (...args) => logs.push("[log] " + args.map(formatLogArg).join(" ")),
  info: (...args) => logs.push("[info] " + args.map(formatLogArg).join(" ")),
  warn: (...args) => logs.push("[warn] " + args.map(formatLogArg).join(" ")),
  error: (...args) => logs.push("[error] " + args.map(formatLogArg).join(" ")),
  debug: (...args) => logs.push("[debug] " + args.map(formatLogArg).join(" ")),
});

const callTool = async (env, counters, path, args = {}) => {
  counters.toolCalls += 1;
  if (counters.toolCalls > MAX_TOOL_CALLS) {
    throw new Error("Exceeded maximum tool calls: " + MAX_TOOL_CALLS);
  }

  const response = await env.HOST.fetch("http://host/tool", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-tack-token": RUNNER_TOKEN
    },
    body: JSON.stringify({ path, args })
  });
  const data = await response.json();
  if (!data.ok) {
    const code = data.code === "downstream_error" ? "[tack:downstream_error] " : "";
    throw new Error(code + (data.error || "Tool bridge failed"));
  }
  return data.result;
};

const serializeResponse = (body) => {
  const text = JSON.stringify(body);
  if (text.length > MAX_OUTPUT_BYTES) {
    return JSON.stringify({
      ok: false,
      emitted: [],
      logs: body.logs ?? [],
      error: {
        phase: "runtime",
        message: "Execution output exceeded " + MAX_OUTPUT_BYTES + " bytes"
      }
    });
  }
  return text;
};

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/__health") {
      return Response.json({ ok: true, runnerToken: RUNNER_TOKEN });
    }
    if (new URL(request.url).pathname !== "/run") {
      return new Response("Not Found", { status: 404 });
    }

    const emitted = [];
    const logs = [];
    const counters = { toolCalls: 0 };
    const sandboxConsole = makeConsole(logs);
    const emit = (value) => { emitted.push(value); };
    const invoke = (path, args = {}) => callTool(env, counters, path, args);

    try {
      const fn = env.UNSAFE_EVAL.eval(USER_CODE);
      const result = await Promise.race([
        fn(invoke, sandboxConsole, emit),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Workerd runtime execution timed out after " + TIMEOUT_MS + "ms")), TIMEOUT_MS))
      ]);
      return new Response(serializeResponse({ ok: true, result, emitted, logs }), {
        headers: { "content-type": "application/json" }
      });
    } catch (error) {
      return new Response(serializeResponse({
        ok: false,
        emitted,
        logs,
        error: {
          phase: String(error && error.message || error).includes("timed out") ? "timeout" : "runtime",
          code: String(error && error.message || error).includes("[tack:downstream_error]") ? "downstream_error" :
            (String(error && error.message || error).includes("timed out") ? "execution_timeout" : "internal_error"),
          message: String(error && error.message || error).replace(/^\\[tack:[a-z_]+\\] /, "")
        }
      }), {
        headers: { "content-type": "application/json" }
      });
    }
  }
};
`;
}

export function renderWorkerdConfig(input: {
  readonly listenPort: number;
  readonly hostPort: number;
  readonly memoryMb?: number;
}): string {
  return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    ( name = "main", worker = .mainWorker ),
    ( name = "blocked", worker = .blockedWorker ),
    ( name = "host", external = ( address = "127.0.0.1:${input.hostPort}", http = () ) )
  ],
  sockets = [
    ( name = "http", address = "127.0.0.1:${input.listenPort}", http = (), service = "main" )
  ],
  ${renderV8Flags(input.memoryMb)}
);

const mainWorker :Workerd.Worker = (
  modules = [
    ( name = "worker.js", esModule = embed "worker.js" )
  ],
  compatibilityDate = ${capnpString(COMPATIBILITY_DATE)},
  bindings = [
    ( name = "HOST", service = "host" ),
    ( name = "UNSAFE_EVAL", unsafeEval = void )
  ],
  globalOutbound = "blocked"
);

const blockedWorker :Workerd.Worker = (
  serviceWorkerScript = "addEventListener('fetch', event => { event.respondWith(new Response('Outbound fetch is blocked.', { status: 403 })); })",
  compatibilityDate = ${capnpString(COMPATIBILITY_DATE)}
);
`;
}

function renderV8Flags(memoryMb: number | undefined): string {
  if (!memoryMb) {
    return "";
  }

  return `v8Flags = [${capnpString(`--max-old-space-size=${memoryMb}`)}],`;
}

function capnpString(value: string): string {
  return JSON.stringify(value).replaceAll("\\u2028", "\\\\u2028").replaceAll("\\u2029", "\\\\u2029");
}
