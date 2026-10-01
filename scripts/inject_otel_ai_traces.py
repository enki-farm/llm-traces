"""
Inject realistic OpenTelemetry GenAI semantic-convention traces into
local Grafana Tempo.

Designed to exercise the enki-farm/llm-traces Grafana plugin with:

    invoke_agent
        └── plan
              └── chat <planning LLM>
        ├── chat <tool-selection LLM>
        ├── execute_tool get_product
        └── chat <final-answer LLM>

The emitted spans follow the current OpenTelemetry GenAI development
semantic conventions:

https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md
https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md

Tempo:
    http://localhost:4318/v1/traces

Install:
    pip install \
        opentelemetry-api \
        opentelemetry-sdk \
        opentelemetry-exporter-otlp-proto-http
"""

import functools
import json
import time
import uuid

from opentelemetry import context as otel_context, trace
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
    OTLPSpanExporter,
)
from opentelemetry.trace import SpanKind, Status, StatusCode


TEMPO_ENDPOINT = "http://localhost:4318/v1/traces"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def json_attr(value):
    """
    Serialize structured GenAI content.

    The GenAI specification requires the JSON schema to be followed.
    When structured attributes are recorded directly on spans, JSON
    strings are permitted when the telemetry API cannot represent the
    structure natively.
    """
    return json.dumps(
        value,
        separators=(",", ":"),
        ensure_ascii=False,
    )


def set_attributes(span, attributes):
    for key, value in attributes.items():
        if value is None:
            continue

        # OpenTelemetry Python supports primitive values and homogeneous
        # primitive sequences. Complex objects need JSON serialization.
        if isinstance(value, (dict, tuple)):
            value = json_attr(value)

        span.set_attribute(key, value)


def new_id(prefix):
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


_CONVERSATION_ID_KEY = otel_context.create_key("gen_ai.conversation.id")


def in_conversation(scenario):
    """
    Run a scenario inside a fresh conversation so every span it starts
    (across all of its traces) carries the same gen_ai.conversation.id.
    """

    @functools.wraps(scenario)
    def run(tracer):
        token = otel_context.attach(
            otel_context.set_value(_CONVERSATION_ID_KEY, new_id("conversation"))
        )
        try:
            return scenario(tracer)
        finally:
            otel_context.detach(token)

    return run


def current_conversation_id():
    return otel_context.get_value(_CONVERSATION_ID_KEY)


def start_span(tracer, name, kind):
    span = tracer.start_span(name, kind=kind)
    conversation_id = current_conversation_id()
    if conversation_id:
        span.set_attribute("gen_ai.conversation.id", conversation_id)
    return span


# ---------------------------------------------------------------------------
# GenAI span helpers
# ---------------------------------------------------------------------------

def start_agent_span(
    tracer,
    agent_name,
    *,
    agent_id=None,
    agent_version=None,
):
    """
    Start an internal agent invocation span.

    Current convention:
        operation = invoke_agent
        kind      = INTERNAL
        name      = invoke_agent {gen_ai.agent.name}
    """

    span = start_span(
        tracer,
        f"invoke_agent {agent_name}",
        kind=SpanKind.INTERNAL,
    )

    span.set_attribute(
        "gen_ai.operation.name",
        "invoke_agent",
    )

    span.set_attribute(
        "gen_ai.agent.name",
        agent_name,
    )

    if agent_id:
        span.set_attribute(
            "gen_ai.agent.id",
            agent_id,
        )

    if agent_version:
        span.set_attribute(
            "gen_ai.agent.version",
            agent_version,
        )

    return span


def start_plan_span(
    tracer,
    agent_name,
):
    """
    Start an agent planning span.

    The current convention defines plan as an INTERNAL span.
    """

    span = start_span(
        tracer,
        f"plan {agent_name}",
        kind=SpanKind.INTERNAL,
    )

    span.set_attribute(
        "gen_ai.operation.name",
        "plan",
    )

    span.set_attribute(
        "gen_ai.agent.name",
        agent_name,
    )

    return span


def start_inference_span(
    tracer,
    *,
    provider,
    model,
    operation="chat",
    agent_name=None,
    temperature=None,
    max_tokens=None,
    input_messages=None,
    output_messages=None,
    system_instructions=None,
    input_tokens=None,
    output_tokens=None,
    response_id=None,
    response_model=None,
    finish_reasons=None,
    conversation_id=None,
    server_address=None,
    server_port=None,
    extra_attributes=None,
):
    """
    Start a current GenAI inference span.

    Span:
        {gen_ai.operation.name} {gen_ai.request.model}

    Kind:
        CLIENT
    """

    span_name = f"{operation} {model}"

    span = start_span(
        tracer,
        span_name,
        kind=SpanKind.CLIENT,
    )

    span.set_attribute(
        "gen_ai.operation.name",
        operation,
    )

    span.set_attribute(
        "gen_ai.provider.name",
        provider,
    )

    span.set_attribute(
        "gen_ai.request.model",
        model,
    )

    if agent_name:
        span.set_attribute(
            "gen_ai.agent.name",
            agent_name,
        )

    if temperature is not None:
        span.set_attribute(
            "gen_ai.request.temperature",
            temperature,
        )

    if max_tokens is not None:
        span.set_attribute(
            "gen_ai.request.max_tokens",
            max_tokens,
        )

    if input_tokens is not None:
        span.set_attribute(
            "gen_ai.usage.input_tokens",
            input_tokens,
        )

    if output_tokens is not None:
        span.set_attribute(
            "gen_ai.usage.output_tokens",
            output_tokens,
        )

    if response_id:
        span.set_attribute(
            "gen_ai.response.id",
            response_id,
        )

    if response_model:
        span.set_attribute(
            "gen_ai.response.model",
            response_model,
        )

    if finish_reasons:
        span.set_attribute(
            "gen_ai.response.finish_reasons",
            finish_reasons,
        )

    if conversation_id:
        span.set_attribute(
            "gen_ai.conversation.id",
            conversation_id,
        )

    if server_address:
        span.set_attribute(
            "server.address",
            server_address,
        )

    if server_port:
        span.set_attribute(
            "server.port",
            server_port,
        )

    # These are opt-in content attributes.
    if system_instructions:
        span.set_attribute(
            "gen_ai.system_instructions",
            json_attr(system_instructions),
        )

    if input_messages:
        span.set_attribute(
            "gen_ai.input.messages",
            json_attr(input_messages),
        )

    if output_messages:
        span.set_attribute(
            "gen_ai.output.messages",
            json_attr(output_messages),
        )

    if extra_attributes:
        set_attributes(span, extra_attributes)

    return span


def start_embeddings_span(tracer, *, model, input_tokens, dimensions):
    span = start_span(tracer, f"embeddings {model}", kind=SpanKind.CLIENT)
    set_attributes(span, {
        "gen_ai.operation.name": "embeddings",
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": model,
        "gen_ai.response.model": model,
        "gen_ai.embeddings.dimension.count": dimensions,
        "gen_ai.request.encoding_formats": ["float"],
        "gen_ai.usage.input_tokens": input_tokens,
        "server.address": "api.openai.com",
        "server.port": 443,
    })
    return span


