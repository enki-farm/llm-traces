// Ported from public/app/features/explore/TraceView/components/TraceTimelineViewer/SpanDetail/llmUtils.ts
// Extracts LLM span data from OTel GenAI / generic conventions.

export interface KeyValuePair {
  key: string;
  value: unknown;
}

export interface SpanLog {
  timestamp: number;
  name?: string;
  fields: KeyValuePair[];
}

export interface LlmMessage {
  role: string;
  content: string;
  toolCalls?: LlmToolCall[];
}

export interface LlmToolCall {
  name: string;
  arguments: string;
  id?: string;
}

export interface LlmTokenUsage {
  input?: number;
  output?: number;
  total?: number;
}

export interface LlmInvocationParams {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  [key: string]: unknown;
}

export type LlmConvention = 'otel-genai' | 'generic' | 'unknown';

export interface LlmSpanData {
  isLlm: boolean;
  convention: LlmConvention;
  spanKind?: string; // gen_ai.operation.name mapped to: LLM, CHAIN, RETRIEVER, TOOL, EMBEDDING, AGENT, RERANKER, GUARDRAIL
  model: string;
  agentName?: string; // gen_ai.agent.name (OTel GenAI)
  agentId?: string;   // gen_ai.agent.id (OTel GenAI)
  agentVersion?: string; // gen_ai.agent.version (OTel GenAI)
  provider?: string;  // gen_ai.provider.name (OTel GenAI)
  conversationId?: string; // gen_ai.conversation.id (OTel GenAI)
  system?: string;
  systemInstructions?: string[]; // gen_ai.system_instructions (OTel GenAI, structured)
  inputMessages: LlmMessage[];
  outputMessages: LlmMessage[];
  tokenUsage: LlmTokenUsage;
  invocationParams: LlmInvocationParams;
  finishReason?: string;
  finishReasons?: string[]; // one per choice, in choice order
  responseId?: string; // gen_ai.response.id (OTel GenAI)
  precomputedCostUsd?: number;
}

/**
 * Decodes JSON unicode escape sequences (e.g. \u82f1 → 英) that Python tracing SDKs
 * emit when `ensure_ascii=True` (the default). The escapes are stored as literal
 * 6-character sequences in the span attribute string rather than real Unicode code points.
 */
export function decodeUnicodeEscapes(s: string): string {
  // First handle surrogate pairs: \uD800-\uDBFF followed by \uDC00-\uDFFF
  return s
    .replace(/\\u([dD][89aAbB][0-9a-fA-F]{2})\\u([dD][cCdDeEfF][0-9a-fA-F]{2})/g, (_, hi, lo) => {
      const codePoint = 0x10000 + ((parseInt(hi, 16) - 0xD800) << 10) + (parseInt(lo, 16) - 0xDC00);
      return String.fromCodePoint(codePoint);
    })
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

function getAttr(tags: KeyValuePair[], key: string): string | undefined {
  const tag = tags.find((t) => t.key === key);
  if (tag === undefined) return undefined;
  if (tag.value === null || tag.value === undefined) return undefined;
  return decodeUnicodeEscapes(String(tag.value));
}

function getNumAttr(tags: KeyValuePair[], key: string): number | undefined {
  const tag = tags.find((t) => t.key === key);
  if (tag === undefined) {
    return undefined;
  }
  if (tag.value === null || tag.value === undefined) return undefined;
  if (typeof tag.value === 'string' && tag.value.trim() === '') return undefined;
  const n = Number(tag.value);
  return isNaN(n) ? undefined : n;
}

/**
 * Reads a finish-reason array attribute in any of the shapes it reaches us:
 * JSON array string, comma-joined OTLP array (see parseOtlpValue), or flat-indexed `key.N` tags.
 */
function extractFinishReasons(tags: KeyValuePair[], key: string, fallbackKeys: string[] = []): string[] {
  const raw = getAttr(tags, key);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(String).filter(Boolean);
      }
    } catch { /* not JSON */ }
    return raw.replace(/[[\]{}"']/g, '').split(',').map((r) => r.trim()).filter(Boolean);
  }
  const indexed = tags
    .map((t) => ({ match: t.key.startsWith(`${key}.`) ? t.key.slice(key.length + 1).match(/^(\d+)$/) : null, tag: t }))
    .filter((e) => e.match && e.tag.value !== null && e.tag.value !== undefined && e.tag.value !== '')
    .sort((a, b) => Number(a.match![1]) - Number(b.match![1]))
    .map((e) => String(e.tag.value));
  if (indexed.length > 0) {
    return indexed;
  }
  for (const fallback of fallbackKeys) {
    const value = getAttr(tags, fallback);
    if (value) {
      return [value];
    }
  }
  return [];
}

