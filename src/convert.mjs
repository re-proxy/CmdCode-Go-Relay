import { randomUUID } from "node:crypto";
import { config } from "./config.mjs";

export class HttpError extends Error {
  constructor(status, message, { code, type } = {}) {
    super(message);
    this.status = status;
    this.code = code ?? null;
    this.type = type ?? null;
  }
}

/** Maps internal failures onto OpenAI-shaped error bodies. */
export function openaiError(error) {
  const status = Number(error?.status) || 500;
  const type =
    status === 401
      ? "invalid_request_error"
      : status === 429
        ? "rate_limit_error"
        : status === 400
          ? "invalid_request_error"
          : "api_error";
  return {
    status,
    body: {
      error: {
        message: error?.message ?? "Internal error",
        type,
        param: null,
        code: error?.code ?? null,
      },
    },
  };
}

/** Maps internal failures onto Anthropic-shaped error bodies. */
export function anthropicError(error) {
  const status = Number(error?.status) || 500;
  const type =
    status === 401
      ? "authentication_error"
      : status === 403
        ? "permission_error"
        : status === 404
          ? "not_found_error"
          : status === 429
            ? "rate_limit_error"
            : status === 400 || status === 422
              ? "invalid_request_error"
              : "api_error";
  return {
    status,
    body: {
      type: "error",
      error: { type, message: error?.message ?? "Internal error" },
    },
  };
}

function sseChunk(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Streams an OpenAI chat completion.
 * `events` is an async callable that yields normalized gateway events.
 */
export async function streamOpenAIChat(res, { id, model, created, events, includeUsage }) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const base = { id, object: "chat.completion.chunk", created, model };
  sseChunk(res, {
    ...base,
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  });

  let toolIndex = 0;
  let pendingTool = null;
  let usage = null;
  let finishReason = "stop";
  let closed = false;

  const flushTool = () => {
    if (!pendingTool) return;
    sseChunk(res, {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: toolIndex,
                id: pendingTool.id,
                type: "function",
                function: {
                  name: pendingTool.name,
                  arguments: JSON.stringify(pendingTool.input ?? {}),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    toolIndex += 1;
    pendingTool = null;
  };

  try {
    await events((event) => {
      if (closed) return;
      switch (event.type) {
        case "text": {
          sseChunk(res, {
            ...base,
            choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }],
          });
          break;
        }
        case "reasoning": {
          sseChunk(res, {
            ...base,
            choices: [{ index: 0, delta: { reasoning_content: event.text }, finish_reason: null }],
          });
          break;
        }
        case "tool_call": {
          flushTool();
          pendingTool = {
            id: event.id || `call_${randomUUID().slice(0, 8)}`,
            name: event.name,
            input: event.input,
          };
          break;
        }
        case "finish": {
          flushTool();
          usage = event.usage;
          finishReason = event.finishReason === "tool_calls" ? "tool_calls" : event.finishReason;
          break;
        }
        default:
          break;
      }
    });
  } catch (error) {
    // The response is already committed, so the only honest signal left is an
    // error frame followed by the terminating sentinel. A client that hung up
    // makes those writes throw in turn, which is expected and swallowed.
    closed = true;
    try {
      if (!res.writableEnded) {
        sseChunk(res, {
          error: {
            message: error?.message ?? "Upstream failed mid-stream",
            type: "api_error",
            code: error?.code ?? "upstream_stream_error",
          },
        });
        res.write("data: [DONE]\n\n");
        res.end();
      }
    } catch {
      // Client is gone; nothing left to report to.
    }
    throw error;
  }

  sseChunk(res, {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  });

  if (includeUsage && usage) {
    sseChunk(res, {
      ...base,
      choices: [],
      usage: {
        prompt_tokens: usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens,
        completion_tokens: usage.output_tokens,
        total_tokens:
          usage.input_tokens +
          usage.cache_read_tokens +
          usage.cache_write_tokens +
          usage.output_tokens,
        prompt_tokens_details: {
          cached_tokens: usage.cache_read_tokens,
        },
      },
    });
  }

  res.write("data: [DONE]\n\n");
  res.end();
  closed = true;
  return { usage, finishReason };
}

/** Non-streaming OpenAI completion. */
export async function collectOpenAI(events) {
  let text = "";
  let reasoning = "";
  const toolCalls = [];
  let usage = null;
  let finishReason = "stop";

  await events((event) => {
    switch (event.type) {
      case "text":
        text += event.text;
        break;
      case "reasoning":
        reasoning += event.text;
        break;
      case "tool_call":
        toolCalls.push({
          id: event.id || `call_${randomUUID().slice(0, 8)}`,
          type: "function",
          function: { name: event.name, arguments: JSON.stringify(event.input ?? {}) },
        });
        break;
      case "finish":
        usage = event.usage;
        finishReason = event.finishReason;
        break;
      default:
        break;
    }
  });

  const message = { role: "assistant", content: text || (toolCalls.length ? null : "") };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;

  return {
    message,
    finishReason,
    usage: usage ?? { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 },
  };
}

export function openAIUsage(usage) {
  const prompt = usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens;
  return {
    prompt_tokens: prompt,
    completion_tokens: usage.output_tokens,
    total_tokens: prompt + usage.output_tokens,
    prompt_tokens_details: { cached_tokens: usage.cache_read_tokens },
  };
}

/** Anthropic SSE framing helpers. */
export function sseEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function anthropicMessageStart(res, { id, model, usage }) {
  sseEvent(res, "message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: usage?.input_tokens ?? 0,
        output_tokens: 0,
        cache_read_input_tokens: usage?.cache_read_tokens ?? 0,
        cache_creation_input_tokens: usage?.cache_write_tokens ?? 0,
      },
    },
  });
}

export function anthropicMessageDelta(res, { finishReason, usage }) {
  sseEvent(res, "message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: finishReason === "tool_calls" ? "tool_use" : finishReason === "length" ? "max_tokens" : "end_turn",
      stop_sequence: null,
    },
    usage: {
      input_tokens: usage?.input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
    },
  });
}

export function anthropicMaxOutputTokens(requested) {
  const value = Number(requested);
  if (Number.isFinite(value) && value > 0) return Math.min(value, config.maxOutputTokens);
  return config.maxOutputTokens;
}
