/**
 * Shared conversion between the Command Code gateway wire format and the
 * public API formats (OpenAI Chat Completions / Anthropic Messages).
 *
 * Gateway wire messages, as produced by the official CLI:
 *   user      { role:"user", content:[{type:"text",text} | {type:"image",image,mimeType}] }
 *   assistant { role:"assistant", content:[{type:"text",text} | {type:"reasoning",text}
 *                                        | {type:"tool-call",toolCallId,toolName,input}] }
 *   tool      { role:"tool", content:[{type:"tool-result",toolCallId,toolName,output}] }
 * Tool schemas are `{ name, description, input_schema }`.
 */

export function textPart(text) {
  return { type: "text", text: String(text ?? "") };
}

export function imagePartFromDataUrl(url) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url ?? "");
  if (!match) return null;
  return { type: "image", image: url, mimeType: match[1] };
}

/** Flattens OpenAI-style message content into the gateway's part list. */
export function partsFromOpenAIContent(content) {
  if (typeof content === "string") return [textPart(content)];
  if (!Array.isArray(content)) return [];
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(textPart(item.text));
    } else if (item.type === "image_url" && item.image_url?.url) {
      const part = imagePartFromDataUrl(item.image_url.url);
      // Remote image URLs are not fetched by the relay; only inline data URLs
      // can be forwarded without an extra download step.
      if (part) parts.push(part);
      else parts.push(textPart(`[image omitted: ${item.image_url.url}]`));
    } else if (item.type === "input_text" && typeof item.text === "string") {
      parts.push(textPart(item.text));
    }
  }
  return parts;
}

export function stringifyToolResult(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = [];
    for (const item of content) {
      if (typeof item === "string") texts.push(item);
      else if (item?.type === "text" && typeof item.text === "string") texts.push(item.text);
    }
    return texts.join("\n");
  }
  if (content === undefined || content === null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** Converts OpenAI tools into gateway tool schemas. */
export function toolsFromOpenAI(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const tool of tools) {
    if (!tool || tool.type !== "function" || !tool.function?.name) continue;
    out.push({
      name: tool.function.name,
      description: tool.function.description ?? "",
      input_schema: tool.function.parameters ?? { type: "object", properties: {} },
    });
  }
  return out;
}

/**
 * Converts an OpenAI chat-completions `messages` array into gateway messages
 * plus a system prompt.
 */
export function messagesFromOpenAI(messages) {
  const systemChunks = [];
  const wire = [];
  const toolNames = new Map();

  for (const message of messages ?? []) {
    if (!message) continue;
    switch (message.role) {
      case "system":
      case "developer": {
        const text =
          typeof message.content === "string"
            ? message.content
            : partsFromOpenAIContent(message.content)
                .filter((p) => p.type === "text")
                .map((p) => p.text)
                .join("\n");
        if (text.trim()) systemChunks.push(text);
        break;
      }
      case "user": {
        wire.push({ role: "user", content: partsFromOpenAIContent(message.content) });
        break;
      }
      case "assistant": {
        const content = [];
        if (typeof message.content === "string" && message.content) {
          content.push(textPart(message.content));
        } else if (Array.isArray(message.content)) {
          for (const part of message.content) {
            if (part?.type === "text" && part.text) content.push(textPart(part.text));
          }
        }
        for (const call of message.tool_calls ?? []) {
          const name = call?.function?.name ?? "unknown";
          const id = call?.id ?? `call_${content.length}`;
          toolNames.set(id, name);
          content.push({
            type: "tool-call",
            toolCallId: id,
            toolName: name,
            input: parseJsonObject(call?.function?.arguments),
          });
        }
        if (content.length) wire.push({ role: "assistant", content });
        break;
      }
      case "tool": {
        const id = message.tool_call_id ?? "";
        wire.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: id,
              toolName: toolNames.get(id) ?? message.name ?? "unknown",
              output: { type: "text", value: stringifyToolResult(message.content) },
            },
          ],
        });
        break;
      }
      default:
        if (typeof message.content === "string") {
          wire.push({ role: "user", content: [textPart(message.content)] });
        }
    }
  }

  return { messages: mergeAdjacent(wire), system: systemChunks.join("\n\n") };
}