function looksLikeMessages(value: string): boolean {
  if (!value || value.length < 10) {
    return false;
  }
  return (
    value.includes('"role"') &&
    value.includes('"content"') &&
    (value.startsWith('[') || value.startsWith('{'))
  );
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function normalizeToolCalls(raw: unknown): LlmToolCall[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  return raw.map((tc: unknown) => {
    if (!isRecord(tc)) {
      return { name: 'unknown', arguments: '' };
    }
    const fnRaw = tc.function;
    const fn = isRecord(fnRaw) ? fnRaw : undefined;
    const name = String((fn && fn.name) || tc.name || 'unknown');
    const rawArgs = (fn && fn.arguments) ?? tc.arguments ?? '';
    const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
    return { name, arguments: args, id: tc.id ? String(tc.id) : undefined };
  });
}

/**
 * Extract content string from an OTel GenAI-style parts array.
 *
 * The current OTel GenAI semantic convention represents message content as:
 *   [{"role":"user","parts":[{"type":"text","content":"..."}]}]
 *
 * This function flattens the parts array into a single content string,
 * preserving tool calls and tool results as structured markers.
 */
function extractContentFromParts(parts: unknown[]): string {
  if (!Array.isArray(parts)) {
    return '';
  }
  const textParts: string[] = [];
  for (const part of parts) {
    if (!isRecord(part)) {
      continue;
    }
    const type = String(part.type ?? 'text');
    if (type === 'text') {
      const text = String(part.content ?? '');
      if (text) {
        textParts.push(text);
      }
    } else if (type === 'tool_call') {
      const name = String(part.name ?? 'unknown');
      const id = part.id ? String(part.id) : undefined;
      const args = part.arguments ? JSON.stringify(part.arguments) : '';
      textParts.push(`[Tool Call: ${name}${id ? ` (${id})` : ''}]`);
      if (args) {
        textParts.push(args);
      }
    } else if (type === 'tool_result' || type === 'function_response') {
      const toolCallId = part.tool_call_id || part.call_id || '';
      const content = part.content !== undefined ? String(part.content) : '';
      textParts.push(`[Tool Result: ${toolCallId}]`);
      if (content) {
        textParts.push(content);
      }
    } else {
      // Unknown part type — serialize it
      textParts.push(JSON.stringify(part));
    }
  }
  return textParts.join('\n');
}

/**
 * Extract tool calls from an OTel GenAI-style parts array.
 * Returns undefined if no tool calls are found.
 */
function extractToolCallsFromParts(parts: unknown[]): LlmToolCall[] | undefined {
  if (!Array.isArray(parts)) {
    return undefined;
  }
  const toolCalls: LlmToolCall[] = [];
  for (const part of parts) {
    if (!isRecord(part)) {
      continue;
    }
    if (String(part.type ?? '') === 'tool_call') {
      toolCalls.push({
        name: String(part.name ?? 'unknown'),
        arguments: part.arguments ? JSON.stringify(part.arguments) : '',
        id: part.id ? String(part.id) : undefined,
      });
    }
  }
  return toolCalls.length > 0 ? toolCalls : undefined;
}

function extractMessagesFromJsonValue(value: string): LlmMessage[] {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((m) => m && typeof m === 'object' && (m.role || m['message.role']))
        .map((m: Record<string, unknown>) => {
          // OTel GenAI parts-based format: {"role":"user","parts":[...]}
          if (Array.isArray(m.parts)) {
            return {
              role: String(m.role || m['message.role'] || 'unknown'),
              content: extractContentFromParts(m.parts),
              toolCalls: extractToolCallsFromParts(m.parts) ?? normalizeToolCalls(m.tool_calls),
            };
          }
          // Legacy flat format: {"role":"user","content":"..."}
          return {
            role: String(m.role || m['message.role'] || 'unknown'),
            content: String(m.content ?? m['message.content'] ?? m.text ?? ''),
            toolCalls: normalizeToolCalls(m.tool_calls),
          };
        });
    }
    if (typeof parsed === 'object' && parsed !== null) {
      const messagesField = (parsed as Record<string, unknown>).messages || (parsed as Record<string, unknown>).Messages || (parsed as Record<string, unknown>).prompt;
      if (Array.isArray(messagesField)) {
        return messagesField
          .filter((m: Record<string, unknown>) => m && typeof m === 'object' && (m.role || m['message.role']))
          .map((m: Record<string, unknown>) => {
            // OTel GenAI parts-based format
            if (Array.isArray(m.parts)) {
              return {
                role: String(m.role || m['message.role'] || 'unknown'),
                content: extractContentFromParts(m.parts),
                toolCalls: extractToolCallsFromParts(m.parts) ?? normalizeToolCalls(m.tool_calls),
              };
            }
            // Legacy flat format
            return {
              role: String(m.role || m['message.role'] || 'unknown'),
              content: String(m.content ?? m['message.content'] ?? m.text ?? ''),
              toolCalls: normalizeToolCalls(m.tool_calls),
            };
          });
      }
      if ((parsed as Record<string, unknown>).role) {
        const msg = parsed as Record<string, unknown>;
        // OTel GenAI parts-based format
        if (Array.isArray(msg.parts)) {
          return [{
            role: String(msg.role),
            content: extractContentFromParts(msg.parts),
            toolCalls: extractToolCallsFromParts(msg.parts) ?? normalizeToolCalls(msg.tool_calls),
          }];
        }
        // Legacy flat format
        return [{
          role: String(msg.role),
          content: String(msg.content ?? msg.text ?? ''),
          toolCalls: normalizeToolCalls(msg.tool_calls),
        }];
      }
    }
  } catch {
    // not valid JSON
  }
  return [];
}

