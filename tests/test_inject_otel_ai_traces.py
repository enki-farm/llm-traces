"""Offline checks for the scenarios exported by the Tempo trace injector."""

import json
import re
import unittest
from pathlib import Path
from unittest.mock import patch

from opentelemetry.trace import SpanKind, StatusCode
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from scripts import inject_otel_ai_traces as injector


class InjectorScenariosTest(unittest.TestCase):
    def setUp(self):
        self.exporter = InMemorySpanExporter()
        self.provider = TracerProvider()
        self.provider.add_span_processor(SimpleSpanProcessor(self.exporter))
        self.tracer = self.provider.get_tracer("injector-test")
        self.sleep = patch.object(injector.time, "sleep", return_value=None)
        self.sleep.start()
        self.addCleanup(self.sleep.stop)
        self.addCleanup(self.provider.shutdown)

    def spans(self):
        for _, scenario in injector.SCENARIOS:
            scenario(self.tracer)
        return self.exporter.get_finished_spans()

    def test_all_documented_operations_are_registered(self):
        doc = (Path(__file__).resolve().parents[1] / "docs/otel_genai_semantic_convention_spans.md").read_text()
        table = doc.split("`gen_ai.operation.name` has the following list of well-known values.", 1)[1]
        table = table.split("`gen_ai.output.type` has the following list", 1)[0]
        documented = set(re.findall(r"^\| `([a-z_]+)` \|", table, re.MULTILINE))
        operations = {
            span.attributes["gen_ai.operation.name"]
            for span in self.spans()
            if "gen_ai.operation.name" in span.attributes
        }
        self.assertEqual(len(documented), 18)
        self.assertEqual(operations, documented)

    def test_family_attributes_and_hierarchy(self):
        spans = self.spans()
        by_id = {span.context.span_id: span for span in spans}
        self.assertEqual(len(injector.SCENARIOS), 9)
        for span in spans:
            attributes = span.attributes
            operation = attributes.get("gen_ai.operation.name")
            if operation is None:
                continue
            self.assertTrue(span.name.startswith(operation))
            if operation in {"chat", "generate_content", "text_completion", "embeddings", "fetch_response", "retrieval"}:
                self.assertEqual(span.kind, SpanKind.CLIENT)
            if operation in {"invoke_agent", "invoke_workflow", "create_agent", "plan", "execute_tool"}:
                self.assertEqual(span.kind, SpanKind.INTERNAL)
            if operation in {"chat", "generate_content", "text_completion", "embeddings", "fetch_response"}:
                self.assertIn("gen_ai.provider.name", attributes)
            if operation in {"chat", "generate_content", "text_completion", "embeddings"}:
                self.assertIn("gen_ai.request.model", attributes)
            if operation == "embeddings":
                self.assertGreater(attributes["gen_ai.embeddings.dimension.count"], 0)
                self.assertGreater(attributes["gen_ai.usage.input_tokens"], 0)
            if operation == "retrieval":
                self.assertIn("gen_ai.data_source.id", attributes)
                self.assertNotIn("gen_ai.usage.input_tokens", attributes)
            if operation == "fetch_response":
                self.assertIn("gen_ai.response.id", attributes)
                self.assertNotIn("gen_ai.usage.input_tokens", attributes)
                self.assertNotIn("gen_ai.usage.output_tokens", attributes)
            if operation in {"create_memory", "search_memory", "update_memory", "upsert_memory",
                             "delete_memory", "create_memory_store", "delete_memory_store"}:
                self.assertEqual(span.kind, SpanKind.CLIENT)
                self.assertIn("gen_ai.memory.store.id", attributes)
                self.assertEqual(by_id[span.parent.span_id].attributes["gen_ai.operation.name"], "invoke_agent")
            if "server.address" in attributes:
                self.assertIsInstance(attributes["server.port"], int)
            for key in ("gen_ai.input.messages", "gen_ai.output.messages", "gen_ai.memory.records", "gen_ai.retrieval.documents"):
                if key in attributes:
                    self.assertIsInstance(json.loads(attributes[key]), list)

    def test_conversation_id_correlates_scenario_spans(self):
        conversation_ids = []
        for _, scenario in injector.SCENARIOS:
            self.exporter.clear()
            scenario(self.tracer)
            spans = [span for span in self.exporter.get_finished_spans()
                     if "gen_ai.operation.name" in span.attributes]
            ids = {span.attributes.get("gen_ai.conversation.id") for span in spans}
            self.assertEqual(len(ids), 1, scenario.__name__)
            self.assertIsNotNone(next(iter(ids)), scenario.__name__)
            conversation_ids.append(next(iter(ids)))
            traces = {span.context.trace_id for span in spans}
            if scenario.__name__ in {"inject_rag_support_agent", "inject_multi_tool_agent",
                                     "inject_memory_workflow"}:
                self.assertEqual(len(traces), 2, scenario.__name__)
            else:
                self.assertEqual(len(traces), 1, scenario.__name__)
        self.assertEqual(len(set(conversation_ids)), len(injector.SCENARIOS))
        self.assertIsNone(injector.current_conversation_id())

    def test_response_memory_and_failure_cases(self):
        spans = self.spans()
        fetches = [span for span in spans if span.attributes.get("gen_ai.operation.name") == "fetch_response"]
        self.assertEqual([span.attributes["gen_ai.response.status"] for span in fetches],
                         ["queued", "in_progress", "completed"])
        self.assertEqual(len({span.attributes["gen_ai.response.id"] for span in fetches}), 1)
        self.assertNotIn("gen_ai.request.stream_cursor", fetches[0].attributes)
        self.assertIn("gen_ai.request.stream_cursor", fetches[-1].attributes)
        self.assertNotIn("gen_ai.output.messages", fetches[0].attributes)
        self.assertIn("gen_ai.output.messages", fetches[-1].attributes)

        memory = [span for span in spans if "gen_ai.memory.store.id" in span.attributes]
        self.assertEqual(len({span.attributes["gen_ai.memory.store.id"] for span in memory}), 1)
        self.assertEqual([span.attributes["gen_ai.operation.name"] for span in memory], [
            "create_memory_store", "create_memory", "search_memory", "update_memory",
            "upsert_memory", "search_memory", "delete_memory", "delete_memory_store",
        ])
        record_ids = {span.attributes["gen_ai.memory.record.id"] for span in memory
                      if "gen_ai.memory.record.id" in span.attributes}
        self.assertEqual(len(record_ids), 1)

        streamed = [span for span in spans if "gen_ai.response.time_to_first_chunk" in span.attributes]
        self.assertEqual(len(streamed), 1)
        attributes = streamed[0].attributes
        self.assertTrue(attributes["gen_ai.request.stream"])
        self.assertGreater(attributes["gen_ai.response.time_to_first_chunk"], 0)
        self.assertEqual(attributes["gen_ai.usage.image.input_tokens"] +
                         attributes["gen_ai.usage.text.input_tokens"], attributes["gen_ai.usage.input_tokens"])
        self.assertEqual(attributes["gen_ai.usage.text.output_tokens"] +
                 attributes["gen_ai.usage.reasoning.output_tokens"], attributes["gen_ai.usage.output_tokens"])
        self.assertEqual(attributes["gen_ai.prompt.version"], "2.1.0")
        self.assertTrue(attributes["gen_ai.conversation.compacted"])
        messages = json.loads(attributes["gen_ai.input.messages"])
        self.assertEqual(messages[-1]["parts"][-1]["modality"], "image")
        self.assertEqual(messages[-1]["parts"][-1]["type"], "uri")
        self.assertNotEqual(attributes["gen_ai.response.id"], fetches[0].attributes["gen_ai.response.id"])
        background = [span for span in spans if span.attributes.get("gen_ai.response.id") ==
                  fetches[0].attributes["gen_ai.response.id"] and
                  span.attributes.get("gen_ai.operation.name") == "chat"]
        self.assertEqual(len(background), 1)
        self.assertTrue(background[0].attributes["gen_ai.request.stream"])
        self.assertNotIn("gen_ai.output.messages", background[0].attributes)

        choices = [span for span in spans if span.attributes.get("gen_ai.request.choice.count") == 2]
        self.assertEqual(len(choices), 1)
        self.assertEqual(len(choices[0].attributes["gen_ai.response.finish_reasons"]), 2)
        self.assertEqual(len(json.loads(choices[0].attributes["gen_ai.output.messages"])), 2)
        tool_users = [span for span in spans if "gen_ai.tool.definitions" in span.attributes]
        self.assertEqual(len(tool_users), 1)
        self.assertEqual(json.loads(tool_users[0].attributes["gen_ai.tool.definitions"])[0]["name"], "get_product")
        self.assertEqual(tool_users[0].attributes["gen_ai.request.top_k"], 40)
        local_retrievals = [span for span in spans if span.attributes.get("gen_ai.data_source.id") == "faiss-index"]
        self.assertTrue(local_retrievals)
        for span in local_retrievals:
            self.assertNotIn("gen_ai.provider.name", span.attributes)
            self.assertNotIn("gen_ai.request.model", span.attributes)

        errors = [span for span in spans if span.status.status_code == StatusCode.ERROR]
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0].attributes["error.type"], "timeout")
        self.assertNotIn("gen_ai.output.messages", errors[0].attributes)
        self.assertTrue(errors[0].events)


if __name__ == "__main__":
    unittest.main()