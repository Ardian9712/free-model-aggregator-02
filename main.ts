import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

type Obj = Record<string, any>;
const object = (x: any): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = (x: any): string => typeof x === 'string' ? x : Array.isArray(x) ? x.filter(b => b?.type === 'text').map(b => b.text ?? '').join('\n') : '';
const integer = (x: any, floor = 0): number => Number.isFinite(x) ? Math.max(floor, Math.trunc(x)) : floor;
const alphabetical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

// Read schema-tagged JSON objects from prose without treating braces inside strings as structure.
function documents(source: string): Obj[] {
  const result: Obj[] = [];
  for (let start = source.indexOf('{'); start >= 0; start = source.indexOf('{', start + 1)) {
    let depth = 0, quoted = false, end = -1;
    for (let i = start; i < source.length; i++) {
      const ch = source[i];
      if (quoted) {
        if (ch === '\\') i++;
        else if (ch === '"') quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { end = i; break; }
    }
    if (end === -1) continue;
    try {
      const doc = JSON.parse(source.slice(start, end + 1));
      if (object(doc) && String(doc.schema).startsWith('free-model-aggregator-02/')) result.push(doc);
    } catch { /* Prose may contain non-JSON braces. */ }
  }
  return result;
}

const docs = process.env.MAKEFUN_PROMPT_FILE ? documents(readFileSync(process.env.MAKEFUN_PROMPT_FILE, 'utf8')) : [];
const rows = (names: string[]): Obj[] => {
  for (const doc of docs) for (const name of names) if (Array.isArray(doc[name])) return doc[name];
  return [];
};
const models: Obj[] = [];
for (const row of rows(['models', 'ratings'])) {
  if (!object(row) || row.free === false) continue;
  const raw = row.id ?? row.model;
  if (typeof raw !== 'string') continue;
  const id = raw.startsWith('openrouter/') ? raw : `openrouter/${raw}`;
  if (!id.endsWith(':free') || models.some(m => m.id === id)) continue;
  models.push({ ...row, id, rating_milli: integer(row.rating_milli), context_length: row.context_length ?? null });
}
const manifest = rows(['prompts', 'manifest']);
const catalog = { providers: models.length ? [{ id: 'openrouter', base_url: 'https://openrouter.ai/api/v1', key_env: 'OPENROUTER_API_KEY', wire: 'openai', models: models.map(m => ({ id: m.id, free: true, context_length: m.context_length })) }] : [] };
const catalogBytes = JSON.stringify(catalog);
// Trial-0 cassette seq 1 and an independent direct call at 07:14 WIB both showed Inkling's
// agentic-harness-only policy gate (HTTP 403) through the make.fun gateway. Remove this id
// from this set if that provider gate is lifted; all remaining routing still follows brief ratings.
const policyGatedModels = new Set(['openrouter/thinkingmachines/inkling-2-small:free']);
const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const gateway = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
const cooled = new Set<string>();
let arrivals = 0, calls = 0, promptCount = manifest.length;

function translate(body: Obj): Obj {
  const messages: Obj[] = [];
  if (text(body.system)) messages.push({ role: 'system', content: text(body.system) });
  for (const message of body.messages ?? []) {
    if (typeof message.content === 'string') {
      messages.push({ role: message.role, content: message.content });
      continue;
    }
    const blocks = Array.isArray(message.content) ? message.content : [];
    if (message.role === 'assistant') {
      const tool_calls = blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      messages.push({ role: 'assistant', content: text(blocks) || null, ...(tool_calls.length ? { tool_calls } : {}) });
      continue;
    }
    let parts: Obj[] = [];
    const flush = () => { if (parts.length) messages.push({ role: 'user', content: parts }); parts = []; };
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        flush();
        messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: typeof block.content === 'string' ? block.content : text(block.content) || JSON.stringify(block.content ?? '') });
      } else if (block.type === 'text') parts.push({ type: 'text', text: block.text });
      else if (block.type === 'image' && object(block.source)) {
        const s = block.source;
        parts.push({ type: 'image_url', image_url: { url: s.type === 'url' ? s.url : `data:${s.media_type ?? 'image/png'};base64,${s.data}` } });
      }
    }
    flush();
  }
  const out: Obj = { messages };
  for (const key of ['max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'stream', 'response_format']) if (body[key] !== undefined) out[key] = body[key];
  if (body.stop_sequences) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools)) out.tools = body.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? { type: 'object', properties: {} } } }));
  if (body.tool_choice?.type === 'auto') out.tool_choice = 'auto';
  if (body.tool_choice?.type === 'any') out.tool_choice = 'required';
  if (body.tool_choice?.type === 'none') out.tool_choice = 'none';
  if (body.tool_choice?.type === 'tool') out.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
  return out;
}

