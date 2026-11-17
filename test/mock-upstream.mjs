import http from "node:http";

/**
 * Mock of the Command Code gateway used by the offline test suite.
 * Speaks the same wire shape the official CLI consumes, so the relay's
 * translation layer is exercised end to end without a real subscription.
 */
export function startMockUpstream({ port = 0 } = {}) {
  const requests = [];
  let active = 0;
  let peak = 0;

  const models = {
    object: "list",
    data: [
      {
        id: "deepseek/deepseek-v4.1-flash",
        object: "model",
        created: 1794915903,
        owned_by: "command-code",
        name: "DeepSeek V4.1 Flash",
        context_length: 1000000,
        supported_endpoints: ["/chat/completions", "/responses"],
      },
      {
        id: "claude-sonnet-5",
        object: "model",
        created: 1794915903,
        owned_by: "command-code",
        name: "Claude Sonnet 5",
        context_length: 1000000,
        supported_endpoints: ["/messages"],
      },
    ],
  };

  const clientModels = {
    catalogVersion: "test",
    data: [
      {
        id: "deepseek/deepseek-v4.1-flash",
        category: "opensource",
        context_length: 1000000,
        minimumPlan: "individual-go",
        reasoningEfforts: ["off", "low", "high", "max"],
        inputModalities: ["text", "image"],
        pricing: { inputCost: 0.15, outputCost: 0.6 },
        display: { label: "DeepSeek V4.1 Flash" },
      },
      {
        id: "claude-sonnet-5",
        category: "premium",
        context_length: 1000000,
        minimumPlan: "individual-pro",
        reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
        inputModalities: ["text", "image"],
        pricing: { inputCost: 2, outputCost: 10 },
        display: { label: "Claude Sonnet 5" },
      },
      {
        // Present in the CLI catalog only, like the real free/stealth tiers.
        id: "MiniMaxAI/MiniMax-M3-Free",
        aliases: ["minimax-m3-free"],
        hidden: true,
        category: "opensource",
        context_length: 1000000,
        minimumPlan: "individual-go",
        reasoningEfforts: ["low", "medium", "high"],
        inputModalities: ["text", "image"],
        pricing: { inputCost: 0.3, outputCost: 1.2 },
        display: { label: "MiniMax M3", badge: "free" },
      },
    ],
  };

  function sse(res, event) {
    res.write(JSON.stringify(event) + "\n");
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      body = {};
    }
    requests.push({ method: req.method, path: url.pathname, headers: req.headers, body });

    const auth = req.headers.authorization ?? "";
    const validKey = auth === "Bearer test-key-good";

    if (url.pathname === "/provider/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(url.searchParams.get("view") === "client" ? clientModels : models));
      return;
    }

    if (url.pathname === "/alpha/whoami") {
      if (!validKey) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: false, error: { code: "UNAUTHORIZED", message: "Invalid token" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          user: { id: "u_1", userName: "tester", name: "Tester" },
          org: { id: "o_1", login: "tester", planId: "individual-go" },
          orgLimits: [{ window: "monthly", used: 120, cap: 400 }],
        }),
      );
      return;
    }

    if (url.pathname === "/alpha/billing/credits") {
      res.writeHead(200, { "content-type": "application/json" });
      const now = Date.now();
      res.end(
        JSON.stringify({
          credits: { monthlyCredits: 4.5, purchasedCredits: 1, freeCredits: 0, planId: "individual-go" },
          windowLimits: {
            limited: true,
            fiveHour: { used: 30, cap: 100, resetAt: now + 90 * 60 * 1000 },
            weekly: { used: 220, cap: 1000, resetAt: now + 3 * 86400 * 1000 },
          },
          sandboxMinutes: { usedMinutes: 12, limitMinutes: 60, resetAt: now + 20 * 86400 * 1000 },
          sandboxAccess: true,
        }),
      );
      return;
    }

    if (url.pathname === "/alpha/billing/subscriptions") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          data: {
            planId: "individual-go",
            status: "active",
            currentPeriodStart: "2026-11-01T00:00:00.000Z",
            currentPeriodEnd: "2026-12-01T00:00:00.000Z",
          },
        }),
      );
      return;
    }

    if (url.pathname === "/alpha/usage/summary") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ totalCount: 42, totalCost: 5.5, periodBasis: "billing-period" }));
      return;
    }

    if (url.pathname === "/alpha/generate") {
      if (!validKey) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: false, error: { code: "UNAUTHORIZED", message: "Invalid token" } }));
        return;
      }
      if (req.headers["x-command-code-version"] === "0.0.1") {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({
          error: {
            code: "upgrade_required",
            message: "Your Command Code CLI is out of date.",
            minVersion: "9.9.9",
          },
        }));
        return;
      }
      if (req.headers["x-command-code-version"] === undefined) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: false, error: { code: "BAD_REQUEST", message: "missing cli version" } }));
        return;
      }
      const model = body?.params?.model;
      const slow = JSON.stringify(body?.params?.messages ?? "").includes("SLOW");
      if (slow) {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 300));
        active -= 1;
      }
      const hasTools = Array.isArray(body?.params?.tools) && body.params.tools.length > 0;
      const wantsTool =
        hasTools && JSON.stringify(body?.params?.messages ?? "").includes("USE_TOOL");
      const wantsError = JSON.stringify(body?.params?.messages ?? "").includes("TRIGGER_ERROR");
      const wantsMidError = JSON.stringify(body?.params?.messages ?? "").includes("TRIGGER_MID_ERROR");

      res.writeHead(200, { "content-type": "text/event-stream" });
      sse(res, { type: "text-start", id: "t1" });
      if (wantsError) {
        sse(res, { type: "error", error: { message: "premium_credits_exhausted", statusCode: 403 } });
        res.end();
        return;
      }
      sse(res, { type: "reasoning-start" });
      sse(res, { type: "reasoning-delta", text: "thinking..." });
      sse(res, { type: "reasoning-end" });
      sse(res, { type: "text-delta", text: "hello " });
      if (wantsMidError) {
        sse(res, { type: "error", error: { message: "upstream blew up mid-stream", statusCode: 500 } });
        res.end();
        return;
      }
      sse(res, { type: "text-delta", text: "world" });
      if (wantsTool) {
        sse(res, {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "get_weather",
          input: { city: "Beijing" },
        });
      }
      sse(res, {
        type: "finish",
        finishReason: wantsTool ? "tool-calls" : "stop",
        rawFinishReason: wantsTool ? "tool-calls" : "stop",
        totalUsage: {
          inputTokens: 12,
          outputTokens: 7,
          inputTokenDetails: { cacheReadTokens: 3, cacheWriteTokens: 0 },
        },
      });
      res.end();
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const actual = server.address().port;
      resolve({
        peak: () => peak,
        resetPeak: () => { peak = 0; },
        port: actual,
        base: `http://127.0.0.1:${actual}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
