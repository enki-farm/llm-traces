"""
Injects realistic OpenTelemetry AI semantic traces into local Tempo for development.
"""
import time
import json
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.trace import SpanKind

TEMPO_ENDPOINT = "http://localhost:4318/v1/traces"

SERVICES = [
    {
        "name": "chatbot-api",
        "traces": [
            {
                "root": "customer_query_chain",
                "spans": [
                    {
                        "name": "llm claude-sonnet-4-5",
                        "attrs": {
                            "gen_ai.system": "anthropic",
                            "gen_ai.request.model": "claude-sonnet-4-5",
                            "gen_ai.request.temperature": 0.3,
                            "gen_ai.request.max_tokens": 1024,
                            "gen_ai.usage.input_tokens": 312,
                            "gen_ai.usage.output_tokens": 48,
                            "gen_ai.usage.total_tokens": 360,
                            "gen_ai.message.0.role": "system",
                            "gen_ai.message.0.content": "You are a helpful customer support assistant.",
                            "gen_ai.message.1.role": "user",
                            "gen_ai.message.1.content": "What features does product 12345 have?",
                            "gen_ai.message.2.role": "assistant",
                            "gen_ai.message.2.content": "Product 12345 includes real-time analytics, custom dashboards, and API access.",
                        },
                        "duration_ms": 920,
                    }
                ],
            }
        ],
    },
    {
        "name": "summarizer-api",
        "traces": [
            {
                "root": "generate_summary",
                "spans": [
                    {
                        "name": "llm gpt-4o-mini",
                        "attrs": {
                            "gen_ai.system": "openai",
                            "gen_ai.request.model": "gpt-4o-mini",
                            "gen_ai.request.temperature": 0.7,
                            "gen_ai.request.max_tokens": 500,
                            "gen_ai.usage.input_tokens": 145,
                            "gen_ai.usage.output_tokens": 62,
                            "gen_ai.usage.total_tokens": 207,
                            "gen_ai.message.0.role": "system",
                            "gen_ai.message.0.content": "You write concise performance summaries.",
                            "gen_ai.message.1.role": "user",
                            "gen_ai.message.1.content": "Summarize the Q1 2026 metrics for dashboard 99999.",
                            "gen_ai.message.2.role": "assistant",
                            "gen_ai.message.2.content": "Q1 2026 highlights: response time down 12%, throughput up 15%. Strong performance across all regions.",
                        },
                        "duration_ms": 1820,
                    }
                ],
            }
        ],
    },
    {
        "name": "recommendation-service",
        "traces": [
            {
                "root": "personalize_recommendations",
                "spans": [
                    {
                        "name": "llm gemini-2.5-flash",
                        "attrs": {
                            "gen_ai.system": "google",
                            "gen_ai.request.model": "gemini-2.5-flash",
                            "gen_ai.request.temperature": 0.5,
                            "gen_ai.request.max_tokens": 256,
                            "gen_ai.usage.input_tokens": 520,
                            "gen_ai.usage.output_tokens": 85,
                            "gen_ai.usage.total_tokens": 605,
                            "gen_ai.message.0.role": "system",
                            "gen_ai.message.0.content": "You are a product recommendation engine. Provide personalized suggestions based on user preferences.",
                            "gen_ai.message.1.role": "user",
                            "gen_ai.message.1.content": "Recommend 3 products for a user interested in smart home devices, budget under $200.",
                            "gen_ai.message.2.role": "assistant",
                            "gen_ai.message.2.content": "1. Smart LED Bulb Starter Kit ($49) - 4-pack with color changing. 2. WiFi Smart Plug Mini ($29) - 6-pack energy monitoring. 3. Smart Door Sensor Bundle ($35) - 8 sensors with hub.",
                        },
                        "duration_ms": 1150,
                    }
                ],
            }
        ],
    },
]


def inject_service(service: dict):
    resource = Resource.create({"service.name": service["name"]})
    provider = TracerProvider(resource=resource)
    exporter = OTLPSpanExporter(endpoint=TEMPO_ENDPOINT)
    provider.add_span_processor(BatchSpanProcessor(exporter))
    tracer = provider.get_tracer("otel-ai-trace-injector")

    for trace_def in service["traces"]:
        with tracer.start_as_current_span(trace_def["root"], kind=SpanKind.CLIENT) as root_span:
            root_span.set_attribute("openinference.span.kind", "CHAIN")
            for span_def in trace_def["spans"]:
                time.sleep(0.01)
                with tracer.start_as_current_span(span_def["name"], kind=SpanKind.CLIENT) as span:
                    for k, v in span_def["attrs"].items():
                        span.set_attribute(k, v)
                    time.sleep(span_def["duration_ms"] / 1000)

    provider.force_flush()
    provider.shutdown()
    print(f"Injected traces for {service['name']}")


if __name__ == "__main__":
    print("Injecting OTEL AI semantic traces into Tempo...")
    for svc in SERVICES:
        inject_service(svc)
    print("Done.")