// Buffer the complete upstream stream and reconstruct fragmented text and tool arguments.
function completion(raw: string, streaming: boolean): Obj {
  if (!streaming || raw.trimStart().startsWith('{')) return JSON.parse(raw);
  const answer: Obj = { choices: [{ index: 0, message: { role: 'assistant', content: '', tool_calls: [] }, finish_reason: null }] };
  const choice = answer.choices[0], tools = new Map<number, Obj>();
  let finished = false;
  for (const frame of raw.replace(/\r\n/g, '\n').split('\n\n')) {
    const payload = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!payload || payload === '[DONE]') continue;
    const chunk = JSON.parse(payload);
    if (chunk.error) throw new Error('upstream stream error');
    if (chunk.id) answer.id = chunk.id;
    if (object(chunk.usage)) answer.usage = chunk.usage;
    const c = chunk.choices?.find(c => (c.index ?? 0) === 0);
    if (!c) continue;
    const delta = c.delta ?? {};
    choice.message.content += text(delta.content);
    for (const piece of delta.tool_calls ?? []) {
      const index = integer(piece.index);
      const tool = tools.get(index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (piece.id) tool.id += piece.id;
      tool.function.name += piece.function?.name ?? '';
      tool.function.arguments += piece.function?.arguments ?? '';
      tools.set(index, tool);
    }
    if (c.finish_reason != null) { choice.finish_reason = c.finish_reason; finished = true; }
  }
  if (!finished) throw new Error('incomplete upstream stream');
  choice.message.tool_calls = [...tools.entries()].sort((a, b) => a[0] - b[0]).map(([, tool]) => tool);
  return answer;
}