def start_fetch_response_span(tracer, *, response_id, status, cursor=None,
                              output_messages=None, finish_reasons=None):
    span = start_span(tracer, "fetch_response", kind=SpanKind.CLIENT)
    set_attributes(span, {
        "gen_ai.operation.name": "fetch_response",
        "gen_ai.provider.name": "openai",
        "gen_ai.response.id": response_id,
        "gen_ai.response.status": status,
        "gen_ai.request.stream_cursor": cursor,
        "gen_ai.response.finish_reasons": finish_reasons,
        "gen_ai.output.messages": json_attr(output_messages) if output_messages else None,
        "server.address": "api.openai.com",
        "server.port": 443,
    })
    return span


def start_memory_span(tracer, operation, *, store_id, record_id=None, count=None,
                      query=None, records=None):
    span = start_span(tracer, operation, kind=SpanKind.CLIENT)
    set_attributes(span, {
        "gen_ai.operation.name": operation,
        "gen_ai.provider.name": "aws.bedrock",
        "gen_ai.memory.store.id": store_id,
        "gen_ai.memory.record.id": record_id,
        "gen_ai.memory.record.count": count,
        "gen_ai.memory.query.text": query,
        "gen_ai.memory.records": json_attr(records) if records is not None else None,
        "server.address": "bedrock-agentcore.us-east-1.amazonaws.com",
        "server.port": 443,
    })
    return span


def start_agent_operation_span(tracer, operation, agent_name):
    span = start_span(tracer, f"{operation} {agent_name}", kind=SpanKind.INTERNAL)
    set_attributes(span, {
        "gen_ai.operation.name": operation,
        "gen_ai.agent.name": agent_name,
    })
    return span


def start_tool_span(
    tracer,
    *,
    tool_name,
    tool_type="function",
    agent_name=None,
    call_id=None,
    description=None,
    arguments=None,
):
    """
    Start a current GenAI execute_tool span.

    Current convention:
        operation = execute_tool
        kind      = INTERNAL
        name      = execute_tool {gen_ai.tool.name}
    """

    span = start_span(
        tracer,
        f"execute_tool {tool_name}",
        kind=SpanKind.INTERNAL,
    )

    span.set_attribute(
        "gen_ai.operation.name",
        "execute_tool",
    )

    span.set_attribute(
        "gen_ai.tool.name",
        tool_name,
    )

    span.set_attribute(
        "gen_ai.tool.type",
        tool_type,
    )

    if agent_name:
        span.set_attribute(
            "gen_ai.agent.name",
            agent_name,
        )

    if call_id:
        span.set_attribute(
            "gen_ai.tool.call.id",
            call_id,
        )

    if description:
        span.set_attribute(
            "gen_ai.tool.description",
            description,
        )

    if arguments is not None:
        span.set_attribute(
            "gen_ai.tool.call.arguments",
            json_attr(arguments),
        )

    return span


# ---------------------------------------------------------------------------
# Synthetic tool implementations
# ---------------------------------------------------------------------------

def get_product(product_id):
    """
    Fake product lookup.

    In a real application this would probably be a DB/API span nested
    under the execute_tool span.
    """

    time.sleep(0.18)

    return {
        "id": product_id,
        "name": "Product 12345",
        "description": (
            "Real-time analytics, custom dashboards, "
            "and API access."
        ),
        "price": 149.00,
        "availability": "in_stock",
        "rating": 4.7,
    }


def search_products(category, max_price):
    """
    Fake product search tool.
    """

    time.sleep(0.27)

    return [
        {
            "id": "smarthome-001",
            "name": "Smart LED Bulb Starter Kit",
            "price": 49,
        },
        {
            "id": "smarthome-002",
            "name": "WiFi Smart Plug Mini",
            "price": 29,
        },
        {
            "id": "smarthome-003",
            "name": "Smart Door Sensor Bundle",
            "price": 35,
        },
    ]


# ---------------------------------------------------------------------------
# Main synthetic trace
# ---------------------------------------------------------------------------

@in_conversation
def inject_customer_support_agent(tracer):
    """
    Complex trace:

        invoke_agent Customer Support Agent
        |
        +-- plan Customer Support Agent
        |     |
        |     +-- chat claude-sonnet-4-5
        |
        +-- chat claude-sonnet-4-5
        |
        +-- execute_tool get_product
        |
        +-- chat claude-sonnet-4-5
    """

    agent_name = "Customer Support Agent"
    agent_id = "agent-customer-support-v1"
    agent_version = "1.4.0"
    conversation_id = current_conversation_id()

    # ---------------------------------------------------------------
    # Agent invocation
    # ---------------------------------------------------------------

    agent_span = start_agent_span(
        tracer,
        agent_name,
        agent_id=agent_id,
        agent_version=agent_version,
    )

    with trace.use_span(agent_span, end_on_exit=True):

        # -----------------------------------------------------------
        # Planning
        # -----------------------------------------------------------

        plan_span = start_plan_span(
            tracer,
            agent_name,
        )

        with trace.use_span(plan_span, end_on_exit=True):

            plan_llm = start_inference_span(
                tracer,
                provider="anthropic",
                model="claude-sonnet-4-5",
                operation="chat",
                agent_name=agent_name,
                temperature=0.2,
                max_tokens=512,
                input_tokens=241,
                output_tokens=73,
                response_id=new_id("msg"),
                response_model="claude-sonnet-4-5",
                finish_reasons=["end_turn"],
                conversation_id=conversation_id,
                server_address="api.anthropic.com",
                server_port=443,
                system_instructions=[
                    {
                        "type": "text",
                        "content": (
                            "You are an agent planner. "
                            "Break customer requests into actionable steps."
                        ),
                    }
                ],
                input_messages=[
                    {
                        "role": "user",
                        "parts": [
                            {
                                "type": "text",
                                "content": (
                                    "Customer asks: What features does "
                                    "product 12345 have?"
                                ),
                            }
                        ],
                    }
                ],
                output_messages=[
                    {
                        "role": "assistant",
                        "parts": [
                            {
                                "type": "text",
                                "content": (
                                    "Plan: look up product 12345, "
                                    "then summarize its features."
                                ),
                            }
                        ],
                    }
                ],
            )

            with trace.use_span(
                plan_llm,
                end_on_exit=True,
            ):
                time.sleep(0.62)

        # -----------------------------------------------------------
        # Agent decides to use a product lookup tool
        # -----------------------------------------------------------

        decision_llm = start_inference_span(
            tracer,
            provider="anthropic",
            model="claude-sonnet-4-5",
            operation="chat",
            agent_name=agent_name,
            temperature=0.3,
            max_tokens=512,
            input_tokens=328,
            output_tokens=91,
            response_id=new_id("msg"),
            response_model="claude-sonnet-4-5",
            finish_reasons=["tool_use"],
            conversation_id=conversation_id,
            server_address="api.anthropic.com",
            server_port=443,
            extra_attributes={
                "gen_ai.request.top_k": 40,
                "gen_ai.tool.definitions": json_attr([{
                    "type": "function", "name": "get_product",
                    "description": "Retrieve product information by product ID.",
                    "parameters": {"type": "object", "properties": {
                        "product_id": {"type": "string"},
                    }, "required": ["product_id"]},
                }]),
            },
            system_instructions=[
                {
                    "type": "text",
                    "content": (
                        "You are a customer support assistant. "
                        "Use tools when product information is required."
                    ),
                }
            ],
            input_messages=[
                {
                    "role": "user",
                    "parts": [
                        {
                            "type": "text",
                            "content": (
                                "What features does product 12345 have?"
                            ),
                        }
                    ],
                }
            ],
            output_messages=[
                {
                    "role": "assistant",
                    "parts": [
                        {
                            "type": "tool_call",
                            "id": "tool-call-product-12345",
                            "name": "get_product",
                            "arguments": {
                                "product_id": "12345",
                            },
                        }
                    ],
                }
            ],
        )

        with trace.use_span(
            decision_llm,
            end_on_exit=True,
        ):
            time.sleep(0.71)

        # -----------------------------------------------------------
        # Tool execution
        # -----------------------------------------------------------

        tool_span = start_tool_span(
            tracer,
            tool_name="get_product",
            tool_type="function",
            agent_name=agent_name,
            call_id="tool-call-product-12345",
            description=(
                "Retrieve product information by product ID."
            ),
            arguments={
                "product_id": "12345",
            },
        )

        with trace.use_span(
            tool_span,
            end_on_exit=True,
        ):
            product = get_product("12345")

            # Simulate an application/database child span.
            with tracer.start_as_current_span(
                "product_database.query",
                kind=SpanKind.CLIENT,
            ):
                time.sleep(0.08)

        # -----------------------------------------------------------
        # Final answer LLM
        # -----------------------------------------------------------

        final_llm = start_inference_span(
            tracer,
            provider="anthropic",
            model="claude-sonnet-4-5",
            operation="chat",
            agent_name=agent_name,
            temperature=0.3,
            max_tokens=1024,
            input_tokens=497,
            output_tokens=83,
            response_id=new_id("msg"),
            response_model="claude-sonnet-4-5",
            finish_reasons=["end_turn"],
            conversation_id=conversation_id,
            server_address="api.anthropic.com",
            server_port=443,
            system_instructions=[
                {
                    "type": "text",
                    "content": (
                        "You are a helpful customer support assistant. "
                        "Answer using the supplied product information."
                    ),
                }
            ],
            input_messages=[
                {
                    "role": "user",
                    "parts": [
                        {
                            "type": "text",
                            "content": (
                                "What features does product 12345 have?"
                            ),
                        }
                    ],
                },
                {
                    "role": "tool",
                    "parts": [
                        {
                            "type": "tool_result",
                            "tool_call_id": "tool-call-product-12345",
                            "content": json.dumps(product),
                        }
                    ],
                },
            ],
            output_messages=[
                {
                    "role": "assistant",
                    "parts": [
                        {
                            "type": "text",
                            "content": (
                                "Product 12345 includes real-time analytics, "
                                "custom dashboards, and API access. It is "
                                "currently in stock at $149 and has a 4.7/5 "
                                "rating."
                            ),
                        }
                    ],
                }
            ],
        )

        with trace.use_span(
            final_llm,
            end_on_exit=True,
        ):
            time.sleep(0.94)


