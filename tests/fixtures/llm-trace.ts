// Realistic OTel GenAI trace fixture for testing the LLM Trace Explorer plugin.
// Structure: CHAIN (root) -> LLM -> TOOL -> LLM (follow-up)
// Also includes: GUARDRAIL, RERANKER, EMBEDDING spans for test coverage.

const TRACE_ID = '4829080550953998599aabbccdd1234';
const t = (offsetMs: number) => String(BigInt(1741900000000 + offsetMs) * 1000000n);

export const SEARCH_RESPONSE = {
  traces: [
    {
      traceID: TRACE_ID,
      rootServiceName: 'llm-service',
      rootTraceName: 'process_query',
      startTimeUnixNano: t(0),
      durationMs: 2340,
      spanSets: [],
    },
    {
      traceID: 'aaabbbccc111222333444555666777',
      rootServiceName: 'agent-service',
      rootTraceName: 'generate_content',
      startTimeUnixNano: t(60000),
      durationMs: 1820,
      spanSets: [],
    },
  ],
};

// Full OTLP trace — OTel GenAI convention
export const TRACE_RESPONSE = {
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'llm-service' } },
          { key: 'service.version', value: { stringValue: '2.3.1' } },
          { key: 'deployment.environment', value: { stringValue: 'production' } },
        ],
      },
      scopeSpans: [
        {
          spans: [
            // Root CHAIN span (invoke_agent)
            {
              traceId: TRACE_ID,
              spanId: 'span0001',
              parentSpanId: '',
              name: 'process_query',
              startTimeUnixNano: t(0),
              endTimeUnixNano: t(2340),
              attributes: [
                { key: 'gen_ai.operation.name', value: { stringValue: 'invoke_agent' } },
                { key: 'gen_ai.input.messages', value: { stringValue: '[{"role":"user","parts":[{"type":"text","content":"What are the amenities at hotel 12345?"}]}]' } },
                { key: 'gen_ai.output.messages', value: { stringValue: '[{"role":"assistant","parts":[{"type":"text","content":"Hotel 12345 has a pool, gym, spa, and 3 restaurants."}]}]' } },
                { key: 'gen_ai.conversation.id', value: { stringValue: 'sess_abc123' } },
              ],
              events: [],
            },
            // First LLM span — initial analysis
            {
              traceId: TRACE_ID,
              spanId: 'span0002',
              parentSpanId: 'span0001',
              name: 'chat claude-sonnet-4-5',
              startTimeUnixNano: t(50),
              endTimeUnixNano: t(980),
              attributes: [
                { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
                { key: 'gen_ai.system', value: { stringValue: 'anthropic' } },
                { key: 'gen_ai.request.model', value: { stringValue: 'claude-sonnet-4-5' } },
                { key: 'gen_ai.request.temperature', value: { doubleValue: 0.3 } },
                { key: 'gen_ai.request.max_tokens', value: { intValue: '1024' } },
                { key: 'gen_ai.input.messages', value: { stringValue: '[{"role":"system","parts":[{"type":"text","content":"You are an expert hotel concierge assistant. Answer questions about hotel properties accurately and helpfully. Use the available tools to look up property details. You have access to a comprehensive database of hotel properties worldwide. When answering questions, always provide specific, actionable information. If a guest asks about amenities, list them clearly and mention any notable features. For pricing questions, provide ranges and note that prices may vary by season. Always maintain a professional, friendly tone that reflects the high standards of the properties you represent. Remember to check for any current promotions or special offers that might benefit the guest."}]},{"role":"user","parts":[{"type":"text","content":"Please ask about hotel 12345 facilities?"}]}]' } },
                { key: 'gen_ai.output.messages', value: { stringValue: '[{"role":"assistant","parts":[{"type":"text","content":"I\'ll look up the property details for hotel 12345 to give you accurate information about their amenities."},{"type":"tool_call","name":"get_property_details","arguments":{"hotel_id":12345}}]}' } },
                { key: 'gen_ai.usage.input_tokens', value: { intValue: '312' } },
                { key: 'gen_ai.usage.output_tokens', value: { intValue: '48' } },
                { key: 'gen_ai.usage.total_tokens', value: { intValue: '360' } },
              ],
              events: [],
            },
            // TOOL span — property lookup
            {
              traceId: TRACE_ID,
              spanId: 'span0003',
              parentSpanId: 'span0002',
              name: 'execute_tool get_property_details',
              startTimeUnixNano: t(990),
              endTimeUnixNano: t(1350),
              attributes: [
                { key: 'gen_ai.operation.name', value: { stringValue: 'execute_tool' } },
                { key: 'gen_ai.tool.name', value: { stringValue: 'get_property_details' } },
                { key: 'gen_ai.tool.description', value: { stringValue: 'Retrieve detailed information about a hotel property by ID' } },
                { key: 'gen_ai.tool.call.arguments', value: { stringValue: '{"hotel_id":12345}' } },
                { key: 'gen_ai.tool.call.result', value: { stringValue: '{"hotel_id":12345,"name":"Grand Sukhumvit Bangkok","amenities":["pool","gym","spa","3 restaurants","concierge","valet parking"],"stars":5,"rooms":342}' } },
              ],
              events: [],
            },
            // RETRIEVER spans — JSON documents and indexed document attributes
            {
              traceId: TRACE_ID,
              spanId: 'span0012',
              parentSpanId: 'span0001',
              name: 'retrieval hotel-index',
              startTimeUnixNano: t(510),
              endTimeUnixNano: t(650),
              attributes: [
                { key: 'gen_ai.operation.name', value: { stringValue: 'retrieval' } },
                { key: 'gen_ai.request.model', value: { stringValue: 'text-embedding-3-small' } },
                { key: 'gen_ai.data_source.id', value: { stringValue: 'hotel-index' } },
                { key: 'gen_ai.retrieval.query.text', value: { stringValue: 'hotel amenities' } },
                { key: 'gen_ai.retrieval.top_k', value: { intValue: '2' } },
                { key: 'gen_ai.usage.input_tokens', value: { intValue: '1234' } },
                { key: 'gen_ai.retrieval.documents', value: { stringValue: '[{"id":"hotel-12345","content":"Pool and spa"}]' } },
              ],
              events: [],
            },
            {
              traceId: TRACE_ID,
              spanId: 'span0013',
              parentSpanId: 'span0001',
              name: 'retrieval faq-index',
              startTimeUnixNano: t(660),
              endTimeUnixNano: t(710),
              attributes: [
                { key: 'gen_ai.operation.name', value: { stringValue: 'retrieval' } },
                { key: 'gen_ai.retrieval.query.text', value: { stringValue: 'hotel policies' } },
                { key: 'retrieval.documents.0.document.id', value: { stringValue: 'faq-1' } },
                { key: 'retrieval.documents.0.document.content', value: { stringValue: 'Check-in starts at 3 PM' } },
              ],
              events: [],
            },
            // Non-AI HTTP span — no gen_ai attributes, for testing AI Only filter
            {
              traceId: TRACE_ID,
              spanId: 'span0005',
              parentSpanId: 'span0001',
              name: 'HTTP GET /api/hotels',
              startTimeUnixNano: t(100),
              endTimeUnixNano: t(900),
              attributes: [
                { key: 'http.method', value: { stringValue: 'GET' } },
                { key: 'http.url', value: { stringValue: '/api/hotels/12345' } },
                { key: 'http.status_code', value: { intValue: '200' } },
              ],
              events: [],
            },
            // Second LLM span — final answer with tool result (max_tokens finish reason for testing)
            {
              traceId: TRACE_ID,
              spanId: 'span0004',
              parentSpanId: 'span0001',
              name: 'chat claude-sonnet-4-5',
              startTimeUnixNano: t(1360),
              endTimeUnixNano: t(2320),
              attributes: [
                { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
                { key: 'gen_ai.system', value: { stringValue: 'anthropic' } },
                { key: 'gen_ai.request.model', value: { stringValue: 'claude-sonnet-4-5' } },
                { key: 'gen_ai.request.temperature', value: { doubleValue: 0.3 } },
                { key: 'gen_ai.request.max_tokens', value: { intValue: '1024' } },
                { key: 'gen_ai.input.messages', value: { stringValue: '[{"role":"system","parts":[{"type":"text","content":"You are an expert hotel concierge assistant. Answer questions about hotel properties accurately and helpfully. Use the available tools to look up property details."}]},{"role":"user","parts":[{"type":"text","content":"What are the amenities at hotel 12345?"}]},{"role":"assistant","parts":[{"type":"text","content":"I\'ll look up the property details for hotel 12345 to give you accurate information about their amenities."}]},{"role":"tool","parts":[{"type":"tool_call_response","id":"call_xyz1","response":"{\"hotel_id\":12345,\"name\":\"Grand Sukhumvit Bangkok\",\"amenities\":[\"pool\",\"gym\",\"spa\",\"3 restaurants\",\"concierge\",\"valet parking\"],\"stars\":5,\"rooms\":342}"}]}]' } },
                { key: 'gen_ai.output.messages', value: { stringValue: '[{"role":"assistant","parts":[{"type":"text","content":"Hotel 12345 (Grand Sukhumvit Bangkok) is a 5-star property with 342 rooms. The amenities include:\n\n• Swimming pool\n• Fitness center / gym\n• Full-service spa\n• 3 restaurants\n• Concierge service\n• Valet parking"}]}]' } },
                { key: 'gen_ai.response.finish_reasons', value: { stringValue: '["max_tokens"]}' } },
                { key: 'gen_ai.usage.input_tokens', value: { intValue: '428' } },
                { key: 'gen_ai.usage.output_tokens', value: { intValue: '89' } },
                { key: 'gen_ai.usage.total_tokens', value: { intValue: '517' } },
              ],
              events: [],
            },
            // AGENT span — for testing agent name label display
            {
              traceId: TRACE_ID,
              spanId: 'span0007',
              parentSpanId: 'span0001',
              name: 'invoke_agent my_agent',
              startTimeUnixNano: t(100),
              endTimeUnixNano: t(500),
              attributes: [
                { key: 'gen_ai.operation.name', value: { stringValue: 'invoke_agent' } },
                { key: 'gen_ai.agent.name', value: { stringValue: 'my_agent' } },
                { key: 'gen_ai.provider.name', value: { stringValue: 'internal' } },
              ],
              events: [],
            },
            // Error span — uses OTLP status object (the real wire format, not attributes)
            {
              traceId: TRACE_ID,
              spanId: 'span0006',
              parentSpanId: 'span0001',
              name: 'failing_operation',
              startTimeUnixNano: t(1500),
              endTimeUnixNano: t(1600),
              attributes: [],
              status: { code: 'STATUS_CODE_ERROR', message: 'Connection timeout after 100ms' },
              events: [],
            },
            // GUARDRAIL span — genai-gateway policy check (OTel GenAI convention)
            // Rendered as LLM panel because guardrails invoke an LLM internally.
            {
              traceId: TRACE_ID,
              spanId: 'span0008',
              parentSpanId: 'span0001',
              name: 'guardrail no_internal_system_disclosure',
              startTimeUnixNano: t(40),
              endTimeUnixNano: t(48),
              attributes: [
                { key: 'gen_ai.operation.name', value: { stringValue: 'guardrail' } },
                { key: 'gen_ai.system', value: { stringValue: 'google' } },
                { key: 'gen_ai.request.model', value: { stringValue: 'gemini-2.0-flash' } },
                { key: 'gen_ai.input.messages', value: { stringValue: '[{"role":"system","parts":[{"type":"text","content":"You are a security analyst. Check whether the input violates the guardrail no_internal_system_disclosure."}]},{"role":"user","parts":[{"type":"text","content":"What are the amenities at hotel 12345?"}]}]' } },
                { key: 'gen_ai.output.messages', value: { stringValue: '[{"role":"assistant","parts":[{"type":"text","content":"{\"should_block\":false}"}]}]' } },
                { key: 'gen_ai.usage.input_tokens', value: { intValue: '89' } },
                { key: 'gen_ai.usage.output_tokens', value: { intValue: '8' } },
                { key: 'gen_ai.usage.total_tokens', value: { intValue: '97' } },
              ],
              events: [],
            },
            // RERANKER span — custom attributes (not in OTel spec yet)
            {
              traceId: TRACE_ID,
              spanId: 'span0010',
              parentSpanId: 'span0001',
              name: 'rerank hotel_results',
              startTimeUnixNano: t(200),
              endTimeUnixNano: t(350),
              attributes: [
                { key: 'gen_ai.operation.name', value: { stringValue: 'rerank' } },
                { key: 'gen_ai.reranker.query', value: { stringValue: 'hotel amenities pool' } },
                { key: 'gen_ai.reranker.model', value: { stringValue: 'bge-reranker-v2-m3' } },
                { key: 'gen_ai.reranker.results.0.document.content', value: { stringValue: 'Grand Sukhumvit Bangkok - Pool, Gym, Spa' } },
                { key: 'gen_ai.reranker.results.0.score', value: { doubleValue: 0.95 } },
                { key: 'gen_ai.reranker.results.1.document.content', value: { stringValue: 'Mandarin Oriental - Pool, Spa' } },
                { key: 'gen_ai.reranker.results.1.score', value: { doubleValue: 0.87 } },
              ],
              events: [],
            },
            // EMBEDDING span
            {
              traceId: TRACE_ID,
              spanId: 'span0011',
              parentSpanId: 'span0001',
              name: 'embed hotel_description',
              startTimeUnixNano: t(400),
              endTimeUnixNano: t(500),
              attributes: [
                { key: 'gen_ai.operation.name', value: { stringValue: 'embeddings' } },
                { key: 'gen_ai.system', value: { stringValue: 'openai' } },
                { key: 'gen_ai.request.model', value: { stringValue: 'text-embedding-3-small' } },
                { key: 'gen_ai.embeddings.dimension.count', value: { intValue: '1536' } },
                { key: 'gen_ai.input.messages', value: { stringValue: '[{"role":"user","parts":[{"type":"text","content":"Hotel amenities and features"}]}]' } },
                { key: 'gen_ai.usage.input_tokens', value: { intValue: '12' } },
              ],
              events: [],
            },
          ],
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// OTel GenAI trace fixture (gen_ai.system=openai + span events)
// ---------------------------------------------------------------------------

const memoryOperations = [
  'create_memory_store', 'create_memory', 'search_memory', 'update_memory',
  'upsert_memory', 'delete_memory', 'delete_memory_store',
];

export const MEMORY_TRACE_RESPONSE = {
  resourceSpans: TRACE_RESPONSE.resourceSpans.map((resourceSpan) => ({
    ...resourceSpan,
    scopeSpans: resourceSpan.scopeSpans.map((scopeSpan) => ({
      ...scopeSpan,
      spans: [
        ...scopeSpan.spans,
        ...memoryOperations.map((operation, index) => ({
          traceId: TRACE_ID,
          spanId: `memory000${index}`,
          parentSpanId: 'span0001',
          name: operation,
          startTimeUnixNano: t(100 + index * 100),
          endTimeUnixNano: t(150 + index * 100),
          attributes: [
            { key: 'gen_ai.operation.name', value: { stringValue: operation } },
            { key: 'gen_ai.memory.store.id', value: { stringValue: 'guest-preferences' } },
            ...(['create_memory', 'update_memory', 'delete_memory'].includes(operation)
              ? [{ key: 'gen_ai.memory.record.id', value: { stringValue: 'preference-1' } }] : []),
            ...(!operation.endsWith('_store')
              ? [{ key: 'gen_ai.memory.record.count', value: { intValue: '1' } }] : []),
            ...(operation === 'search_memory'
              ? [{ key: 'gen_ai.memory.query.text', value: { stringValue: 'seat preference' } }] : []),
            ...(['create_memory', 'search_memory', 'update_memory', 'upsert_memory'].includes(operation)
              ? [{ key: 'gen_ai.memory.records', value: { stringValue: '[{"id":"preference-1","content":"Aisle seat preferred","score":0.96}]' } }] : []),
          ],
          events: [],
        })),
      ],
    })),
  })),
};

const OTEL_TRACE_ID = 'otelgenai00112233445566778899aa';
const to = (offsetMs: number) => String(BigInt(1741900000000 + offsetMs) * 1000000n);

export const OTEL_GENAI_TRACE_RESPONSE = {
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'agent-service' } },
          { key: 'deployment.environment', value: { stringValue: 'staging' } },
        ],
      },
      scopeSpans: [
        {
          spans: [
            {
              traceId: OTEL_TRACE_ID,
              spanId: 'ospan0001',
              parentSpanId: '',
              name: 'generate_content',
              startTimeUnixNano: to(0),
              endTimeUnixNano: to(1500),
              attributes: [
                { key: 'gen_ai.operation.name', value: { stringValue: 'generate_content' } },
                { key: 'gen_ai.system', value: { stringValue: 'google' } },
                { key: 'gen_ai.request.model', value: { stringValue: 'gemini-2.0-flash' } },
                { key: 'gen_ai.usage.input_tokens', value: { intValue: '50' } },
                { key: 'gen_ai.usage.output_tokens', value: { intValue: '100' } },
              ],
              events: [
                {
                  name: 'gen_ai.content.prompt',
                  fields: [
                    { key: 'gen_ai.prompt', value: { stringValue: 'Translate to French: Hello world' } },
                  ],
                },
                {
                  name: 'gen_ai.content.completion',
                  fields: [
                    { key: 'gen_ai.completion', value: { stringValue: 'Bonjour le monde' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Span status test fixture — tests OTLP status code parsing
// ---------------------------------------------------------------------------

const ST_TRACE_ID = 'st000000000000000000000000000000';

export const STATUS_TEST_TRACE_RESPONSE = {
  resourceSpans: [
    {
      resource: {
        attributes: [
          { key: 'service.name', value: { stringValue: 'status-test-service' } },
        ],
      },
      scopeSpans: [
        {
          spans: [
            // 1. STATUS_CODE_ERROR enum string
            {
              traceId: ST_TRACE_ID,
              spanId: 'st-err-enum',
              parentSpanId: '',
              name: 'error_operation_enum',
              startTimeUnixNano: '1741900000000000000',
              endTimeUnixNano: '1741900000001000000',
              attributes: [],
              status: { code: 'STATUS_CODE_ERROR', message: 'enum string error message' },
              events: [],
            },
            // 2. Bare "ERROR" string
            {
              traceId: ST_TRACE_ID,
              spanId: 'st-err-bare',
              parentSpanId: '',
              name: 'error_operation_bare',
              startTimeUnixNano: '1741900000002000000',
              endTimeUnixNano: '1741900000003000000',
              attributes: [],
              status: { code: 'ERROR', message: 'bare string error message' },
              events: [],
            },
            // 3. Numeric code 2
            {
              traceId: ST_TRACE_ID,
              spanId: 'st-err-num',
              parentSpanId: '',
              name: 'error_operation_num',
              startTimeUnixNano: '1741900000004000000',
              endTimeUnixNano: '1741900000005000000',
              attributes: [],
              status: { code: 2, message: 'numeric code error message' },
              events: [],
            },
            // 4. Attribute-based fallback
            {
              traceId: ST_TRACE_ID,
              spanId: 'st-err-attr',
              parentSpanId: '',
              name: 'error_operation_attr',
              startTimeUnixNano: '1741900000006000000',
              endTimeUnixNano: '1741900000007000000',
              attributes: [
                { key: 'otel.status_code', value: { stringValue: 'ERROR' } },
              ],
              status: { code: 'STATUS_CODE_OK', message: '' },
              events: [],
            },
            // 5. STATUS_CODE_OK — not an error
            {
              traceId: ST_TRACE_ID,
              spanId: 'st-ok',
              parentSpanId: '',
              name: 'ok_operation',
              startTimeUnixNano: '1741900000008000000',
              endTimeUnixNano: '1741900000009000000',
              attributes: [],
              status: { code: 'STATUS_CODE_OK', message: '' },
              events: [],
            },
            // 6. No status field at all
            {
              traceId: ST_TRACE_ID,
              spanId: 'st-none',
              parentSpanId: '',
              name: 'no_status_operation',
              startTimeUnixNano: '1741900000010000000',
              endTimeUnixNano: '1741900000011000000',
              attributes: [],
              events: [],
            },
          ],
        },
      ],
    },
  ],
};