/** Same as above but for the Anthropic Messages shape. */
export function messagesFromAnthropic({ system, messages }) {
  const systemChunks = [];
  if (typeof system === "string") systemChunks.push(system);
  else if (Array.isArray(system)) {
    for (const block of system) {
      if (block?.type === "text" && block.text) systemChunks.push(block.text);
    }
  }

  const wire = [];
  const toolNames = new Map();

  for (const message of messages ?? []) {
    if (!message) continue;
    const blocks =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : Array.isArray(message.content)
          ? message.content
          : [];

    if (message.role === "assistant") {
      const content = [];
      for (const block of blocks) {
        if (block?.type === "text" && block.text) content.push(textPart(block.text));
        else if (block?.type === "thinking" && block.thinking) {
          content.push({ type: "reasoning", text: block.thinking });
        } else if (block?.type === "tool_use") {
          toolNames.set(block.id, block.name);
          content.push({
            type: "tool-call",
            toolCallId: block.id ?? "",
            toolName: block.name ?? "unknown",
            input: block.input ?? {},
          });
        }
      }
      if (content.length) wire.push({ role: "assistant", content });
      continue;
    }

    const userParts = [];
    const toolParts = [];
    for (const block of blocks) {
      if (block?.type === "text" && block.text) userParts.push(textPart(block.text));
      else if (block?.type === "image" && block.source?.data) {
        userParts.push({
          type: "image",
          image: `data:${block.source.media_type};base64,${block.source.data}`,
          mimeType: block.source.media_type,
        });
      } else if (block?.type === "tool_result") {
        toolParts.push({
          type: "tool-result",
          toolCallId: block.tool_use_id ?? "",
          toolName: toolNames.get(block.tool_use_id) ?? "unknown",
          output: {
            type: block.is_error ? "error-text" : "text",
            value: stringifyToolResult(block.content),
          },
        });
      }
    }
    if (toolParts.length) wire.push({ role: "tool", content: toolParts });
    if (userParts.length) wire.push({ role: "user", content: userParts });
  }

  return { messages: mergeAdjacent(wire), system: systemChunks.join("\n\n") };
}

export function toolsFromAnthropic(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const tool of tools) {
    if (!tool?.name) continue;
    out.push({
      name: tool.name,
      description: tool.description ?? "",
      input_schema: tool.input_schema ?? { type: "object", properties: {} },
    });
  }
  return out;
}

/** The gateway expects alternating turns; merge same-role neighbours. */
export function mergeAdjacent(messages) {
  const out = [];
  for (const message of messages) {
    const last = out[out.length - 1];
    if (last && last.role === message.role) {
      last.content = [...last.content, ...message.content];
    } else {
      out.push({ role: message.role, content: [...message.content] });
    }
  }
  return out;
}

export function parseJsonObject(value) {
  if (value === undefined || value === null) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function normalizeUsage(raw) {
  return {
    input_tokens: Number(raw?.inputTokens ?? 0) || 0,
    output_tokens: Number(raw?.outputTokens ?? 0) || 0,
    cache_read_tokens: Number(raw?.inputTokenDetails?.cacheReadTokens ?? 0) || 0,
    cache_write_tokens: Number(raw?.inputTokenDetails?.cacheWriteTokens ?? 0) || 0,
  };
}

export function mapFinishReason(raw) {
  const value = typeof raw === "string" ? raw.toLowerCase() : "";
  if (value === "tool_use" || value === "tool-calls" || value === "tool_calls") return "tool_calls";
  if (value === "length" || value === "max_tokens") return "length";
  if (value === "content_filter" || value === "refusal") return "content_filter";
  return "stop";
}

/**
 * Drives one upstream stream and calls the supplied sink for every
 * normalized event:
 *   {type:"text", text}
 *   {type:"reasoning", text}
 *   {type:"tool_call", id, name, input}
 *   {type:"finish", usage, finishReason}
 */
export async function pumpStream(stream, sink) {
  let finish = null;
  let sawAny = false;
  for await (const event of stream) {
    if (!event || typeof event !== "object") continue;
    sawAny = true;
    switch (event.type) {
      case "text-delta": {
        if (event.text) sink({ type: "text", text: event.text });
        break;
      }
      case "reasoning-start":
      case "reasoning-end": {
        break;
      }
      case "reasoning-delta": {
        if (event.text) sink({ type: "reasoning", text: event.text });
        break;
      }
      case "tool-call": {
        sink({
          type: "tool_call",
          id: event.toolCallId ?? "",
          name: event.toolName ?? "unknown",
          input: event.input ?? event.args ?? {},
        });
        break;
      }
      case "finish": {
        finish = {
          usage: normalizeUsage(event.totalUsage),
          finishReason: mapFinishReason(event.rawFinishReason ?? event.finishReason),
        };
        break;
      }
      case "error": {
        throw toStreamError(event);
      }
      default:
        break;
    }
  }
  if (!finish) {
    throw Object.assign(new Error("Upstream stream ended before a finish event"), {
      status: 502,
      code: "upstream_truncated",
    });
  }
  sink({ type: "finish", ...finish, sawAny });
  return finish;
}

function toStreamError(event) {
  const raw = event.error;
  const message =
    typeof raw === "string"
      ? raw
      : (typeof raw?.message === "string" && raw.message) || "Upstream stream error";
  const status = Number(raw?.statusCode) || 502;
  return Object.assign(new Error(message), {
    status: status >= 400 && status <= 599 ? status : 502,
    code: "upstream_stream_error",
  });
}