@in_conversation
def inject_recommendation_agent(tracer):
    """
    Second agentic trace to exercise a different provider and a tool
    returning multiple records.

        invoke_agent Recommendation Agent
        |
        +-- chat gemini-2.5-flash
        |
        +-- execute_tool search_products
        |
        +-- chat gemini-2.5-flash
    """

    agent_name = "Product Recommendation Agent"
    conversation_id = current_conversation_id()

    agent_span = start_agent_span(
        tracer,
        agent_name,
        agent_id="agent-recommendations-v2",
        agent_version="2.1.0",
    )

    with trace.use_span(
        agent_span,
        end_on_exit=True,
    ):

        # Initial inference / tool selection.
        llm = start_inference_span(
            tracer,
            provider="gcp.gemini",
            model="gemini-2.5-flash",
            operation="generate_content",
            agent_name=agent_name,
            temperature=0.5,
            max_tokens=512,
            input_tokens=388,
            output_tokens=104,
            response_id=new_id("gemini"),
            response_model="gemini-2.5-flash",
            finish_reasons=["STOP"],
            conversation_id=conversation_id,
            server_address="generativelanguage.googleapis.com",
            server_port=443,
            system_instructions=[
                {
                    "type": "text",
                    "content": (
                        "You are a product recommendation agent. "
                        "Use the product search tool before making "
                        "recommendations."
                    ),
                }
            ],
            input_messages=[
                {
                    "role": "user",
                    "parts": [
                        {
                            "type": "text",
                            "content": (
                                "Recommend three smart-home products "
                                "under $200."
                            ),
                        }
                    ],
                }
            ],
            output_messages=[
                {
                    "role": "assistant",
                    "parts": [
                        {
                            "type": "tool_call",
                            "id": "tool-call-smart-home",
                            "name": "search_products",
                            "arguments": {
                                "category": "smart home",
                                "max_price": 200,
                            },
                        }
                    ],
                }
            ],
        )

        with trace.use_span(
            llm,
            end_on_exit=True,
        ):
            time.sleep(0.83)

        # Tool.
        tool = start_tool_span(
            tracer,
            tool_name="search_products",
            tool_type="function",
            agent_name=agent_name,
            call_id="tool-call-smart-home",
            description=(
                "Search the product catalog using category and price."
            ),
            arguments={
                "category": "smart home",
                "max_price": 200,
            },
        )

        with trace.use_span(
            tool,
            end_on_exit=True,
        ):
            results = search_products(
                "smart home",
                200,
            )

        # Final inference.
        final = start_inference_span(
            tracer,
            provider="gcp.gemini",
            model="gemini-2.5-flash",
            operation="generate_content",
            agent_name=agent_name,
            temperature=0.5,
            max_tokens=512,
            input_tokens=612,
            output_tokens=128,
            response_id=new_id("gemini"),
            response_model="gemini-2.5-flash",
            finish_reasons=["STOP"],
            conversation_id=conversation_id,
            server_address="generativelanguage.googleapis.com",
            server_port=443,
            input_messages=[
                {
                    "role": "user",
                    "parts": [
                        {
                            "type": "text",
                            "content": (
                                "Recommend three smart-home products "
                                "under $200."
                            ),
                        }
                    ],
                },
                {
                    "role": "tool",
                    "parts": [
                        {
                            "type": "tool_result",
                            "tool_call_id": "tool-call-smart-home",
                            "content": json.dumps(results),
                        }
                    ],
                },
            ],
            output_messages=[
                {
                    "role": "assistant",
                    "parts": [
                        {
                            "type": "text",
                            "content": (
                                "Here are three smart-home options: "
                                "Smart LED Bulb Starter Kit ($49), "
                                "WiFi Smart Plug Mini ($29), and "
                                "Smart Door Sensor Bundle ($35)."
                            ),
                        }
                    ],
                }
            ],
        )

        with trace.use_span(
            final,
            end_on_exit=True,
        ):
            time.sleep(0.91)


# ---------------------------------------------------------------------------
# RAG trace helper
# ---------------------------------------------------------------------------

def start_retrieval_span(
    tracer,
    *,
    data_source_id,
    provider=None,
    model=None,
    query,
    top_k,
    retrieved_documents=None,
):
    """
    Start a retrieval span for RAG pipelines.
    """

    span = start_span(
        tracer,
        f"retrieval {data_source_id}",
        kind=SpanKind.CLIENT,
    )

    span.set_attribute(
        "gen_ai.operation.name",
        "retrieval",
    )

    if provider:
        span.set_attribute(
            "gen_ai.provider.name",
            provider,
        )

    if model:
        span.set_attribute("gen_ai.request.model", model)

    span.set_attribute(
        "gen_ai.data_source.id",
        data_source_id,
    )

    span.set_attribute(
        "gen_ai.retrieval.query.text",
        query,
    )

    span.set_attribute(
        "gen_ai.retrieval.top_k",
        top_k,
    )

    if retrieved_documents:
        span.set_attribute(
            "gen_ai.retrieval.documents",
            json_attr(retrieved_documents),
        )

    return span


