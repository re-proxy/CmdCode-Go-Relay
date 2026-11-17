import { randomUUID } from "node:crypto";
import { config } from "./config.mjs";
import { mergeAdjacent, parseJsonObject, stringifyToolResult } from "./wire.mjs";

/**
 * OpenAI Responses API (`POST /v1/responses`).
 *
 * The gateway only speaks the chat-completions wire, so this module owns the
 * translation in both directions: Responses `input` items become gateway
 * messages, and gateway events become a `response` object (or a stream of
 * `response.*` events). Clients such as Codex send this shape and reject a
 * chat-completion body, so the two cannot be conflated.
 */

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "input_text" || part?.type === "output_text" || part?.type === "text") {
        return part.text ?? "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Converts a Responses request body into gateway messages plus a system prompt.
 *
 * Tool calls round-trip as `function_call` items and their results as
 * `function_call_output` items, which is how Responses expresses a tool turn.
 */
export function messagesFromResponses(body) {
  const systemChunks = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    systemChunks.push(body.instructions);
  }

  const wire = [];
  const toolNames = new Map();
  const input = body.input;

  const items =
    typeof input === "string"
      ? [{ role: "user", content: input }]
      : Array.isArray(input)
        ? input
        : Array.isArray(body.messages)
          ? body.messages
          : [];

  for (const item of items) {
    if (!item) continue;
    if (typeof item === "string") {
      wire.push({ role: "user", content: [{ type: "text", text: item }] });
      continue;
    }

    if (item.type === "function_call") {
      const id = item.call_id ?? item.id ?? `call_${randomUUID().slice(0, 8)}`;
      const name = item.name ?? "unknown";
      toolNames.set(id, name);
      wire.push({
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: id,
            toolName: name,
            input: parseJsonObject(item.arguments),
          },
        ],
      });
      continue;
    }

    if (item.type === "function_call_output") {
      const id = item.call_id ?? "";
      wire.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: id,
            toolName: toolNames.get(id) ?? "unknown",
            output: { type: "text", value: stringifyToolResult(item.output) },
          },
        ],
      });
      continue;
    }

    // `message` items and bare role-bearing items both carry content.
    const role = item.role ?? "user";
    const text = textFromContent(item.content);
    if (role === "system" || role === "developer") {
      if (text.trim()) systemChunks.push(text);
      continue;
    }
    if (!text && !Array.isArray(item.content)) continue;
    wire.push({ role: role === "assistant" ? "assistant" : "user", content: [{ type: "text", text }] });
  }

  return { messages: mergeAdjacent(wire), system: systemChunks.join("\n\n") };
}

/** Responses tools are flatter: `{type:"function", name, parameters}`. */
export function toolsFromResponses(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const tool of tools) {
    if (!tool || tool.type !== "function" || !tool.name) continue;
    out.push({
      name: tool.name,
      description: tool.description ?? "",
      input_schema: tool.parameters ?? { type: "object", properties: {} },
    });
  }
  return out;
}

export function reasoningEffortFromResponses(body) {
  const effort = body.reasoning?.effort ?? body.reasoning_effort;
  if (typeof effort !== "string") return undefined;
  const value = effort.toLowerCase();
  if (value === "none") return "off";
  if (value === "minimal") return "low";
  return EFFORTS.has(value) ? value : undefined;
}

export function maxOutputTokensFromResponses(body) {
  const value = Number(body.max_output_tokens ?? body.max_tokens);
  if (Number.isFinite(value) && value > 0) return Math.min(value, config.maxOutputTokens);
  return config.maxOutputTokens;
}

export function usageFromResponses(usage) {
  const input = usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: usage.cache_read_tokens },
    output_tokens: usage.output_tokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input + usage.output_tokens,
  };
}

function baseResponse({ id, model, createdAt }) {
  return {
    id,
    object: "response",
    created_at: createdAt,
    status: "in_progress",
    model,
    output: [],
    output_text: "",
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    parallel_tool_calls: true,
    temperature: 1,
    top_p: 1,
    max_output_tokens: null,
    previous_response_id: null,
    tool_choice: "auto",
    tools: [],
    truncation: "disabled",
  };
}

