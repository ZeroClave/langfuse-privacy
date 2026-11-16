import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSlsReader, waitForSlsRecord } from './readback.mjs';
import { createSlsWriter, RUN_ID, slsConfig, SlsError } from './sls.mjs';

export const CANARIES = ['张三', '13800138000', 'alice@example.com'];
const REPORT = new URL('../../.local/sls-live-test-report.json', import.meta.url);
const MASK = /\[REDACTED_[A-Z][A-Z0-9_]*\]/u;

export function syntheticData() {
  return {
    input: { messages: [{ role: 'user', content: '😀虚构测试客户张三，联系电话13800138000，邮箱alice@example.com。请联系该客户。' }] },
    output: { reply: '已记录虚构客户张三，邮箱alice@example.com。', count: 1 },
    metadata: { customer: '虚构客户张三的邮箱是alice@example.com。', enabled: true },
  };
}

function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SlsError('sls_invalid_stored_fields');
  return value;
}

function scan(value, depth = 0) {
  if (depth > 32) throw new SlsError('sls_invalid_stored_fields');
  if (typeof value === 'string') {
    if (CANARIES.some((canary) => value.includes(canary))) throw new SlsError('sls_canary_remaining');
    if (value.includes('<fully masked due to failed mask function>')) throw new SlsError('sls_detection_incomplete');
    // Decode escapes even in nested JSON strings, so escaped canaries cannot pass.
    let decoded = value;
    for (let pass = 0; pass < 32; pass++) {
      const next = decoded.replace(/\\u([a-f0-9]{4})/giu, (_, code) => String.fromCharCode(parseInt(code, 16)));
      if (next === decoded) break;
      decoded = next;
      if (CANARIES.some((canary) => decoded.includes(canary))) throw new SlsError('sls_canary_remaining');
      if (decoded.includes('<fully masked due to failed mask function>')) throw new SlsError('sls_detection_incomplete');
      if (pass === 31) throw new SlsError('sls_invalid_stored_fields');
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) { scan(key, depth + 1); scan(item, depth + 1); }
  }
}

/** Check the cloud-returned record, including decoded nested string values. */
export function verifySlsRecord(record, { runId }) {
  if (typeof runId !== 'string' || !RUN_ID.test(runId) || record?.runId !== runId) {
    throw new SlsError('sls_record_mismatch');
  }
  scan(record);
  if (record.schemaVersion !== '1' || record.service !== 'zeroclave-sls-demo'
    || typeof record.payload !== 'string') throw new SlsError('sls_invalid_stored_fields');
  let data;
  try { data = JSON.parse(record.payload); }
  catch { throw new SlsError('sls_invalid_stored_fields'); }
  const { input, output, metadata } = object(data);
  object(input); object(output); object(metadata);
  scan(data);
  if (input.messages?.[0]?.role !== 'user' || typeof input.messages?.[0]?.content !== 'string'
    || !input.messages[0].content.startsWith('😀') || !input.messages[0].content.includes('请联系该客户')
    || output.count !== 1 || metadata.enabled !== true) throw new SlsError('sls_structure_not_preserved');
  for (const text of [input.messages[0].content, output.reply, metadata.customer]) {
    if (typeof text !== 'string' || !MASK.test(text)) throw new SlsError('sls_mask_not_observed');
  }
  return { input, output, metadata };
}

export async function runSlsExample(config, {
  client, maskOptions, search, readbackTimeoutMs = config.readbackTimeoutMs,
} = {}) {
  config = { ...config };
  const startedAt = Date.now();
  const write = createSlsWriter(config, { client, maskOptions });
  const receipt = await write(syntheticData());
  const records = await waitForSlsRecord(config, {
    runId: receipt.runId,
    from: Math.floor((startedAt - 60_000) / 60_000) * 60_000,
    to: Math.ceil((Date.now() + 60_000) / 60_000) * 60_000,
    timeoutMs: readbackTimeoutMs,
    search: search ?? createSlsReader(config, { client }),
  });
  const stored = records.map((record) => verifySlsRecord(record, { runId: receipt.runId }));
  if (stored.length === 0) throw new SlsError('sls_record_not_found');
  return {
    testedAt: new Date().toISOString(), passed: true,
    mode: client || search ? 'local-collector' : 'sls-cloud',
    persisted: true, cloudPersisted: !client && !search,
    runId: receipt.runId, region: config.region, project: config.project, logstore: config.logstore,
    checks: { writeAcknowledged: true, matchingStoredRecord: true, syntheticCanariesRemoved: true,
      completeMasking: true, jsonAndUnicodePreserved: true },
    stored: stored[0],
  };
}

export async function writeSlsReport(report, url = REPORT) {
  await mkdir(new URL('./', url), { recursive: true });
  await writeFile(url, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let report;
  try {
    // Node preserves environment variables that were already present.
    try { process.loadEnvFile(fileURLToPath(new URL('../../.env.sls', import.meta.url))); }
    catch (error) { if (error.code !== 'ENOENT') throw new SlsError('sls_env_file_failed'); }
    console.log('Synthetic fixtures → ZeroClave → SLS PutLogs → GetLogs read-back');
    report = await runSlsExample(slsConfig());
    console.log(`PASS: SLS returned the matching masked record ${report.runId}.`);
    console.log(JSON.stringify(report.stored, null, 2));
  } catch (error) {
    const code = [error?.code, error?.message].find((value) => typeof value === 'string' && /^sls_[a-z_]+$/u.test(value))
      ?? 'sls_example_failed';
    report = { testedAt: new Date().toISOString(), passed: false, persisted: false, cloudPersisted: false,
      mode: 'sls-cloud', failure: code };
    console.error(`FAIL: ${code}. See docs/alibaba-sls.md; no cloud success is claimed.`);
    process.exitCode = 1;
  }
  try {
    await writeSlsReport(report);
    console.log(`Report: ${fileURLToPath(REPORT)}`);
  } catch {
    console.error('FAIL: sls_report_write_failed.');
    process.exitCode = 1;
  }
}