function extractIndexedMessages(tags: KeyValuePair[], prefix: string): LlmMessage[] {
  const messages: Map<number, LlmMessage> = new Map();
  for (const tag of tags) {
    if (!tag.key.startsWith(prefix)) {
      continue;
    }
    const rest = tag.key.slice(prefix.length);
    const match = rest.match(/^(\d+)\.(.+)$/);
    if (!match) {
      continue;
    }
    const index = parseInt(match[1], 10);
    const field = match[2];
    if (!messages.has(index)) {
      messages.set(index, { role: '', content: '' });
    }
    const msg = messages.get(index)!;
    if (field === 'message.role' || field === 'role') {
      msg.role = String(tag.value);
    } else if (field === 'message.content' || field === 'content') {
      if (typeof tag.value === 'object' && tag.value !== null) {
        try { msg.content = JSON.stringify(tag.value); } catch { msg.content = ''; }
      } else {
        msg.content = decodeUnicodeEscapes(String(tag.value));
      }
    } else if (field === 'message.tool_calls' || field === 'tool_calls') {
      try {
        const raw = typeof tag.value === 'string' ? JSON.parse(tag.value) : tag.value;
        msg.toolCalls = normalizeToolCalls(raw) ?? [];
      } catch {
        // ignore
      }
    }
  }
  return Array.from(messages.entries())
    .sort(([a], [b]) => a - b)
    .map(([, msg]) => {
      if (msg.role === '') {
        msg.role = 'user';
      }
      return msg;
    });
}

function tryExtractMessages(content: string): LlmMessage[] {
  let parsed = extractMessagesFromJsonValue(content);
  if (parsed.length === 0 && content.startsWith('"')) {
    try {
      const inner = JSON.parse(content);
      if (typeof inner === 'string') {
        parsed = extractMessagesFromJsonValue(inner);
      }
    } catch {
      // ignore
    }
  }
  return parsed;
}

function extractMessagesFromEvents(logs: SpanLog[]): { input: LlmMessage[]; output: LlmMessage[] } {
  // Collect system messages separately so they can be prepended (system must come first per LLM API convention)
  const systemMessages: LlmMessage[] = [];
  const nonSystemInput: LlmMessage[] = [];
  // For gen_ai.choice streaming: accumulate by choice index
  const choiceAccumulator: Map<number, { content: string }> = new Map();
  const output: LlmMessage[] = [];
  for (const log of logs) {
    const eventName = log.name || getAttr(log.fields, 'event') || '';
    if (eventName === 'gen_ai.content.prompt' || eventName === 'gen_ai.user.message') {
      const content = getAttr(log.fields, 'gen_ai.prompt') || getAttr(log.fields, 'gen_ai.content') || '';
      const role = getAttr(log.fields, 'role') || 'user';
      const parsed = tryExtractMessages(content);
      if (parsed.length > 0) {
        nonSystemInput.push(...parsed);
      } else if (content) {
        nonSystemInput.push({ role, content });
      }
    } else if (eventName === 'gen_ai.system.message') {
      const content = getAttr(log.fields, 'gen_ai.content') || getAttr(log.fields, 'gen_ai.prompt') || '';
      if (content) {
        systemMessages.push({ role: 'system', content });
      }
    } else if (eventName === 'gen_ai.content.completion' || eventName === 'gen_ai.assistant.message') {
      const content = getAttr(log.fields, 'gen_ai.completion') || getAttr(log.fields, 'gen_ai.content') || '';
      const parsed = tryExtractMessages(content);
      if (parsed.length > 0) {
        output.push(...parsed);
      } else if (content) {
        output.push({ role: 'assistant', content });
      }
    } else if (eventName === 'gen_ai.choice') {
      const content = getAttr(log.fields, 'gen_ai.completion') || getAttr(log.fields, 'gen_ai.content') || '';
      const choiceIndexRaw = getAttr(log.fields, 'gen_ai.choice.index');
      const choiceIndex = choiceIndexRaw !== undefined ? parseInt(choiceIndexRaw, 10) : 0;
      const existing = choiceAccumulator.get(choiceIndex);
      if (existing) {
        existing.content += content;
      } else {
        choiceAccumulator.set(choiceIndex, { content });
      }
    }
  }
  // Flush accumulated choice chunks as output messages
  if (choiceAccumulator.size > 0) {
    for (const [, chunk] of Array.from(choiceAccumulator.entries()).sort(([a], [b]) => a - b)) {
      const parsed = tryExtractMessages(chunk.content);
      if (parsed.length > 0) {
        output.push(...parsed);
      } else if (chunk.content) {
        output.push({ role: 'assistant', content: chunk.content });
      }
    }
  }
  // System messages always appear first in the conversation
  return { input: [...systemMessages, ...nonSystemInput], output };
}

