import { ReactNode, useEffect, useRef, useMemo, useState } from 'react';

import { useStyles2, Icon } from '@grafana/ui';
import { getStyles } from './LlmSpanDetail.styles';
import { KeyValuePair, SpanLog, LlmMessage, LlmSpanData, LlmTokenUsage, LlmInvocationParams, extractLlmSpanData, getSpanKindColor, getSpanKind, decodeUnicodeEscapes } from '../utils/llmUtils';
import { estimateCost, formatCost } from '../utils/costUtils';

// gpt-tokenizer uses cl100k_base (GPT-4 / GPT-3.5 encoding) for token counting
let countTokens: ((text: string) => number) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const tok = require('gpt-tokenizer');
  const enc = tok.encodingForModel?.('gpt-4') ?? tok;
  countTokens = (text: string) => enc.encode(text).length;
} catch {
  countTokens = null;
}

// marked is available as a transitive dep in the Grafana monorepo
let markedParse: ((src: string) => string) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const m = require('marked');
  markedParse = m.marked?.parse ?? m.parse ?? null;
} catch {
  markedParse = null;
}

/**
 * Decode HTML entities (numeric and named) so that entity-encoded tags like
 * &#60;script&#62; are converted to < > before sanitization. This prevents
 * XSS payloads from bypassing the allowlist via HTML entity encoding (BUG-070).
 */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Sanitize HTML using an allowlist approach. DOMPurify is not available as a
 * direct dependency, so we strip all tags/attributes not on the safe list.
 * Only permits safe inline/block formatting tags. href attributes on <a> tags
 * are allowed only for http://, https://, and mailto: protocols (BUG-021).
 */
function sanitizeHtml(html: string): string {
  const ALLOWED = /^(b|i|em|strong|p|br|ul|ol|li|code|pre|h[1-6]|blockquote|hr|a|table|thead|tbody|tr|th|td)$/i;
  return html
    .replace(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s[^>]*)?)?>/g, (_match, slash, tag, attrs) => {
      if (!ALLOWED.test(tag)) { return ''; }
      const lowerTag = tag.toLowerCase();
      // For <a> tags allow href only with safe protocols
      if (lowerTag === 'a' && !slash && attrs) {
        const hrefMatch = attrs.match(/\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/i);
        if (hrefMatch) {
          const href = hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? '';
          const safeHref = /^(https?:|mailto:)/i.test(href) ? href : '#';
          return `<a href="${safeHref}">`;
        }
      }
      return `<${slash}${lowerTag}>`;
    })
    .replace(/javascript\s*:/gi, '')
    .replace(/data\s*:/gi, '');
}


function getRoleStyle(role: string, styles: ReturnType<typeof getStyles>): string {
  const r = role.toLowerCase();
  if (r === 'system') { return styles.roleSystem; }
  if (r === 'user' || r === 'human') { return styles.roleUser; }
  if (r === 'assistant' || r === 'ai' || r === 'model') { return styles.roleAssistant; }
  if (r === 'tool' || r === 'function') { return styles.roleTool; }
  return styles.roleUser;
}

function getRoleIcon(role: string): 'user' | 'comment-alt' | 'cog' | 'code-branch' {
  const r = role.toLowerCase();
  if (r === 'user' || r === 'human') { return 'user'; }
  if (r === 'assistant' || r === 'ai' || r === 'model') { return 'comment-alt'; }
  if (r === 'system') { return 'cog'; }
  return 'code-branch';
}

function getConventionLabel(convention: string): string {
  switch (convention) {
    case 'otel-genai': return 'OTel GenAI';
    case 'generic': return 'Generic';
    default: return convention;
  }
}