/** Non-streaming response object, plus the parts a caller needs for usage. */
export function buildResponseObject({ id, model, createdAt, events }) {
  const response = baseResponse({ id, model, createdAt });
  const output = [];
  let text = "";
  let reasoning = "";
  let usage = null;
  let finishReason = "stop";

  events.forEach((event) => {
    switch (event.type) {
      case "text":
        text += event.text;
        break;
      case "reasoning":
        reasoning += event.text;
        break;
      case "tool_call":
        output.push({
          type: "function_call",
          id: `fc_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
          call_id: event.id || `call_${randomUUID().slice(0, 8)}`,
          name: event.name,
          arguments: JSON.stringify(event.input ?? {}),
          status: "completed",
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

  const message = {
    type: "message",
    id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    status: "completed",
    role: "assistant",
    content: text ? [{ type: "output_text", text, annotations: [] }] : [],
  };
  // Reasoning summaries belong in `reasoning`, not in the message text.
  const ordered = [...output];
  if (text) ordered.unshift(message);

  response.output = ordered;
  response.output_text = text;
  response.status = "completed";
  if (reasoning) {
    response.reasoning = { effort: null, summary: [{ type: "summary_text", text: reasoning }] };
  }
  if (usage) response.usage = usageFromResponses(usage);
  if (finishReason === "length") {
    response.status = "incomplete";
    response.incomplete_details = { reason: "max_output_tokens" };
  }
  return response;
}

/**
 * Streams the Responses event sequence. The terminal `response.completed`
 * event carries the same object a non-streaming call would return.
 */
export async function writeResponseStream(res, { id, model, createdAt, events }) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  let sequence = 0;
  const send = (type, payload) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...payload })}\n\n`);
  };

  const response = baseResponse({ id, model, createdAt });
  send("response.created", { response });
  send("response.in_progress", { response });

  const collected = [];
  let messageItem = null;
  let text = "";
  let reasoning = "";
  let usage = null;
  let finishReason = "stop";
  let outputIndex = 0;

  const openMessage = () => {
    if (messageItem) return;
    messageItem = {
      type: "message",
      id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
      status: "in_progress",
      role: "assistant",
      content: [],
    };
    send("response.output_item.added", {
      output_index: outputIndex,
      item: messageItem,
    });
    send("response.content_part.added", {
      item_id: messageItem.id,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
  };

  const closeMessage = () => {
    if (!messageItem) return;
    send("response.output_text.done", {
      item_id: messageItem.id,
      output_index: outputIndex,
      content_index: 0,
      text,
    });
    send("response.content_part.done", {
      item_id: messageItem.id,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text, annotations: [] },
    });
    const done = { ...messageItem, status: "completed", content: text ? [{ type: "output_text", text, annotations: [] }] : [] };
    send("response.output_item.done", { output_index: outputIndex, item: done });
    collected.push(done);
    messageItem = null;
    text = "";
    outputIndex += 1;
  };

  await events((event) => {
    switch (event.type) {
      case "text": {
        openMessage();
        text += event.text;
        send("response.output_text.delta", {
          item_id: messageItem.id,
          output_index: outputIndex,
          content_index: 0,
          delta: event.text,
        });
        break;
      }
      case "reasoning": {
        reasoning += event.text;
        break;
      }
      case "tool_call": {
        closeMessage();
        const item = {
          type: "function_call",
          id: `fc_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
          call_id: event.id || `call_${randomUUID().slice(0, 8)}`,
          name: event.name,
          arguments: JSON.stringify(event.input ?? {}),
          status: "completed",
        };
        send("response.output_item.added", { output_index: outputIndex, item });
        send("response.output_item.done", { output_index: outputIndex, item });
        collected.push(item);
        outputIndex += 1;
        break;
      }
      case "finish": {
        usage = event.usage;
        finishReason = event.finishReason;
        break;
      }
      default:
        break;
    }
  });

  closeMessage();

  response.output = collected;
  response.output_text = collected
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content.map((part) => part.text))
    .join("");
  response.status = finishReason === "length" ? "incomplete" : "completed";
  if (finishReason === "length") response.incomplete_details = { reason: "max_output_tokens" };
  if (reasoning) {
    response.reasoning = { effort: null, summary: [{ type: "summary_text", text: reasoning }] };
  }
  if (usage) response.usage = usageFromResponses(usage);

  send(finishReason === "length" ? "response.incomplete" : "response.completed", { response });
  res.end();
  return response;
}

/** Error body shape for the Responses API. */
export function responsesError(error) {
  const status = Number(error?.status) || 500;
  return {
    status,
    body: {
      error: {
        message: error?.message ?? "Internal error",
        type: status === 401 ? "invalid_request_error" : "api_error",
        code: error?.code ?? null,
        param: null,
      },
    },
  };
}