# ---------------------------------------------------------------------------
# RAG trace helper: knowledge base lookup
# ---------------------------------------------------------------------------

def start_kb_lookup_span(
    tracer,
    *,
    data_source_id,
    provider=None,
    query,
    results,
):
    """
    Start a knowledge-base lookup span simulating internal search.
    """

    span = start_span(
        tracer,
        f"retrieval {data_source_id}",
        kind=SpanKind.CLIENT,
    )

    span.set_attribute(
        "gen_ai.operation.name",
        "retrieval",
    )

    if provider:
        span.set_attribute(
            "gen_ai.provider.name",
            provider,
        )

    span.set_attribute(
        "gen_ai.data_source.id",
        data_source_id,
    )

    span.set_attribute(
        "gen_ai.retrieval.query.text",
        query,
    )

    span.set_attribute(
        "gen_ai.retrieval.documents",
        json_attr(results),
    )

    return span


# ---------------------------------------------------------------------------
# Synthetic RAG data
# ---------------------------------------------------------------------------

def retrieve_knowledge(query, top_k=3):
    """
    Fake RAG retrieval — returns context documents.
    """

    time.sleep(0.15)

    docs = {
        "faq": [
            {
                "id": "faq-001",
                "title": "Shipping & Delivery",
                "content": (
                    "Standard shipping takes 5-7 business days. "
                    "Express shipping (1-2 days) is available for $12.99. "
                    "Free shipping on orders over $75."
                ),
            },
            {
                "id": "faq-002",
                "title": "Return Policy",
                "content": (
                    "Items can be returned within 30 days of delivery. "
                    "Original packaging required. Refund processed within "
                    "5 business days of receiving the return."
                ),
            },
            {
                "id": "faq-003",
                "title": "Warranty",
                "content": (
                    "All products include a 2-year limited warranty. "
                    "Extended warranty available for purchase within "
                    "90 days of purchase."
                ),
            },
        ],
        "orders": [
            {
                "order_id": "ORD-98765",
                "status": "shipped",
                "carrier": "FastShip",
                "tracking": "FS-29384756",
                "eta": "2026-10-02",
            }
        ],
    }

    return docs.get(query, [])


# ---------------------------------------------------------------------------
# Multi-turn RAG agent
# ---------------------------------------------------------------------------