function FinishReasonBadge({ reason }: { reason: string }) {
  const styles = useStyles2(getStyles);
  const r = reason.toUpperCase();
  const isWarning = r === 'MAX_TOKENS' || r === 'LENGTH' || r === 'CONTENT_FILTER';
  const isError = r === 'ERROR';
  const color = isWarning ? '#FF9830' : isError ? '#F2495C' : '#73BF69';
  return (
    <span
      className={styles.kindBadge}
      style={{ background: color }}
      title={isWarning ? 'Response was cut off due to max token limit' : undefined}
    >
      {isWarning && '⚠ '}{r}
    </span>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timerRef.current) { clearTimeout(timerRef.current); } }, []);
  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      onClick={handleCopy}
      title={`Copy ${label}`}
      style={{
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        padding: '0 4px',
        color: 'inherit',
        opacity: 0.6,
        fontSize: '11px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '3px',
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} size="sm" />
      {copied ? 'Copied!' : ''}
    </button>
  );
}

function MessageBlock({ message, defaultOpen = true }: { message: LlmMessage; defaultOpen?: boolean }) {
  const styles = useStyles2(getStyles);
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [showMarkdown, setShowMarkdown] = useState(false);
  const roleStyle = getRoleStyle(message.role, styles);
  const icon = getRoleIcon(message.role);
  const canMarkdown = markedParse !== null && !!message.content;

  return (
    <div className={styles.message} data-testid={`message-block-${message.role}`}>
      <button
        className={`${styles.messageHeader} ${roleStyle}`}
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
      >
        <div className={styles.messageHeaderLeft}>
          <Icon name={isOpen ? 'angle-down' : 'angle-right'} size="xs" />
          <Icon name={icon} size="sm" />
          <span className={styles.roleLabel}>{
            message.role === 'model' || message.role === 'ai' ? 'assistant' :
            message.role === 'human' ? 'user' :
            message.role
          }</span>
        </div>
        {canMarkdown && isOpen && (
          <button
            className={`${styles.mdToggle} ${showMarkdown ? styles.mdToggleActive : ''}`}
            onClick={(e) => { e.stopPropagation(); setShowMarkdown((v) => !v); }}
            title={showMarkdown ? 'Show raw text' : 'Render Markdown'}
          >
            MD
          </button>
        )}
      </button>
      {isOpen && (
        <>
          {showMarkdown && canMarkdown ? (
            <div
              className={`${styles.markdownContent} ${roleStyle}`}
              dangerouslySetInnerHTML={{ __html: sanitizeHtml(decodeHtmlEntities(markedParse!(message.content))) }}
            />
          ) : (
            <div className={`${styles.messageContent} ${roleStyle}`}>
              {message.content != null && message.content !== '' ? message.content : <span className={styles.emptyContent}>(empty)</span>}
              {message.content && (
                <div style={{ fontSize: '10px', color: 'inherit', opacity: 0.45, marginTop: '4px', textAlign: 'right' }}>
                  {message.content.split(/\s+/).filter(Boolean).length} words · {message.content.length} chars
                  {countTokens && ` · ~${countTokens(message.content).toLocaleString()} tokens`}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TokenUsageDisplay({ usage, model, precomputedCostUsd }: { usage: LlmTokenUsage; model: string; precomputedCostUsd?: number }) {
  const styles = useStyles2(getStyles);
  const hasAny = usage.input !== undefined || usage.output !== undefined || usage.total !== undefined;
  if (!hasAny) { return null; }
  return (
    <div className={styles.tokenRow}>
      {usage.input !== undefined && (
        <div className={styles.tokenItem}>
          <span className={styles.tokenLabel}>Input:</span>
          <span className={styles.tokenValue}>{usage.input.toLocaleString()}</span>
        </div>
      )}
      {usage.output !== undefined && (
        <div className={styles.tokenItem}>
          <span className={styles.tokenLabel}>Output:</span>
          <span className={styles.tokenValue}>{usage.output.toLocaleString()}</span>
        </div>
      )}
      {usage.total !== undefined && (
        <div className={styles.tokenItem}>
          <span className={styles.tokenLabel}>Total:</span>
          <span className={styles.tokenValue}>{usage.total.toLocaleString()}</span>
        </div>
      )}
      {(() => {
        if (precomputedCostUsd !== undefined) {
          return (
            <div className={styles.tokenItem}>
              <span className={styles.tokenLabel}>Reported Cost:</span>
              <span className={styles.tokenValue}>{formatCost(precomputedCostUsd)}</span>
            </div>
          );
        }
        const cost = estimateCost(model, usage.input, usage.output);
        return (
          <div className={styles.tokenItem}>
            <span className={styles.tokenLabel}>Est. Cost:</span>
            <span className={styles.tokenValue}>
              {cost !== undefined
                ? formatCost(cost)
                : <span style={{ opacity: 0.5, fontStyle: 'italic' }}>unknown</span>
              }
            </span>
          </div>
        );
      })()}
    </div>
  );
}

function InvocationParamsDisplay({ params }: { params: LlmInvocationParams }) {
  const styles = useStyles2(getStyles);
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
  if (entries.length === 0) { return null; }
  return (
    <div className={styles.paramsGrid}>
      {entries.map(([key, value]) => (
        <div key={key} className={styles.paramItem}>
          <span className={styles.paramKey}>{key}:</span>
          <span className={styles.paramValue}>{typeof value === 'object' ? JSON.stringify(value) : String(value)}</span>
        </div>
      ))}
    </div>
  );
}

function CollapsibleSection({ title, defaultOpen = true, children, testId, titleExtra }: { title: string; defaultOpen?: boolean; children: ReactNode; testId?: string; titleExtra?: ReactNode }) {
  const styles = useStyles2(getStyles);
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <div className={styles.section} data-testid={testId}>
      <button
        className={styles.sectionHeader}
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
      >
        <Icon name={isOpen ? 'angle-down' : 'angle-right'} size="sm" />
        <span className={styles.sectionTitle}>{title}</span>
        {titleExtra && <span style={{ marginLeft: 'auto' }} onClick={(e) => e.stopPropagation()}>{titleExtra}</span>}
      </button>
      {isOpen && <div className={styles.sectionContent}>{children}</div>}
    </div>
  );
}

function formatValue(value: string): string {
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}

function ValueBlock({ label, value }: { label: string; value: string }) {
  const styles = useStyles2(getStyles);
  if (value === undefined || value === null) { return null; }
  return (
    <div className={styles.fieldBlock}>
      <div className={styles.fieldLabel}>{label}</div>
      <div className={styles.valueBlock}>{value === '' ? <span className={styles.emptyContent}>(empty)</span> : formatValue(value)}</div>
    </div>
  );
}

interface RetrievalDocument {
  index: number;
  id?: string;
  score?: string;
  content?: string;
  metadata?: string;
}

function extractRetrievalDocuments(tags: KeyValuePair[]): RetrievalDocument[] {
  const docs = new Map<number, RetrievalDocument>();
  for (const tag of tags) {
    const match = tag.key.match(/^retrieval\.documents\.(\d+)\.(.+)$/);
    if (!match) { continue; }
    const idx = parseInt(match[1], 10);
    const field = match[2];
    if (!docs.has(idx)) { docs.set(idx, { index: idx }); }
    const doc = docs.get(idx)!;
    if (field === 'document.id') { doc.id = String(tag.value); }
    else if (field === 'document.score') { doc.score = String(tag.value); }
    else if (field === 'document.content') { doc.content = String(tag.value); }
    else if (field === 'document.metadata') { doc.metadata = String(tag.value); }
  }
  return Array.from(docs.values()).sort((a, b) => a.index - b.index);
}

function getAttrValue(tags: KeyValuePair[], key: string): string | undefined {
  const tag = tags.find((t) => t.key === key);
  return tag !== undefined ? decodeUnicodeEscapes(String(tag.value)) : undefined;
}

function GenAiSpanDetail({ tags, spanKind }: { tags: KeyValuePair[]; spanKind: string }) {
  const styles = useStyles2(getStyles);
  const kind = spanKind.toUpperCase();
  const kindColor = getSpanKindColor(spanKind);

  // OTel GenAI attributes for TOOL spans
  const toolName = getAttrValue(tags, 'gen_ai.tool.name');
  const toolDesc = getAttrValue(tags, 'gen_ai.tool.description');
  const toolCallArgs = getAttrValue(tags, 'gen_ai.tool.call.arguments');
  const toolCallResult = getAttrValue(tags, 'gen_ai.tool.call.result');

  // OTel GenAI attributes for RETRIEVER spans
  const retrievalQuery = getAttrValue(tags, 'gen_ai.retrieval.query.text');
  const retrievalDocs = kind === 'RETRIEVER' ? extractRetrievalDocuments(tags) : [];
  const retrievalDocuments = getAttrValue(tags, 'gen_ai.retrieval.documents');
  const retrievalTopK = getAttrValue(tags, 'gen_ai.retrieval.top_k');
  // Keep reading the legacy field so previously emitted traces remain useful.
  const embeddingTokens = getAttrValue(tags, 'gen_ai.usage.input_tokens') || getAttrValue(tags, 'gen_ai.usage.embedding_tokens');
  const dataSourceId = getAttrValue(tags, 'gen_ai.data_source.id');
  const retrievalModel = getAttrValue(tags, 'gen_ai.request.model');

  // OTel GenAI attributes for RERANKER spans (custom attributes, not in OTel spec yet)
  const rerankerQuery = getAttrValue(tags, 'gen_ai.reranker.query');
  const rerankerModel = getAttrValue(tags, 'gen_ai.reranker.model');
  const rerankerResults = (() => {
    const results: Array<{ index: number; document?: string; score?: string; relevanceScore?: string }> = [];
    const map = new Map<number, (typeof results)[0]>();
    for (const tag of tags) {
      const m = tag.key.match(/^gen_ai\.reranker\.results\.(\d+)\.(.+)$/);
      if (!m) { continue; }
      const idx = parseInt(m[1], 10);
      if (!map.has(idx)) { map.set(idx, { index: idx }); }
      const entry = map.get(idx)!;
      const field = m[2];
      if (field === 'document.content' || field === 'document.text') { entry.document = String(tag.value); }
      else if (field === 'score') { entry.score = String(tag.value); }
      else if (field === 'relevance_score') { entry.relevanceScore = String(tag.value); }
    }
    map.forEach((v) => results.push(v));
    return results.sort((a, b) => a.index - b.index);
  })();

  // Generic input/output for CHAIN, AGENT, EMBEDDING, UNKNOWN spans
  const inputValue = getAttrValue(tags, 'gen_ai.input.messages') || getAttrValue(tags, 'input.value');
  const outputValue = getAttrValue(tags, 'gen_ai.output.messages') || getAttrValue(tags, 'output.value');
  const retrievalInput = retrievalQuery ? JSON.stringify({ query: retrievalQuery }) : inputValue;
  const retrievalOutput = retrievalDocuments || (retrievalDocs.length > 0 ? JSON.stringify(retrievalDocs) : outputValue);

  return (
    <div className={styles.container} data-testid="genai-span-detail">
      <div className={styles.headerRow}>
        {kind === 'RETRIEVER' && retrievalModel && (
          <div className={styles.modelBadge}>
            <Icon name="ai-sparkle" className={styles.modelIcon} />
            <span data-testid="retriever-model-name">{retrievalModel}</span>
          </div>
        )}
        <span className={styles.kindBadge} style={{ background: kindColor }} data-testid="genai-span-kind">
          {kind}
        </span>
        <span className={styles.conventionBadge}>OTel GenAI</span>
      </div>

      {kind === 'TOOL' && (toolName || toolDesc || toolCallArgs || toolCallResult) && (
        <div data-testid="tool-section">
          {/* Tool metadata row */}
          {(toolName || toolDesc) && (
            <div className={styles.toolMetaRow}>
              {toolName && (
                <div className={styles.toolMetaItem}>
                  <span className={styles.toolMetaKey}>Tool:</span>
                  <span className={styles.toolMetaValue}>{toolName}</span>
                </div>
              )}
              {toolDesc && (
                <div className={styles.toolMetaItem}>
                  <span className={styles.toolMetaKey}>Description:</span>
                  <span className={styles.toolMetaValue}>{toolDesc}</span>
                </div>
              )}
            </div>
          )}
          {/* Input card — call arguments */}
          {toolCallArgs && (
            <CollapsibleSection
              title="Input"
              testId="tool-input-section"
              titleExtra={
                <CopyButton
                  text={toolCallArgs}
                  label="input"
                />
              }
            >
              <div className={styles.toolCardBlock}>
                {formatValue(toolCallArgs)}
              </div>
            </CollapsibleSection>
          )}
          {/* Output card — call result */}
          {toolCallResult && (
            <CollapsibleSection
              title="Output"
              testId="tool-output-section"
              titleExtra={
                <CopyButton
                  text={toolCallResult}
                  label="output"
                />
              }
            >
              <div className={styles.toolCardBlock}>
                {formatValue(toolCallResult)}
              </div>
            </CollapsibleSection>
          )}
        </div>
      )}

      {kind === 'RERANKER' && (rerankerQuery || rerankerModel || rerankerResults.length > 0 || inputValue || outputValue) && (
        <CollapsibleSection title="Reranker" testId="reranker-section">
          {rerankerModel && <ValueBlock label="Model" value={rerankerModel} />}
          {rerankerQuery && <ValueBlock label="Query" value={rerankerQuery} />}
          {inputValue && <ValueBlock label="Input" value={inputValue} />}
          {outputValue && <ValueBlock label="Output" value={outputValue} />}
          {rerankerResults.length > 0 && (
            <div className={styles.fieldBlock}>
              <div className={styles.fieldLabel}>Results ({rerankerResults.length})</div>
              {rerankerResults.map((r) => (
                <div key={r.index} className={styles.documentBlock}>
                  <div className={styles.documentMeta}>
                    #{r.index}{(r.score !== undefined || r.relevanceScore !== undefined) ? ` · score: ${r.score ?? r.relevanceScore}` : ''}
                  </div>
                  {r.document && <div className={styles.valueBlock}>{r.document}</div>}
                </div>
              ))}
            </div>
          )}
        </CollapsibleSection>
      )}

      {kind === 'RETRIEVER' && (retrievalInput || retrievalOutput || dataSourceId || retrievalTopK || embeddingTokens) && (
        <div className={styles.sectionStack} data-testid="retriever-section">
          {/* Retrieval metadata row */}
          {dataSourceId && (
            <div className={styles.toolMetaRow} data-testid="retriever-meta-row">
              <div className={styles.toolMetaItem}>
                <span className={styles.toolMetaKey}>Data Source:</span>
                <span className={styles.toolMetaValue}>{dataSourceId}</span>
              </div>
            </div>
          )}
          {(retrievalTopK || embeddingTokens) && (
            <CollapsibleSection title="Parameters & Token Usage" testId="retriever-params-section">
              {embeddingTokens && (
                <div className={styles.tokenRow}>
                  <div className={styles.tokenItem}>
                    <span className={styles.tokenLabel}>Embedding Tokens:</span>
                    <span className={styles.tokenValue}>{Number(embeddingTokens).toLocaleString()}</span>
                  </div>
                </div>
              )}
              {retrievalTopK && <InvocationParamsDisplay params={{ top_k: retrievalTopK }} />}
            </CollapsibleSection>
          )}
          {/* Input card — retrieval query */}
          {retrievalInput && (
            <CollapsibleSection
              title="Input"
              testId="retriever-input-section"
              titleExtra={
                <CopyButton
                  text={formatValue(retrievalInput)}
                  label="input"
                />
              }
            >
              <div className={styles.toolCardBlock}>
                {formatValue(retrievalInput)}
              </div>
            </CollapsibleSection>
          )}
          {/* Output card — retrieved documents */}
          {retrievalOutput && (
            <CollapsibleSection
              title="Output"
              testId="retriever-output-section"
              titleExtra={
                <CopyButton text={formatValue(retrievalOutput)} label="output" />
              }
            >
              <div className={styles.toolCardBlock}>
                {formatValue(retrievalOutput)}
              </div>
            </CollapsibleSection>
          )}
        </div>
      )}

      {(kind === 'CHAIN' || kind === 'AGENT' || kind === 'EMBEDDING' || kind === 'UNKNOWN') && (inputValue || outputValue) && (
        <CollapsibleSection title={kind === 'EMBEDDING' ? 'Embedding' : 'Input / Output'} testId="io-section">
          {inputValue && <ValueBlock label="Input" value={inputValue} />}
          {outputValue && <ValueBlock label="Output" value={outputValue} />}
        </CollapsibleSection>
      )}
    </div>
  );
}

interface LlmSpanDetailProps {
  tags: KeyValuePair[];
  logs: SpanLog[];
  operationName: string;
}

export function LlmSpanDetail({ tags, logs, operationName }: LlmSpanDetailProps) {
  const styles = useStyles2(getStyles);
  const llmData: LlmSpanData = useMemo(() => extractLlmSpanData(tags, logs, operationName), [tags, logs, operationName]);

  if (!llmData.isLlm) {
    // For non-LLM OTel GenAI spans (CHAIN, TOOL, RETRIEVER, AGENT, RERANKER, UNKNOWN),
    // show a structured detail panel with their relevant attributes.
    // EMBEDDING spans are routed through the LLM detail path so model/token/cost data is shown (BUG-022).
    if (llmData.convention === 'otel-genai' && llmData.spanKind && llmData.spanKind.toUpperCase() !== 'EMBEDDING') {
      return <GenAiSpanDetail tags={tags} spanKind={llmData.spanKind} />;
    }
    if (llmData.convention !== 'otel-genai' || (llmData.spanKind && llmData.spanKind.toUpperCase() !== 'EMBEDDING')) {
      return null;
    }
  }

  const hasTokenUsage = llmData.tokenUsage.input !== undefined || llmData.tokenUsage.output !== undefined || llmData.tokenUsage.total !== undefined;
  const hasParams = Object.values(llmData.invocationParams).some((v) => v !== undefined && v !== null);
  // For Vertex/OTel spans, spanKind isn't set by extraction — fall back to getSpanKind(tags)
  const spanKindLabel = llmData.spanKind ?? getSpanKind(tags);
  const kindColor = getSpanKindColor(spanKindLabel);
  const hasIdentifiableModel = llmData.model && llmData.model !== 'unknown';

  return (
    <div className={styles.container} data-testid="llm-span-detail">
      <div className={styles.headerRow}>
        {hasIdentifiableModel && (
          <div className={styles.modelBadge}>
            <Icon name="ai-sparkle" className={styles.modelIcon} />
            <span data-testid="llm-model-name">{llmData.model}</span>
          </div>
        )}
        {spanKindLabel && (
          <span className={styles.kindBadge} style={{ background: kindColor }} data-testid="llm-span-kind">
            {spanKindLabel.toUpperCase()}
          </span>
        )}
        <span className={styles.conventionBadge}>{getConventionLabel(llmData.convention)}</span>
        {llmData.system && <span className={styles.conventionBadge}>{llmData.system}</span>}
        {llmData.finishReason && <FinishReasonBadge reason={llmData.finishReason} />}
      </div>

      {/* Agent / Provider / Conversation metadata (OTel GenAI) */}
      {llmData.agentName || llmData.agentId || llmData.agentVersion || llmData.provider || llmData.conversationId || llmData.responseId ? (
        <CollapsibleSection title="Agent & Conversation" testId="agent-section">
          <div className={styles.paramsGrid}>
            {llmData.agentName && (
              <div className={styles.paramItem}>
                <span className={styles.paramKey}>Agent:</span>
                <span className={styles.paramValue}>{llmData.agentName}</span>
              </div>
            )}
            {llmData.agentId && (
              <div className={styles.paramItem}>
                <span className={styles.paramKey}>Agent ID:</span>
                <span className={styles.paramValue}>{llmData.agentId}</span>
              </div>
            )}
            {llmData.agentVersion && (
              <div className={styles.paramItem}>
                <span className={styles.paramKey}>Agent Version:</span>
                <span className={styles.paramValue}>{llmData.agentVersion}</span>
              </div>
            )}
            {llmData.provider && (
              <div className={styles.paramItem}>
                <span className={styles.paramKey}>Provider:</span>
                <span className={styles.paramValue}>{llmData.provider}</span>
              </div>
            )}
            {llmData.conversationId && (
              <div className={styles.paramItem}>
                <span className={styles.paramKey}>Conversation:</span>
                <span className={styles.paramValue}>{llmData.conversationId}</span>
              </div>
            )}
            {llmData.responseId && (
              <div className={styles.paramItem}>
                <span className={styles.paramKey}>Response ID:</span>
                <span className={styles.paramValue}>{llmData.responseId}</span>
              </div>
            )}
          </div>
        </CollapsibleSection>
      ) : null}

      {(hasTokenUsage || hasParams) && (
        <CollapsibleSection title="Parameters & Token Usage" defaultOpen={true} testId="params-section">
          {hasTokenUsage && <TokenUsageDisplay usage={llmData.tokenUsage} model={llmData.model} precomputedCostUsd={llmData.precomputedCostUsd} />}
          {hasParams && <InvocationParamsDisplay params={llmData.invocationParams} />}
        </CollapsibleSection>
      )}

      {/* System instructions (OTel GenAI structured format) */}
      {llmData.systemInstructions && llmData.systemInstructions.length > 0 ? (
        <CollapsibleSection title="System Instructions" testId="system-instructions-section">
          {llmData.systemInstructions.map((instr, i) => (
            <div key={i} className={styles.fieldBlock}>
              <div className={styles.fieldLabel}>Instruction {i + 1}</div>
              <div className={styles.valueBlock}>{instr}</div>
            </div>
          ))}
        </CollapsibleSection>
      ) : null}

      {llmData.inputMessages.length > 0 && (
        <CollapsibleSection
          title="Input Messages"
          testId="input-messages-section"
          titleExtra={
            <CopyButton
              text={JSON.stringify(llmData.inputMessages, null, 2)}
              label="input messages"
            />
          }
        >
          <div className={styles.messagesContainer}>
            {llmData.inputMessages.map((msg, i) => (
              <MessageBlock key={`${i}-${msg.role}-${(msg.content ?? '').slice(0, 20)}`} message={msg} />
            ))}
          </div>
        </CollapsibleSection>
      )}

      {llmData.outputMessages.length > 0 && (
        <CollapsibleSection
          title="Output"
          testId="output-section"
          titleExtra={
            llmData.outputMessages.length > 0 ? (
              <CopyButton
                text={JSON.stringify(llmData.outputMessages, null, 2)}
                label="output"
              />
            ) : undefined
          }
        >
          <div className={styles.messagesContainer}>
            {llmData.outputMessages.map((msg, i) => (
              <MessageBlock key={`${i}-${msg.role}-${(msg.content ?? '').slice(0, 20)}`} message={msg} />
            ))}
          </div>
        </CollapsibleSection>
      )}

    </div>
  );
}
