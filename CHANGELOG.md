# Changelog

## 0.0.1 - 2026-10-07

Initial release of the enki-maintained fork of Agoda's LLM Traces. Changes
from the forked base:

- Require Grafana 13 or newer and update Grafana, React, and build dependencies.
- Update span detection and parsing for current OpenTelemetry GenAI semantic
	conventions, including fixes to provider handling.
- Remove legacy OpenInference and Vertex AI span detection and parsing.
- Improve readability of retrieval results in span details.
- Expand synthetic trace generation to cover all 18 well-known GenAI operations
	and representative prompt, cache, multimodal, streaming, polling, and error
	attributes, with coverage and consistency tests.
- Update plugin identity, author metadata, repository links, and fork attribution
	while retaining the Apache-2.0 license and original project acknowledgements.
- Adopt Grafana's plugin build tooling, avoid bundling React, and generate a
	validator-ready installation ZIP with corrected plugin metadata.
- Remove the nonexistent external Tempo plugin dependency to prevent installation
	failures; use Grafana's built-in Tempo datasource.
- Fix end-to-end tests and CI Grafana images, add Playwright support to the
	development container, and document development and testing workflows.
- Document AI-assisted development and maintainer responsibility.