@in_conversation
def inject_rag_support_agent(tracer):
    """
    Multi-turn RAG conversation: one trace per turn, sharing
    gen_ai.conversation.id.

        invoke_agent RAG Support Agent          (trace 1)
        |
        +-- chat claude-sonnet-4-5
        |     (decides to retrieve knowledge)
        |
        +-- retrieve faiss-index
        |     (retrieves FAQ documents)
        |
        +-- chat claude-sonnet-4-5
        |     (generates answer from context)

        invoke_agent RAG Support Agent          (trace 2)
        |
        +-- chat claude-sonnet-4-5
        |     (user follow-up question)
        |
        +-- retrieve faiss-index
        |     (retrieves order info)
        |
        +-- chat claude-sonnet-4-5
        |     (final answer with order details)
    """

    agent_name = "RAG Support Agent"
    agent_id = "agent-rag-support-v3"
    agent_version = "3.2.1"
    conversation_id = current_conversation_id()

    agent_span = start_agent_span(
        tracer,
        agent_name,
        agent_id=agent_id,
        agent_version=agent_version,
    )

    with trace.use_span(agent_span, end_on_exit=True):

        # -----------------------------------------------------------
        # Turn 1: User asks about shipping
        # -----------------------------------------------------------

        turn1_llm = start_inference_span(
            tracer,
            provider="anthropic",
            model="claude-sonnet-4-5",
            operation="chat",
            agent_name=agent_name,
            temperature=0.1,
            max_tokens=256,
            input_tokens=412,
            output_tokens=64,
            response_id=new_id("msg"),
            response_model="claude-sonnet-4-5",
            finish_reasons=["tool_use"],
            conversation_id=conversation_id,
            server_address="api.anthropic.com",
            server_port=443,
            system_instructions=[
                {
                    "type": "text",
                    "content": (
                        "You are a customer support agent with access to "
                        "a knowledge base and order lookup tools. "
                        "Always retrieve relevant context before answering."
                    ),
                }
            ],
            input_messages=[
                {
                    "role": "user",
                    "parts": [
                        {
                            "type": "text",
                            "content": (
                                "How long does shipping take? "
                                "And what is your return policy?"
                            ),
                        }
                    ],
                }
            ],
            output_messages=[
                {
                    "role": "assistant",
                    "parts": [
                        {
                            "type": "tool_call",
                            "id": "tool-call-rag-001",
                            "name": "retrieve_knowledge",
                            "arguments": {
                                "query": "shipping delivery return policy",
                                "top_k": 3,
                            },
                        }
                    ],
                }
            ],
        )

        with trace.use_span(turn1_llm, end_on_exit=True):
            time.sleep(0.55)

        # -----------------------------------------------------------
        # Turn 1: Retrieve knowledge
        # -----------------------------------------------------------

        embedding = start_embeddings_span(
            tracer, model="text-embedding-3-small", input_tokens=128, dimensions=1536,
        )
        with trace.use_span(embedding, end_on_exit=True):
            time.sleep(0.06)

        retrieve1 = start_retrieval_span(
            tracer,
            data_source_id="faiss-index",
            provider=None,
            model=None,
            query="shipping delivery return policy",
            top_k=3,
            retrieved_documents=[
                {
                    "id": "faq-001",
                    "title": "Shipping & Delivery",
                    "score": 0.94,
                },
                {
                    "id": "faq-002",
                    "title": "Return Policy",
                    "score": 0.89,
                },
            ],
        )

        with trace.use_span(retrieve1, end_on_exit=True):
            time.sleep(0.15)

        # Also do a KB lookup for internal docs
        kb1 = start_kb_lookup_span(
            tracer,
            data_source_id="company-faq",
            provider=None,
            query="shipping delivery return policy",
            results=[
                {
                    "source": "internal-wiki",
                    "title": "Shipping Standards v2.1",
                    "snippet": (
                        "Standard shipping: 5-7 business days. "
                        "Express: 1-2 business days, $12.99 flat rate."
                    ),
                }
            ],
        )

        with trace.use_span(kb1, end_on_exit=True):
            time.sleep(0.12)

        # -----------------------------------------------------------
        # Turn 1: LLM generates answer from retrieved context
        # -----------------------------------------------------------

        turn1_answer = start_inference_span(
            tracer,
            provider="anthropic",
            model="claude-sonnet-4-5",
            operation="chat",
            agent_name=agent_name,
            temperature=0.1,
            max_tokens=512,
            input_tokens=1024,
            output_tokens=156,
            response_id=new_id("msg"),
            response_model="claude-sonnet-4-5",
            finish_reasons=["end_turn"],
            conversation_id=conversation_id,
            server_address="api.anthropic.com",
            server_port=443,
            input_messages=[
                {
                    "role": "user",
                    "parts": [
                        {
                            "type": "text",
                            "content": (
                                "How long does shipping take? "
                                "And what is your return policy?"
                            ),
                        }
                    ],
                },
                {
                    "role": "tool",
                    "parts": [
                        {
                            "type": "tool_result",
                            "tool_call_id": "tool-call-rag-001",
                            "content": json.dumps([
                                {
                                    "id": "faq-001",
                                    "title": "Shipping & Delivery",
                                    "content": (
                                        "Standard shipping takes 5-7 "
                                        "business days. Express shipping "
                                        "(1-2 days) is available for $12.99. "
                                        "Free shipping on orders over $75."
                                    ),
                                },
                                {
                                    "id": "faq-002",
                                    "title": "Return Policy",
                                    "content": (
                                        "Items can be returned within 30 "
                                        "days of delivery. Original "
                                        "packaging required. Refund "
                                        "processed within 5 business "
                                        "days of receiving the return."
                                    ),
                                },
                            ]),
                        }
                    ],
                },
            ],
            output_messages=[
                {
                    "role": "assistant",
                    "parts": [
                        {
                            "type": "text",
                            "content": (
                                "Standard shipping takes 5-7 business days, "
                                "with express options available for $12.99 "
                                "(1-2 days). Free shipping on orders over "
                                "$75. For returns, you have 30 days from "
                                "delivery with original packaging. Refunds "
                                "are processed within 5 business days."
                            ),
                        }
                    ],
                }
            ],
        )

        with trace.use_span(turn1_answer, end_on_exit=True):
            time.sleep(0.82)

    # Each user turn is a separate request, i.e. its own trace, correlated
    # with the previous turn only through gen_ai.conversation.id.
    agent_span = start_agent_span(
        tracer,
        agent_name,
        agent_id=agent_id,
        agent_version=agent_version,
    )

    with trace.use_span(agent_span, end_on_exit=True):

        # -----------------------------------------------------------
        # Turn 2: User follow-up about their order
        # -----------------------------------------------------------

        turn2_llm = start_inference_span(
            tracer,
            provider="anthropic",
            model="claude-sonnet-4-5",
            operation="chat",
            agent_name=agent_name,
            temperature=0.1,
            max_tokens=256,
            input_tokens=1536,
            output_tokens=52,
            response_id=new_id("msg"),
            response_model="claude-sonnet-4-5",
            finish_reasons=["tool_use"],
            conversation_id=conversation_id,
            server_address="api.anthropic.com",
            server_port=443,
            input_messages=[
                {
                    "role": "user",
                    "parts": [
                        {
                            "type": "text",
                            "content": (
                                "How long does shipping take? "
                                "And what is your return policy?"
                            ),
                        }
                    ],
                },
                {
                    "role": "assistant",
                    "parts": [
                        {
                            "type": "text",
                            "content": (
                                "Standard shipping takes 5-7 business days, "
                                "with express options available for $12.99 "
                                "(1-2 days). Free shipping on orders over "
                                "$75. For returns, you have 30 days from "
                                "delivery with original packaging. Refunds "
                                "are processed within 5 business days."
                            ),
                        }
                    ],
                },
                {
                    "role": "user",
                    "parts": [
                        {
                            "type": "text",
                            "content": (
                                "Can you check on my order ORD-98765? "
                                "When will it arrive?"
                            ),
                        }
                    ],
                },
            ],
            output_messages=[
                {
                    "role": "assistant",
                    "parts": [
                        {
                            "type": "tool_call",
                            "id": "tool-call-rag-002",
                            "name": "retrieve_knowledge",
                            "arguments": {
                                "query": "order ORD-98765 status tracking",
                                "top_k": 1,
                            },
                        }
                    ],
                }
            ],
        )

        with trace.use_span(turn2_llm, end_on_exit=True):
            time.sleep(0.48)

        # -----------------------------------------------------------
        # Turn 2: Retrieve order info
        # -----------------------------------------------------------

        embedding = start_embeddings_span(
            tracer, model="text-embedding-3-small", input_tokens=96, dimensions=1536,
        )
        with trace.use_span(embedding, end_on_exit=True):
            time.sleep(0.06)

        retrieve2 = start_retrieval_span(
            tracer,
            data_source_id="faiss-index",
            provider=None,
            model=None,
            query="order ORD-98765 status tracking",
            top_k=1,
            retrieved_documents=[
                {
                    "order_id": "ORD-98765",
                    "status": "shipped",
                    "carrier": "FastShip",
                    "tracking": "FS-29384756",
                    "eta": "2026-10-02",
                }
            ],
        )

        with trace.use_span(retrieve2, end_on_exit=True):
            time.sleep(0.18)

        # -----------------------------------------------------------
        # Turn 2: LLM generates final answer
        # -----------------------------------------------------------

        turn2_answer = start_inference_span(
            tracer,
            provider="anthropic",
            model="claude-sonnet-4-5",
            operation="chat",
            agent_name=agent_name,
            temperature=0.1,
            max_tokens=512,
            input_tokens=1840,
            output_tokens=128,
            response_id=new_id("msg"),
            response_model="claude-sonnet-4-5",
            finish_reasons=["end_turn"],
            conversation_id=conversation_id,
            server_address="api.anthropic.com",
            server_port=443,
            input_messages=[
                {
                    "role": "user",
                    "parts": [
                        {
                            "type": "text",
                            "content": (
                                "How long does shipping take? "
                                "And what is your return policy?"
                            ),
                        }
                    ],
                },
                {
                    "role": "assistant",
                    "parts": [
                        {
                            "type": "text",
                            "content": (
                                "Standard shipping takes 5-7 business days, "
                                "with express options available for $12.99."
                            ),
                        }
                    ],
                },
                {
                    "role": "user",
                    "parts": [
                        {
                            "type": "text",
                            "content": (
                                "Can you check on my order ORD-98765? "
                                "When will it arrive?"
                            ),
                        }
                    ],
                },
                {
                    "role": "tool",
                    "parts": [
                        {
                            "type": "tool_result",
                            "tool_call_id": "tool-call-rag-002",
                            "content": json.dumps({
                                "order_id": "ORD-98765",
                                "status": "shipped",
                                "carrier": "FastShip",
                                "tracking": "FS-29384756",
                                "eta": "2026-10-02",
                            }),
                        }
                    ],
                },
            ],
            output_messages=[
                {
                    "role": "assistant",
                    "parts": [
                        {
                            "type": "text",
                            "content": (
                                "Order ORD-98765 has been shipped via "
                                "FastShip (tracking: FS-29384756). "
                                "Estimated delivery is October 2nd, 2026. "
                                "You can track your package on the FastShip "
                                "website using the tracking number."
                            ),
                        }
                    ],
                }
            ],
        )

        with trace.use_span(turn2_answer, end_on_exit=True):
            time.sleep(0.76)


# ---------------------------------------------------------------------------
# Multi-tool orchestration agent
# ---------------------------------------------------------------------------