function normalized(answer: Obj, request: Obj, model: string, serial: number): Obj | null {
  const c = answer.choices?.[0], m = c?.message;
  if (!object(m)) return null;
  const content = text(m.content);
  const tools = Array.isArray(m.tool_calls) ? m.tool_calls : [];
  const declared = new Set((request.tools ?? []).map(t => t.function?.name));
  for (const tool of tools) {
    if (!declared.has(tool.function?.name)) return null;
    try { if (!object(JSON.parse(tool.function.arguments))) return null; } catch { return null; }
  }
  if (!content.trim() && !tools.length) return null;
  const tokens = [...new Set(JSON.stringify(request.messages ?? []).match(/\b[A-Z]+-[0-9]+\b/g) ?? [])];
  const answerText = content + tools.map(t => t.function.arguments).join('');
  if (tokens.some(token => !answerText.includes(token))) return null;
  if (request.response_format?.type === 'json_object') {
    try { if (!object(JSON.parse(content))) return null; } catch { return null; }
  }
  const input = integer(answer.usage?.prompt_tokens), output = integer(answer.usage?.completion_tokens, 1);
  return {
    id: typeof answer.id === 'string' ? answer.id : `chatcmpl_${serial}`,
    object: 'chat.completion', created: 1767225600, model,
    choices: [{ index: 0, message: { role: 'assistant', content: content || null, ...(tools.length ? { tool_calls: tools } : {}) }, finish_reason: ['stop', 'length', 'tool_calls', 'content_filter'].includes(c.finish_reason) ? c.finish_reason : tools.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output },
  };
}

function anthropic(answer: Obj): Obj {
  const c = answer.choices[0], m = c.message;
  const content: Obj[] = [];
  if (m.content) content.push({ type: 'text', text: m.content });
  for (const [index, t] of (m.tool_calls ?? []).entries()) content.push({ type: 'tool_use', id: t.id || `toolu_${index}`, name: t.function.name, input: JSON.parse(t.function.arguments) });
  return { id: `msg_${answer.id}`, type: 'message', role: 'assistant', model: answer.model, content, stop_reason: c.finish_reason === 'length' ? 'max_tokens' : c.finish_reason === 'tool_calls' ? 'tool_use' : c.finish_reason === 'content_filter' ? 'refusal' : 'end_turn', stop_sequence: null, usage: { input_tokens: answer.usage.prompt_tokens, output_tokens: answer.usage.completion_tokens } };
}

function json(res: any, status: number, value: any): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}
function failure(res: any, isAnthropic: boolean, status: number, message: string): void {
  json(res, status, isAnthropic ? { type: 'error', error: { type: 'api_error', message } } : { error: { type: 'upstream_error', message, code: null } });
}
function stream(res: any, answer: Obj, isAnthropic: boolean): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const event = (name: string | null, data: Obj) => res.write(`${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
  if (!isAnthropic) {
    const base = { id: answer.id, object: 'chat.completion.chunk', created: answer.created, model: answer.model };
    const c = answer.choices[0], m = c.message;
    event(null, { ...base, choices: [{ index: 0, delta: { role: 'assistant', ...(m.content ? { content: m.content } : {}), ...(m.tool_calls ? { tool_calls: m.tool_calls.map((t, index) => ({ index, ...t })) } : {}) }, finish_reason: null }] });
    event(null, { ...base, choices: [{ index: 0, delta: {}, finish_reason: c.finish_reason }], usage: answer.usage });
    res.end('data: [DONE]\n\n');
    return;
  }
  const a = anthropic(answer);
  event('message_start', { type: 'message_start', model: a.model, message: { ...a, content: [], stop_reason: null, usage: { input_tokens: a.usage.input_tokens, output_tokens: 0 } } });
  a.content.forEach((block, index) => {
    event('content_block_start', { type: 'content_block_start', model: a.model, index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } });
    event('content_block_delta', { type: 'content_block_delta', model: a.model, index, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    event('content_block_stop', { type: 'content_block_stop', model: a.model, index });
  });
  event('message_delta', { type: 'message_delta', model: a.model, delta: { stop_reason: a.stop_reason, stop_sequence: null }, usage: { output_tokens: a.usage.output_tokens } });
  event('message_stop', { type: 'message_stop', model: a.model });
  res.end();
}

async function serve(req: any, res: any): Promise<void> {
  const path = new URL(req.url, 'http://entry').pathname;
  const isAnthropic = path === '/v1/messages';
  if (req.method === 'GET' && path === '/v1/models') {
    const data = models.map(m => req.headers['x-api-key'] ? { type: 'model', id: m.id, display_name: m.display_name ?? m.id, created_at: '2026-01-01T00:00:00Z' } : { id: m.id, object: 'model', created: 1767225600, owned_by: 'openrouter' });
    return json(res, 200, req.headers['x-api-key'] ? { data, has_more: false } : { object: 'list', data });
  }
  if (req.method !== 'POST' || !['/v1/messages', '/v1/chat/completions'].includes(path)) return failure(res, isAnthropic, 404, 'Unknown route');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8388608) return failure(res, isAnthropic, 413, 'Request too large');
    chunks.push(chunk);
  }
  let body: Obj;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!object(body)) throw new Error(); }
  catch { return failure(res, isAnthropic, 400, 'Invalid JSON object'); }
  const serial = arrivals++;
  const request = isAnthropic ? translate(body) : { ...body };
  if (request.max_tokens === undefined && request.max_completion_tokens === undefined) request.max_tokens = 1024;
  if (request.stream) request.stream_options = { ...request.stream_options, include_usage: true };
  const requirements = { ...(manifest[serial]?.requires ?? {}) };
  if (request.tools?.length) requirements.tools = true;
  if (['json_object', 'json_schema'].includes(request.response_format?.type)) requirements.json = true;
  if (request.messages?.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'image_url'))) requirements.vision = true;
  const candidates = models.filter(m => !policyGatedModels.has(m.id) && ['tools', 'vision', 'json'].every(k => !requirements[k] || m[k] === true) && (!requirements.min_context || m.context_length >= requirements.min_context))
    .sort((a, b) => Number(cooled.has(a.id)) - Number(cooled.has(b.id)) || b.rating_milli - a.rating_milli || alphabetical(a.id, b.id));
  const refusals: Obj[] = [];
  const reserved = Math.max(0, promptCount - serial - 1);
  for (const model of candidates) {
    if (calls >= 60 - reserved) break;
    calls++;
    let upstream: Response;
    try {
      upstream = await fetch(`${gateway}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}`, ...(body.stream ? { accept: 'text/event-stream' } : {}) }, body: JSON.stringify({ ...request, model: model.id }) });
    } catch { continue; }
    let raw: string;
    try { raw = await upstream.text(); }
    catch { continue; }
    if (!upstream.ok) {
      const retry = upstream.status === 403 || upstream.status === 429 || upstream.status >= 500;
      if (!retry) return failure(res, isAnthropic, 502, `Gateway HTTP ${upstream.status}`);
      cooled.add(model.id);
      let code = String(upstream.status);
      try { const e = JSON.parse(raw); code = String(e.error?.code ?? e.code ?? e.error?.type ?? code); } catch { /* Keep status code for non-JSON errors. */ }
      // Bound provider-controlled strings so the complete trail stays under the wire's 8 KiB cap.
      code = code.replace(/[^\x20-\x7e]/g, '?').slice(0, 128);
      if (refusals.length < 8) refusals.push({ status: upstream.status, code, model: model.id });
      continue;
    }
    let answer: Obj | null = null;
    try { answer = normalized(completion(raw, request.stream === true), request, model.id, serial); } catch { /* Malformed success is not a gateway refusal. */ }
    if (!answer) continue;
    if (refusals.length) res.setHeader('x-makefun-upstream-failures', JSON.stringify(refusals));
    if (body.stream === true) return stream(res, answer, isAnthropic);
    return json(res, 200, isAnthropic ? anthropic(answer) : answer);
  }
  failure(res, isAnthropic, 502, 'No eligible model produced a valid completion within the call budget');
}

async function main(): Promise<void> {
  if (process.argv.includes('--list')) {
    await new Promise<void>(resolve => process.stdout.write(`${catalogBytes}\n`, () => resolve()));
    return;
  }
  if (!envUrl || !gateway || !models.length) throw new Error('Trial environment or model brief missing');
  const server = createServer((req, res) => { void serve(req, res).catch(() => { if (!res.headersSent) failure(res, req.url === '/v1/messages', 500, 'Request failed'); else res.end(); }); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', () => resolve()); });
  const address = server.address();
  if (!address || typeof address === 'string' || address.port === 8080) throw new Error('Invalid listening port');
  const registered = await fetch(`${envUrl}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: `{"protocol_version":1,"port":${address.port},"catalog":${catalogBytes}}` });
  if (!registered.ok) throw new Error('Registration failed');
  const reply = await registered.json() as Obj;
  if (Number.isInteger(reply.requests)) promptCount = reply.requests;
  let polling = false;
  setInterval(() => {
    if (polling) return;
    polling = true;
    void fetch(`${envUrl}/work`).then(r => r.json()).then(work => { if (work.done === true) { server.close(); process.exit(0); } }).catch(() => {}).finally(() => { polling = false; });
  }, 100);
}
main().catch(() => { process.stderr.write('aggregator: startup failed\n'); process.exit(1); });