function extractGcpVertexRequestMessages(jsonBlob: string): LlmMessage[] {
  // Gemini API request format: { contents: [{role, parts: [{text}]}], system_instruction?: {parts: [{text}]} }
  try {
    const parsed = JSON.parse(jsonBlob);
    if (!isRecord(parsed)) {
      return [];
    }
    const messages: LlmMessage[] = [];
    const sysInstr = parsed.system_instruction;
    if (isRecord(sysInstr) && Array.isArray(sysInstr.parts)) {
      const text = (sysInstr.parts as unknown[])
        .map((p) => (isRecord(p) ? String(p.text ?? '') : ''))
        .join('');
      if (text) {
        messages.push({ role: 'system', content: text });
      }
    }
    if (Array.isArray(parsed.contents)) {
      for (const item of parsed.contents as unknown[]) {
        if (!isRecord(item)) {
          continue;
        }
        const role = String(item.role ?? 'user');
        const parts = item.parts;
        const text = Array.isArray(parts)
          ? (parts as unknown[]).map((p) => {
              if (!isRecord(p)) return '';
              if (p.text !== undefined) return String(p.text);
              if (p.functionCall !== undefined) return `[Function call: ${JSON.stringify(p.functionCall)}]`;
              if (p.functionResponse !== undefined) return `[Function response: ${JSON.stringify(p.functionResponse)}]`;
              return '';
            }).filter(Boolean).join('\n')
          : '';
        messages.push({ role, content: text });
      }
    }
    return messages;
  } catch {
    return [];
  }
}

function extractGcpVertexResponseMessages(jsonBlob: string): LlmMessage[] {
  // Gemini API response format: { candidates: [{content: {role, parts: [{text}]}}] }
  try {
    const parsed = JSON.parse(jsonBlob);
    if (!isRecord(parsed) || !Array.isArray(parsed.candidates)) {
      return [];
    }
    return (parsed.candidates as unknown[]).map((c) => {
      if (!isRecord(c) || !isRecord(c.content)) {
        return { role: 'model', content: '' };
      }
      const role = String(c.content.role ?? 'model');
      const parts = c.content.parts;
      const text = Array.isArray(parts)
        ? (parts as unknown[]).map((p) => {
            if (!isRecord(p)) return '';
            if (p.text !== undefined) return String(p.text);
            if (p.functionCall !== undefined) return `[Function call: ${JSON.stringify(p.functionCall)}]`;
            if (p.functionResponse !== undefined) return `[Function response: ${JSON.stringify(p.functionResponse)}]`;
            return '';
          }).filter(Boolean).join('\n')
        : '';
      return { role, content: text };
    });
  } catch {
    return [];
  }
}

function detectConvention(tags: KeyValuePair[]): LlmConvention | null {
  const genAiSystem = getAttr(tags, 'gen_ai.system');
  if (genAiSystem || tags.some((t) => t.key.startsWith('gen_ai.'))) {
    return 'otel-genai';
  }
  // Generic convention: llm.* attributes without gen_ai.* attributes
  if (tags.some((t) => t.key.startsWith('llm.'))) {
    return 'generic';
  }
  const hasCompletionType = tags.some(
    (t) => (t.key.endsWith('.operation.type') || t.key === 'operation.type') && String(t.value).toLowerCase().includes('completion')
  );
  const hasMessageAttr = tags.some((t) => typeof t.value === 'string' && looksLikeMessages(t.value));
  if (hasCompletionType || hasMessageAttr) {
    return 'generic';
  }
  return null;
}