@in_conversation
def inject_multi_tool_agent(tracer):
    """
    Multi-tool orchestration conversation: one trace per turn, sharing
    gen_ai.conversation.id.

        invoke_agent Order Management Agent     (trace 1)
        |
        +-- chat claude-sonnet-4-5
        |     (user wants to modify order)
        |
        +-- execute_tool get_order
        |
        +-- execute_tool update_shipping
        |
        +-- execute_tool apply_discount
        |
        +-- chat claude-sonnet-4-5
        |     (confirm all changes)

        invoke_agent Order Management Agent     (trace 2)
        |
        +-- chat claude-sonnet-4-5
        |     (user asks to cancel, agent checks policy)
        |
        +-- retrieve faiss-index
        |     (lookup cancellation policy)
        |
        +-- chat claude-sonnet-4-5
        |     (explain cancellation options)
    """

    agent_name = "Order Management Agent"
    agent_id = "agent-order-mgmt-v2"
    agent_version = "2.0.5"
    conversation_id = current_conversation_id()

    agent_span = start_agent_span(
        tracer,
        agent_name,
        agent_id=agent_id,
        agent_version=agent_version,
    )

    with trace.use_span(agent_span, end_on_exit=True):

        # -----------------------------------------------------------
        # Turn 1: User wants to modify order
        # -----------------------------------------------------------

        turn1_llm = start_inference_span(
            tracer,
            provider="anthropic",
            model="claude-sonnet-4-5",
            operation="chat",
            agent_name=agent_name,
            temperature=0.2,
            max_tokens=256,
            input_tokens=356,
            output_tokens=48,
            response_id=new_id("msg"),
            response_model="claude-sonnet-4-5",
            finish_reasons=["tool_use"],
            conversation_id=conversation_id,
            server_address="api.anthropic.com",
            server_port=443,
            system_instructions=[
                {
                    "type": "text",
                    "content": (
                        "You are an order management agent. You can look up "
                        "orders, update shipping, apply discounts, and "
                        "handle cancellations. Always verify order details "
                        "before making changes."
                    ),
                }
            ],
            input_messages=[
                {
                    "role": "user",
                    "parts": [
                        {
                            "type": "text",
                            "content": (
                                "I need to change the shipping address "
                                "for order ORD-54321 and apply a "
                                "discount code WELCOME20."
                            ),
                        }
                    ],
                }
            ],
            output_messages=[
                {
                    "role": "assistant",
                    "parts": [
                        {
                            "type": "tool_call",
                            "id": "tool-call-om-001",
                            "name": "get_order",
                            "arguments": {
                                "order_id": "ORD-54321",
                            },
                        }
                    ],
                }
            ],
        )

        with trace.use_span(turn1_llm, end_on_exit=True):
            time.sleep(0.62)

        # -----------------------------------------------------------
        # Tool: get_order
        # -----------------------------------------------------------

        tool_order = start_tool_span(
            tracer,
            tool_name="get_order",
            tool_type="function",
            agent_name=agent_name,
            call_id="tool-call-om-001",
            description="Retrieve order details by order ID.",
            arguments={
                "order_id": "ORD-54321",
            },
        )

        with trace.use_span(tool_order, end_on_exit=True):
            time.sleep(0.12)

        # -----------------------------------------------------------
        # Tool: update_shipping
        # -----------------------------------------------------------

        tool_shipping = start_tool_span(
            tracer,
            tool_name="update_shipping",
            tool_type="function",
            agent_name=agent_name,
            call_id="tool-call-om-002",
            description="Update shipping address for an order.",
            arguments={
                "order_id": "ORD-54321",
                "new_address": {
                    "street": "789 Oak Avenue",
                    "city": "Portland",
                    "state": "OR",
                    "zip": "97201",
                },
            },
        )

        with trace.use_span(tool_shipping, end_on_exit=True):
            time.sleep(0.15)

        # -----------------------------------------------------------
        # Tool: apply_discount
        # -----------------------------------------------------------

        tool_discount = start_tool_span(
            tracer,
            tool_name="apply_discount",
            tool_type="function",
            agent_name=agent_name,
            call_id="tool-call-om-003",
            description="Apply a discount code to an order.",
            arguments={
                "order_id": "ORD-54321",
                "code": "WELCOME20",
            },
        )

        with trace.use_span(tool_discount, end_on_exit=True):
            time.sleep(0.10)

        # -----------------------------------------------------------
        # Turn 1: Confirm changes
        # -----------------------------------------------------------

        turn1_confirm = start_inference_span(
            tracer,
            provider="anthropic",
            model="claude-sonnet-4-5",
            operation="chat",
            agent_name=agent_name,
            temperature=0.2,
            max_tokens=512,
            input_tokens=1240,
            output_tokens=142,
            response_id=new_id("msg"),
            response_model="claude-sonnet-4-5",
            finish_reasons=["end_turn"],
            conversation_id=conversation_id,
            server_address="api.anthropic.com",
            server_port=443,
            input_messages=[
                {
                    "role": "user",
                    "parts": [
                        {
                            "type": "text",
                            "content": (
                                "I need to change the shipping address "
                                "for order ORD-54321 and apply a "
                                "discount code WELCOME20."
                            ),
                        }
                    ],
                },
                {
                    "role": "tool",
                    "parts": [
                        {
                            "type": "tool_result",
                            "tool_call_id": "tool-call-om-001",
                            "content": json.dumps({
                                "order_id": "ORD-54321",
                                "customer": "Jane Smith",
                                "items": [
                                    {"name": "Wireless Headphones", "qty": 1, "price": 79.99},
                                    {"name": "Phone Case", "qty": 2, "price": 24.99},
                                ],
                                "subtotal": 129.97,
                                "status": "processing",
                            }),
                        }
                    ],
                },
                {
                    "role": "tool",
                    "parts": [
                        {
                            "type": "tool_result",
                            "tool_call_id": "tool-call-om-002",
                            "content": json.dumps({
                                "success": True,
                                "new_address": {
                                    "street": "789 Oak Avenue",
                                    "city": "Portland",
                                    "state": "OR",
                                    "zip": "97201",
                                },
                            }),
                        }
                    ],
                },
                {
                    "role": "tool",
                    "parts": [
                        {
                            "type": "tool_result",
                            "tool_call_id": "tool-call-om-003",
                            "content": json.dumps({
                                "success": True,
                                "discount": "WELCOME20",
                                "amount_off": 25.99,
                                "new_total": 103.98,
                            }),
                        }
                    ],
                },
            ],
            output_messages=[
                {
                    "role": "assistant",
                    "parts": [
                        {
                            "type": "text",
                            "content": (
                                "I've updated the shipping address for "
                                "order ORD-54321 to 789 Oak Avenue, "
                                "Portland, OR 97201. I've also applied "
                                "the WELCOME20 discount, saving you $25.99. "
                                "Your new order total is $103.98. The "
                                "order is still processing and will ship "
                                "to the new address once ready."
                            ),
                        }
                    ],
                }
            ],
        )

        with trace.use_span(turn1_confirm, end_on_exit=True):
            time.sleep(0.88)

    # Each user turn is a separate request, i.e. its own trace, correlated
    # with the previous turn only through gen_ai.conversation.id.
    agent_span = start_agent_span(
        tracer,
        agent_name,
        agent_id=agent_id,
        agent_version=agent_version,
    )

    with trace.use_span(agent_span, end_on_exit=True):

        # -----------------------------------------------------------
        # Turn 2: User wants to cancel
        # -----------------------------------------------------------

        turn2_llm = start_inference_span(
            tracer,
            provider="anthropic",
            model="claude-sonnet-4-5",
            operation="chat",
            agent_name=agent_name,
            temperature=0.2,
            max_tokens=256,
            input_tokens=1680,
            output_tokens=40,
            response_id=new_id("msg"),
            response_model="claude-sonnet-4-5",
            finish_reasons=["tool_use"],
            conversation_id=conversation_id,
            server_address="api.anthropic.com",
            server_port=443,
            input_messages=[
                {
                    "role": "user",
                    "parts": [
                        {
                            "type": "text",
                            "content": (
                                "Actually, I need to cancel this order "
                                "instead. Can you help?"
                            ),
                        }
                    ],
                },
                {
                    "role": "assistant",
                    "parts": [
                        {
                            "type": "text",
                            "content": (
                                "I've updated the shipping address for "
                                "order ORD-54321 to 789 Oak Avenue, "
                                "Portland, OR 97201. I've also applied "
                                "the WELCOME20 discount, saving you $25.99."
                            ),
                        }
                    ],
                },
                {
                    "role": "user",
                    "parts": [
                        {
                            "type": "text",
                            "content": (
                                "Actually, I need to cancel this order "
                                "instead. Can you help?"
                            ),
                        }
                    ],
                },
            ],
            output_messages=[
                {
                    "role": "assistant",
                    "parts": [
                        {
                            "type": "tool_call",
                            "id": "tool-call-om-004",
                            "name": "retrieve_knowledge",
                            "arguments": {
                                "query": "cancellation policy refund",
                                "top_k": 2,
                            },
                        }
                    ],
                }
            ],
        )

        with trace.use_span(turn2_llm, end_on_exit=True):
            time.sleep(0.52)

        # -----------------------------------------------------------
        # Turn 2: Retrieve cancellation policy
        # -----------------------------------------------------------

        embedding = start_embeddings_span(
            tracer, model="text-embedding-3-small", input_tokens=112, dimensions=1536,
        )
        with trace.use_span(embedding, end_on_exit=True):
            time.sleep(0.06)

        retrieve_cancel = start_retrieval_span(
            tracer,
            data_source_id="faiss-index",
            provider=None,
            model=None,
            query="cancellation policy refund",
            top_k=2,
            retrieved_documents=[
                {
                    "id": "policy-001",
                    "title": "Order Cancellation",
                    "content": (
                        "Orders can be cancelled within 2 hours of "
                        "placement if not yet shipped. Full refund "
                        "issued to original payment method. Processing "
                        "takes 3-5 business days."
                    ),
                },
                {
                    "id": "policy-002",
                    "title": "Refund Policy",
                    "content": (
                        "Refunds are issued within 5 business days "
                        "of cancellation confirmation. Discount codes "
                        "used cannot be re-applied."
                    ),
                },
            ],
        )

        with trace.use_span(retrieve_cancel, end_on_exit=True):
            time.sleep(0.14)

        # -----------------------------------------------------------
        # Turn 2: Final answer with cancellation options
        # -----------------------------------------------------------

        turn2_final = start_inference_span(
            tracer,
            provider="anthropic",
            model="claude-sonnet-4-5",
            operation="chat",
            agent_name=agent_name,
            temperature=0.2,
            max_tokens=512,
            input_tokens=2100,
            output_tokens=168,
            response_id=new_id("msg"),
            response_model="claude-sonnet-4-5",
            finish_reasons=["end_turn"],
            conversation_id=conversation_id,
            server_address="api.anthropic.com",
            server_port=443,
            input_messages=[
                {
                    "role": "user",
                    "parts": [
                        {
                            "type": "text",
                            "content": (
                                "Actually, I need to cancel this order "
                                "instead. Can you help?"
                            ),
                        }
                    ],
                },
                {
                    "role": "assistant",
                    "parts": [
                        {
                            "type": "text",
                            "content": (
                                "I've updated the shipping address for "
                                "order ORD-54321."
                            ),
                        }
                    ],
                },
                {
                    "role": "user",
                    "parts": [
                        {
                            "type": "text",
                            "content": (
                                "Actually, I need to cancel this order "
                                "instead. Can you help?"
                            ),
                        }
                    ],
                },
                {
                    "role": "tool",
                    "parts": [
                        {
                            "type": "tool_result",
                            "tool_call_id": "tool-call-om-004",
                            "content": json.dumps([
                                {
                                    "id": "policy-001",
                                    "title": "Order Cancellation",
                                    "content": (
                                        "Orders can be cancelled within 2 "
                                        "hours of placement if not yet "
                                        "shipped. Full refund issued to "
                                        "original payment method. "
                                        "Processing takes 3-5 business "
                                        "days."
                                    ),
                                },
                                {
                                    "id": "policy-002",
                                    "title": "Refund Policy",
                                    "content": (
                                        "Refunds are issued within 5 "
                                        "business days of cancellation "
                                        "confirmation. Discount codes "
                                        "used cannot be re-applied."
                                    ),
                                },
                            ]),
                        }
                    ],
                },
            ],
            output_messages=[
                {
                    "role": "assistant",
                    "parts": [
                        {
                            "type": "text",
                            "content": (
                                "Your order ORD-54321 is still within the "
                                "cancellation window (placed within the "
                                "last 2 hours and not yet shipped). I can "
                                "proceed with cancellation for a full "
                                "refund of $103.98 to your original "
                                "payment method. The refund will be "
                                "processed within 3-5 business days. "
                                "Note: the WELCOME20 discount code cannot "
                                "be re-applied after cancellation. Would "
                                "you like me to proceed?"
                            ),
                        }
                    ],
                }
            ],
        )

        with trace.use_span(turn2_final, end_on_exit=True):
            time.sleep(0.95)