function extractOtelGenAi(tags: KeyValuePair[], logs: SpanLog[]): Omit<LlmSpanData, 'isLlm'> {
  // Prefer gen_ai.response.model when present — after streaming/routing the served model may differ
  // from the requested model (e.g. provider-side aliasing or fallback routing).
  const model = getAttr(tags, 'gen_ai.response.model') || getAttr(tags, 'gen_ai.request.model') || getAttr(tags, 'llm.request.model') || 'unknown';

  // Agent attributes (OTel GenAI spec)
  const agentName = getAttr(tags, 'gen_ai.agent.name');
  const agentId = getAttr(tags, 'gen_ai.agent.id');
  const agentVersion = getAttr(tags, 'gen_ai.agent.version');

  // Provider attribute (OTel GenAI spec)
  const provider = getAttr(tags, 'gen_ai.provider.name');

  // Conversation ID (OTel GenAI spec)
  const conversationId = getAttr(tags, 'gen_ai.conversation.id');

  // Response ID (OTel GenAI spec)
  const responseId = getAttr(tags, 'gen_ai.response.id');

  // System instructions — structured array format (OTel GenAI spec)
  // gen_ai.system_instructions is a JSON array of {type, content} objects
  let systemInstructions: string[] | undefined;
  const sysInstrRaw = getAttr(tags, 'gen_ai.system_instructions');
  if (sysInstrRaw) {
    try {
      const parsed = JSON.parse(sysInstrRaw);
      if (Array.isArray(parsed)) {
        systemInstructions = parsed
          .filter((item: unknown) => isRecord(item) && item.content !== undefined)
          .map((item: Record<string, unknown>) => String(item.content ?? ''));
      }
    } catch {
      // not valid JSON — fall through to legacy gen_ai.system
    }
  }

  const { input: inputMessages, output: outputMessages } = extractMessagesFromEvents(logs);

  // ── Input messages — OTel GenAI semantic conventions ─────────────────────
  // Priority: structured gen_ai.input.messages (dots, current spec) >
  //   gen_ai.input_messages (underscores, legacy) >
  //   gen_ai.prompt (Traceloop flat-indexed) >
  //   logs/events
  if (inputMessages.length === 0) {
    // Current OTel spec: gen_ai.input.messages (dots, not underscores)
    const genAiInput = getAttr(tags, 'gen_ai.input.messages');
    if (genAiInput) {
      inputMessages.push(...extractMessagesFromJsonValue(genAiInput));
    }
  }
  if (inputMessages.length === 0) {
    // Legacy/compat: gen_ai.input_messages (underscores)
    const genAiInput = getAttr(tags, 'gen_ai.input_messages');
    if (genAiInput) {
      inputMessages.push(...extractMessagesFromJsonValue(genAiInput));
    }
  }
  if (inputMessages.length === 0) {
    const prompt = getAttr(tags, 'gen_ai.prompt');
    if (prompt) {
      const parsed = extractMessagesFromJsonValue(prompt);
      inputMessages.push(...(parsed.length > 0 ? parsed : [{ role: 'user', content: prompt }]));
    }
  }
  if (inputMessages.length === 0) {
    // Traceloop flat-indexed format: gen_ai.prompt.{i}.role / gen_ai.prompt.{i}.content
    inputMessages.push(...extractIndexedMessages(tags, 'gen_ai.prompt.'));
  }
  if (inputMessages.length === 0) {
    // OTel GenAI flat-indexed format: gen_ai.input_messages.{i}.role / gen_ai.input_messages.{i}.content
    inputMessages.push(...extractIndexedMessages(tags, 'gen_ai.input_messages.'));
  }
  if (inputMessages.length === 0) {
    // Fallback: input.value as plain text
    const inputValue = getAttr(tags, 'input.value');
    if (inputValue) {
      const parsed = extractMessagesFromJsonValue(inputValue);
      if (parsed.length > 0) {
        inputMessages.push(...parsed);
      } else if (inputValue.trim()) {
        inputMessages.push({ role: 'user', content: inputValue });
      }
    }
  }
  if (inputMessages.length === 0) {
    // Vertex AI / legacy flat-indexed format: llm.input_messages.{i}.role / llm.input_messages.{i}.content
    inputMessages.push(...extractIndexedMessages(tags, 'llm.input_messages.'));
  }
  if (inputMessages.length === 0) {
    // Vertex AI / legacy flat-indexed format: llm.prompts.{i}.role / llm.prompts.{i}.content
    inputMessages.push(...extractIndexedMessages(tags, 'llm.prompts.'));
  }
  if (inputMessages.length === 0) {
    // GCP Vertex AI JSON blob: gcp.vertex.agent.llm_request with contents array
    const gcpReq = getAttr(tags, 'gcp.vertex.agent.llm_request');
    if (gcpReq) {
      inputMessages.push(...extractGcpVertexRequestMessages(gcpReq));
    }
  }

  // ── Output messages — OTel GenAI semantic conventions ─────────────────────
  if (outputMessages.length === 0) {
    // Current OTel spec: gen_ai.output.messages (dots, not underscores)
    const genAiOutput = getAttr(tags, 'gen_ai.output.messages');
    if (genAiOutput) {
      outputMessages.push(...extractMessagesFromJsonValue(genAiOutput));
    }
  }
  if (outputMessages.length === 0) {
    // Legacy/compat: gen_ai.output_messages (underscores)
    const genAiOutput = getAttr(tags, 'gen_ai.output_messages');
    if (genAiOutput) {
      outputMessages.push(...extractMessagesFromJsonValue(genAiOutput));
    }
  }
  if (outputMessages.length === 0) {
    const completion = getAttr(tags, 'gen_ai.completion');
    if (completion) {
      const parsed = extractMessagesFromJsonValue(completion);
      outputMessages.push(...(parsed.length > 0 ? parsed : [{ role: 'assistant', content: completion }]));
    }
  }
  if (outputMessages.length === 0) {
    // Traceloop flat-indexed format: gen_ai.completion.{i}.role / gen_ai.completion.{i}.content
    outputMessages.push(...extractIndexedMessages(tags, 'gen_ai.completion.'));
  }
  if (outputMessages.length === 0) {
    // OTel GenAI flat-indexed format: gen_ai.output_messages.{i}.role / gen_ai.output_messages.{i}.content
    outputMessages.push(...extractIndexedMessages(tags, 'gen_ai.output_messages.'));
  }
  if (outputMessages.length === 0) {
    // Fallback: output.value as plain text
    const outputValue = getAttr(tags, 'output.value');
    if (outputValue) {
      const parsed = extractMessagesFromJsonValue(outputValue);
      if (parsed.length > 0) {
        outputMessages.push(...parsed);
      } else if (outputValue.trim()) {
        outputMessages.push({ role: 'assistant', content: outputValue });
      }
    }
  }
  if (outputMessages.length === 0) {
    // Vertex AI / legacy flat-indexed format: llm.completions.{i}.role / llm.completions.{i}.content
    outputMessages.push(...extractIndexedMessages(tags, 'llm.completions.'));
  }
  if (outputMessages.length === 0) {
    // GCP Vertex AI JSON blob: gcp.vertex.agent.llm_response with candidates array
    const gcpResp = getAttr(tags, 'gcp.vertex.agent.llm_response');
    if (gcpResp) {
      outputMessages.push(...extractGcpVertexResponseMessages(gcpResp));
    }
  }

  const finishReasons = extractFinishReasons(tags, 'gen_ai.response.finish_reasons', ['gen_ai.finish_reason']);
  const finishReason = finishReasons[0];
  const precomputedCostUsd = getNumAttr(tags, 'gen_ai.cost.total_cost');
  const spanKind = getAttr(tags, 'gen_ai.operation.name')
    ? OTEL_OPERATION_TO_KIND[getAttr(tags, 'gen_ai.operation.name')!.toLowerCase()]
    : undefined;
  return {
    convention: 'otel-genai',
    model,
    agentName,
    agentId,
    agentVersion,
    provider,
    conversationId,
    systemInstructions,
    system: getAttr(tags, 'gen_ai.system'),
    spanKind,
    inputMessages,
    outputMessages,
    tokenUsage: {
      input: getNumAttr(tags, 'gen_ai.usage.input_tokens')
        ?? getNumAttr(tags, 'gen_ai.usage.prompt_tokens')
        ?? getNumAttr(tags, 'gen_ai.usage.input'),
      output: getNumAttr(tags, 'gen_ai.usage.output_tokens')
        ?? getNumAttr(tags, 'gen_ai.usage.completion_tokens')
        ?? getNumAttr(tags, 'gen_ai.usage.output'),
      total: getNumAttr(tags, 'gen_ai.usage.total_tokens'),
    },
    invocationParams: {
      temperature: getNumAttr(tags, 'gen_ai.request.temperature'),
      maxTokens: getNumAttr(tags, 'gen_ai.request.max_tokens'),
      ...(getNumAttr(tags, 'gen_ai.request.max_tokens') !== undefined
        ? { max_tokens: getNumAttr(tags, 'gen_ai.request.max_tokens') }
        : {}),
      topP: getNumAttr(tags, 'gen_ai.request.top_p'),
      // gen_ai.request.top_k is used by Anthropic, Gemini and other providers.
      // It must be included explicitly here because the LlmInvocationParams index type
      // only passes through named fields; unknown keys from tags are not auto-collected.
      ...(getNumAttr(tags, 'gen_ai.request.top_k') !== undefined
        ? { topK: getNumAttr(tags, 'gen_ai.request.top_k') }
        : {}),
      ...(getNumAttr(tags, 'gen_ai.request.frequency_penalty') !== undefined
        ? { frequencyPenalty: getNumAttr(tags, 'gen_ai.request.frequency_penalty') }
        : {}),
      ...(getNumAttr(tags, 'gen_ai.request.presence_penalty') !== undefined
        ? { presencePenalty: getNumAttr(tags, 'gen_ai.request.presence_penalty') }
        : {}),
      ...(getAttr(tags, 'gen_ai.operation.name') !== undefined
        ? { operationName: getAttr(tags, 'gen_ai.operation.name') }
        : {}),
    },
    finishReason,
    ...(finishReasons.length > 0 ? { finishReasons } : {}),
    ...(responseId ? { responseId } : {}),
    ...(precomputedCostUsd !== undefined ? { precomputedCostUsd } : {}),
  };
}