# ---------------------------------------------------------------------------
# Additional semantic-convention scenarios
# ---------------------------------------------------------------------------

@in_conversation
def inject_memory_workflow(tracer):
    agent_name = "Travel Preference Assistant"
    store_id = new_id("travel-preferences")
    record_id = new_id("preference")

    created = start_agent_operation_span(tracer, "create_agent", agent_name)
    with trace.use_span(created, end_on_exit=True):
        created.set_attribute("gen_ai.agent.id", "travel-preference-assistant-v1")

    workflow = start_agent_operation_span(tracer, "invoke_workflow", "Trip Preparation")
    with trace.use_span(workflow, end_on_exit=True):
        agent = start_agent_span(
            tracer, agent_name, agent_id="travel-preference-assistant-v1", agent_version="1.0.0",
        )
        with trace.use_span(agent, end_on_exit=True):
            operations = [
                ("create_memory_store", {}),
                ("create_memory", {
                    "record_id": record_id, "count": 1,
                    "records": [{"id": record_id, "content": "Window seat preferred"}],
                }),
                ("search_memory", {
                    "count": 1, "query": "seat preference",
                    "records": [{"id": record_id, "content": "Window seat preferred", "score": 0.96}],
                }),
                ("update_memory", {
                    "record_id": record_id, "count": 1,
                    "records": [{"id": record_id, "content": "Aisle seat preferred"}],
                }),
                ("upsert_memory", {
                    "count": 1,
                    "records": [{"id": record_id, "content": "Aisle seat preferred; vegetarian meal"}],
                }),
                ("search_memory", {
                    "count": 1, "query": "meal preference",
                    "records": [{"id": record_id, "content": "Aisle seat preferred; vegetarian meal", "score": 0.93}],
                }),
                ("delete_memory", {"record_id": record_id, "count": 1}),
                ("delete_memory_store", {}),
            ]
            for operation, details in operations:
                memory = start_memory_span(tracer, operation, store_id=store_id, **details)
                with trace.use_span(memory, end_on_exit=True):
                    time.sleep(0.04)