function extractGeneric(tags: KeyValuePair[], logs: SpanLog[], operationName?: string): Omit<LlmSpanData, 'isLlm'> {
  let inputMessages: LlmMessage[] = [];
  let outputMessages: LlmMessage[] = [];
  const inputKeys = ['workflow.input', 'input.value', 'input', 'request.body', 'llm.input', 'prompt'];
  const outputKeys = ['workflow.output', 'output.value', 'output', 'response.body', 'llm.output', 'completion'];
  for (const key of inputKeys) {
    const val = getAttr(tags, key);
    if (val && looksLikeMessages(val)) {
      inputMessages = extractMessagesFromJsonValue(val);
      if (inputMessages.length > 0) {
        break;
      }
    }
  }
  for (const key of outputKeys) {
    const val = getAttr(tags, key);
    if (val && looksLikeMessages(val)) {
      outputMessages = extractMessagesFromJsonValue(val);
      if (outputMessages.length > 0) {
        break;
      }
    }
  }
  const model =
    getAttr(tags, 'gen_ai.request.model') || getAttr(tags, 'llm.model_name') || getAttr(tags, 'model') || operationName || 'unknown';
  if (inputMessages.length === 0 && outputMessages.length === 0 && logs.length > 0) {
    const fromEvents = extractMessagesFromEvents(logs);
    inputMessages = fromEvents.input;
    outputMessages = fromEvents.output;
  }
  const finishReason = getAttr(tags, 'finish_reason') ?? getAttr(tags, 'stop_reason');
  const precomputedCostUsd = getNumAttr(tags, 'gen_ai.cost.total_cost');
  return {
    convention: 'generic',
    model,
    inputMessages,
    outputMessages,
    tokenUsage: {
      input: getNumAttr(tags, 'gen_ai.usage.input_tokens') ?? getNumAttr(tags, 'llm.token_count.prompt') ?? getNumAttr(tags, 'prompt_tokens'),
      output: getNumAttr(tags, 'gen_ai.usage.output_tokens') ?? getNumAttr(tags, 'llm.token_count.completion') ?? getNumAttr(tags, 'completion_tokens'),
      total: getNumAttr(tags, 'gen_ai.usage.total_tokens') ?? getNumAttr(tags, 'llm.token_count.total') ?? getNumAttr(tags, 'total_tokens'),
    },
    invocationParams: (() => {
      // Try parsing llm.invocation_parameters (Python repr format)
      const rawParams = getAttr(tags, 'llm.invocation_parameters');
      if (rawParams) {
        const parsed = parsePythonReprInvocationParams(rawParams);
        if (parsed) {
          return {
            temperature: (parsed.temperature as number) ?? getNumAttr(tags, 'gen_ai.request.temperature') ?? getNumAttr(tags, 'temperature'),
            maxTokens: (parsed.max_tokens as number) ?? getNumAttr(tags, 'gen_ai.request.max_tokens') ?? getNumAttr(tags, 'max_tokens'),
            topP: (parsed.top_p as number) ?? getNumAttr(tags, 'gen_ai.request.top_p') ?? getNumAttr(tags, 'top_p'),
          };
        }
      }
      return {
        temperature: getNumAttr(tags, 'gen_ai.request.temperature') ?? getNumAttr(tags, 'temperature'),
        maxTokens: getNumAttr(tags, 'gen_ai.request.max_tokens') ?? getNumAttr(tags, 'max_tokens'),
        topP: getNumAttr(tags, 'gen_ai.request.top_p') ?? getNumAttr(tags, 'top_p'),
      };
    })(),
    finishReason,
    ...(finishReason ? { finishReasons: [finishReason] } : {}),
    ...(precomputedCostUsd !== undefined ? { precomputedCostUsd } : {}),
  };
}

// Helper to parse Python repr invocation_parameters (single quotes, True/False/None)
function parsePythonReprInvocationParams(raw: string): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    // Replace Python True/False/None with JSON true/false/null
    const jsonStr = raw
      .replace(/'/g, '"')
      .replace(/\bTrue\b/g, 'true')
      .replace(/\bFalse\b/g, 'false')
      .replace(/\bNone\b/g, 'null');
    const parsed = JSON.parse(jsonStr);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function extractLlmSpanData(tags: KeyValuePair[], logs: SpanLog[], operationName?: string): LlmSpanData {
  const convention = detectConvention(tags);
  if (!convention) {
    return { isLlm: false, convention: 'unknown', model: '', inputMessages: [], outputMessages: [], tokenUsage: {}, invocationParams: {}, finishReason: undefined };
  }
  let data: Omit<LlmSpanData, 'isLlm'>;
  switch (convention) {
    case 'otel-genai':
      data = extractOtelGenAi(tags, logs);
      break;
    default:
      data = extractGeneric(tags, logs, operationName);
  }
  // For OTel GenAI, only treat the span as LLM if it's an LLM call or a GUARDRAIL
  // (guardrails invoke an LLM internally and carry the same gen_ai.* attributes).
  // CHAIN, TOOL, RETRIEVER etc. are structural spans, not the model call itself.
  // For generic convention, treat as LLM if it has model/token data.
  let isLlm: boolean;
  if (convention === 'otel-genai') {
    // If there's no spanKind, check if the span has gen_ai.system or gen_ai.request.model
    // - these indicate an LLM inference span even without an explicit operation name
    const hasInferenceAttrs = tags.some(
      (t) => t.key === 'gen_ai.system' || t.key === 'gen_ai.request.model'
    );
    if (hasInferenceAttrs && !data.spanKind) {
      isLlm = true;
    } else {
      isLlm = data.spanKind?.toUpperCase() === 'LLM' || data.spanKind?.toUpperCase() === 'GUARDRAIL';
    }
  } else {
    // Generic convention: treat as LLM if it has identifiable model or token data
    isLlm = data.model !== '' && data.model !== 'unknown' || data.tokenUsage.input !== undefined || data.tokenUsage.output !== undefined;
  }
  return { isLlm, ...data };
}

export function isAiSpan(tags: KeyValuePair[]): boolean {
  return detectConvention(tags) !== null;
}

export function isEmbeddingSpan(tags: KeyValuePair[]): boolean {
  const opName = tags.find((t) => t.key === 'gen_ai.operation.name');
  if (opName) {
    const v = String(opName.value).toLowerCase();
    if (v === 'embeddings' || v === 'create_embeddings' || v === 'embed') {
      return true;
    }
  }
  // Legacy/compat: llm.request.type
  const reqType = tags.find((t) => t.key === 'llm.request.type');
  if (reqType && String(reqType.value).toLowerCase() === 'embedding') {
    return true;
  }
  return false;
}

export function isLlmSpan(tags: KeyValuePair[]): boolean {
  // Embedding spans are not LLM chat/completion spans
  if (isEmbeddingSpan(tags) || getSpanKind(tags) === 'RETRIEVER') {
    return false;
  }
  if (tags.some(
    (t) =>
      t.key === 'gen_ai.system' ||
      t.key === 'gen_ai.request.model' ||
      t.key.startsWith('gen_ai.usage.')
  )) {
    return true;
  }
  // Check gen_ai.operation.name for LLM operations
  const opName = tags.find((t) => t.key === 'gen_ai.operation.name');
  if (opName) {
    const v = String(opName.value).toLowerCase();
    if (v === 'chat' || v === 'generate_content' || v === 'text_completion' || v === 'completions' || v === 'generate' || v === 'guardrail' || v === 'check_guardrail') {
      return true;
    }
  }
  // Generic convention: operation.type containing "completion"
  return tags.some(
    (t) => (t.key.endsWith('.operation.type') || t.key === 'operation.type') && String(t.value).toLowerCase().includes('completion')
  );
}

// Maps gen_ai.operation.name values (OTel GenAI spec) to normalized span kind labels.
const OTEL_OPERATION_TO_KIND: Record<string, string> = {
  // LLM
  chat: 'LLM',
  generate_content: 'LLM',
  text_completion: 'LLM',
  completions: 'LLM',
  generate: 'LLM',
  // AGENT
  invoke_agent: 'AGENT',
  execute_agent: 'AGENT',
  create_agent: 'AGENT',
  // TOOL
  execute_tool: 'TOOL',
  tool_call: 'TOOL',
  // RETRIEVER
  retrieval: 'RETRIEVER',
  // MEMORY
  create_memory_store: 'MEMORY',
  create_memory: 'MEMORY',
  search_memory: 'MEMORY',
  update_memory: 'MEMORY',
  upsert_memory: 'MEMORY',
  delete_memory: 'MEMORY',
  delete_memory_store: 'MEMORY',
  // EMBEDDING
  embeddings: 'EMBEDDING',
  create_embeddings: 'EMBEDDING',
  embed: 'EMBEDDING',
  // RERANKER
  rerank: 'RERANKER',
  // GUARDRAIL
  guardrail: 'GUARDRAIL',
  check_guardrail: 'GUARDRAIL',
};

/**
 * Returns the display span kind across all supported conventions:
 *   - OTel GenAI:    gen_ai.operation.name mapped to normalized labels
 * Returns undefined for non-AI spans.
 */
export function getSpanKind(tags: KeyValuePair[]): string | undefined {
  // OTel GenAI — derive kind from gen_ai.operation.name
  const opName = getAttr(tags, 'gen_ai.operation.name');
  if (opName) {
    return OTEL_OPERATION_TO_KIND[opName.toLowerCase()] ?? opName.toUpperCase();
  }

  // Fallback: any span with gen_ai.system or gen_ai.request.model is an LLM inference span
  const isInferenceSpan = tags.some(
    (t) =>
      t.key === 'gen_ai.system' ||
      t.key === 'gen_ai.request.model'
  );
  if (isInferenceSpan) {
    return 'LLM';
  }

  return undefined;
}

/**
 * Returns the agent name across all supported conventions:
 *   - gen_ai.agent.name  (OTel GenAI spec + modern OpenInference ≥ 1.4)
 * Returns undefined when no agent name attribute is found.
 */
export function getAgentName(tags: KeyValuePair[]): string | undefined {
  return getAttr(tags, 'gen_ai.agent.name');
}

export function getSpanKindColor(kind: string | undefined): string {
  switch (kind?.toUpperCase()) {
    case 'LLM': return '#7B61FF';
    case 'CHAIN': return '#3274D9';
    case 'AGENT': return '#E0851A';
    case 'TOOL': return '#5794F2';
    case 'RETRIEVER': return '#73BF69';
    case 'MEMORY': return '#4E9A8A';
    case 'EMBEDDING': return '#B877D9';
    case 'RERANKER': return '#FF9830';
    case 'GUARDRAIL': return '#F59E0B';
    case 'UNKNOWN': return '#6B7280';
    default: return '#8E8E8E';
  }
}