@in_conversation
def inject_legacy_completion(tracer):
    """
    Legacy completions API returning two choices, one finish reason each:

        text_completion gpt-3.5-turbo-instruct
    """

    legacy = start_inference_span(
        tracer, provider="openai", model="gpt-3.5-turbo-instruct",
        operation="text_completion", input_tokens=19, output_tokens=24,
        response_id=new_id("cmpl"), finish_reasons=["stop", "length"],
        extra_attributes={"gen_ai.request.choice.count": 2, "gen_ai.request.top_p": 0.9},
        server_address="api.openai.com", server_port=443,
        input_messages=[{"role": "user", "parts": [{"type": "text", "content": "Suggest a title for a trip briefing."}]}],
        output_messages=[
            {"role": "assistant", "parts": [{"type": "text", "content": "Trip briefing"}]},
            {"role": "assistant", "parts": [{"type": "text", "content": "Travel itinerary"}]},
        ],
    )
    with trace.use_span(legacy, end_on_exit=True):
        time.sleep(0.04)


@in_conversation
def inject_streaming_multimodal_chat(tracer):
    """
    Streamed, multimodal chat with JSON output, prompt template, compacted
    history, reasoning and per-modality / cache token usage:

        invoke_agent Document Briefing Assistant
        |
        +-- chat gpt-4.1-mini
    """

    root = start_agent_span(tracer, "Document Briefing Assistant")
    with trace.use_span(root, end_on_exit=True):
        generated = start_inference_span(
            tracer, provider="openai", model="gpt-4.1-mini",
            operation="chat",
            input_tokens=210, output_tokens=90, response_id=new_id("stream"),
            response_model="gpt-4.1-mini", finish_reasons=["stop"],
            server_address="api.openai.com", server_port=443,
            input_messages=[
                {"role": "user", "parts": [{"type": "text", "content":
                    "Earlier trip discussion (summarized): three days in Paris, vegetarian meals."}]},
                {"role": "user", "parts": [
                    {"type": "text", "content": "Summarize this itinerary as JSON."},
                    {"type": "uri", "modality": "image", "mime_type": "image/png",
                     "uri": "https://example.com/itinerary.png"},
                ]},
            ],
            output_messages=[{"role": "assistant", "parts": [
                {"type": "text", "content": '{"destination":"Paris","days":3}'},
            ]}],
            extra_attributes={
                "gen_ai.output.type": "json",
                "gen_ai.request.stream": True,
                "gen_ai.response.time_to_first_chunk": 0.18,
                "gen_ai.prompt.name": "itinerary-brief",
                "gen_ai.prompt.version": "2.1.0",
                "gen_ai.prompt.variable.destination": "Paris",
                "gen_ai.conversation.compacted": True,
                "gen_ai.request.reasoning.level": "low",
                "gen_ai.usage.reasoning.output_tokens": 12,
                "gen_ai.usage.image.input_tokens": 80,
                "gen_ai.usage.text.input_tokens": 130,
                "gen_ai.usage.text.output_tokens": 78,
                "gen_ai.usage.cache_read.input_tokens": 40,
                "gen_ai.usage.cache_write.input_tokens": 20,
                "gen_ai.request.top_p": 0.9,
                "gen_ai.request.seed": 42,
            },
        )
        with trace.use_span(generated, end_on_exit=True):
            # Must outlast gen_ai.response.time_to_first_chunk.
            time.sleep(0.25)


@in_conversation
def inject_background_response(tracer):
    """
    Background response that is polled until completion. The request and
    the polls are correlated through gen_ai.response.id:

        invoke_agent Document Briefing Assistant
        |
        +-- chat gpt-4.1-mini            (no output yet)
        +-- fetch_response               (queued)
        +-- fetch_response               (in_progress)
        +-- fetch_response               (completed, output + finish reason)
    """

    response_id = new_id("resp")
    root = start_agent_span(tracer, "Document Briefing Assistant")
    with trace.use_span(root, end_on_exit=True):
        background = start_inference_span(
            tracer, provider="openai", model="gpt-4.1-mini", operation="chat",
            response_id=response_id,
            server_address="api.openai.com", server_port=443,
            input_messages=[{"role": "user", "parts": [
                {"type": "text", "content": "Prepare a longer travel summary in the background."},
            ]}],
            extra_attributes={"gen_ai.request.stream": True},
        )
        with trace.use_span(background, end_on_exit=True):
            time.sleep(0.04)

        for status, cursor in (("queued", None), ("in_progress", None), ("completed", "event-42")):
            fetched = start_fetch_response_span(
                tracer, response_id=response_id, status=status, cursor=cursor,
                finish_reasons=["stop"] if status == "completed" else None,
                output_messages=[{"role": "assistant", "parts": [
                    {"type": "text", "content": "Three days in Paris with vegetarian meal options."},
                ]}] if status == "completed" else None,
            )
            with trace.use_span(fetched, end_on_exit=True):
                time.sleep(0.04)


@in_conversation
def inject_failed_chat(tracer):
    """
    Chat request that times out before any response is produced:

        invoke_agent Document Briefing Assistant
        |
        +-- chat gpt-4.1-mini            (ERROR, error.type=timeout)
    """

    root = start_agent_span(tracer, "Document Briefing Assistant")
    with trace.use_span(root, end_on_exit=True):
        failed = start_inference_span(
            tracer, provider="openai", model="gpt-4.1-mini",
            input_messages=[{"role": "user", "parts": [
                {"type": "text", "content": "Revise the briefing."},
            ]}],
            server_address="api.openai.com", server_port=443,
        )
        with trace.use_span(failed, end_on_exit=True):
            failed.set_attribute("error.type", "timeout")
            failed.record_exception(TimeoutError("Response deadline exceeded"))
            failed.set_status(Status(StatusCode.ERROR, "Response deadline exceeded"))


# ---------------------------------------------------------------------------
# Service setup
# ---------------------------------------------------------------------------

def create_tracer(service_name):
    resource = Resource.create(
        {
            "service.name": service_name,
            "service.version": "1.0.0",
            "deployment.environment.name": "development",
        }
    )

    provider = TracerProvider(
        resource=resource,
    )

    exporter = OTLPSpanExporter(
        endpoint=TEMPO_ENDPOINT,
    )

    provider.add_span_processor(
        BatchSpanProcessor(exporter)
    )

    tracer = provider.get_tracer(
        "otel-genai-trace-injector",
    )

    return provider, tracer


def main():
    print("Injecting GenAI semantic-convention traces into Tempo...")
    for service_name, scenario in SCENARIOS:
        provider, tracer = create_tracer(service_name)
        try:
            scenario(tracer)
            provider.force_flush()
        finally:
            provider.shutdown()
        print(f"Injected: {service_name} / {scenario.__name__}")

    print("Done.")


SCENARIOS = (
    ("chatbot-api", inject_customer_support_agent),
    ("recommendation-service", inject_recommendation_agent),
    ("rag-support-service", inject_rag_support_agent),
    ("order-management-service", inject_multi_tool_agent),
    ("travel-preferences-service", inject_memory_workflow),
    ("title-suggestion-service", inject_legacy_completion),
    ("document-briefing-service", inject_streaming_multimodal_chat),
    ("document-briefing-service", inject_background_response),
    ("document-briefing-service", inject_failed_chat),
)


if __name__ == "__main__":
    main()
