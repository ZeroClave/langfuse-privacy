import { fileURLToPath } from 'node:url';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { clsConfig, clsExporterOptions } from '../examples/tencent-cls/cls.mjs';
import { runClsExample, writeClsReport } from '../examples/tencent-cls/run.mjs';
import { startOtlpCollector } from '../test/helpers/otlp-collector.mjs';

// No Tencent credentials or cloud endpoint. Only the detector is a real service.
const config = clsConfig({
  CLS_DEFAULT_REGION: 'ap-guangzhou',
  CLS_TOPIC_ID: '00000000-0000-4000-8000-000000000001',
  TENCENTCLOUD_SECRET_ID: 'local-synthetic-id',
  TENCENTCLOUD_SECRET_KEY: 'local-synthetic-key',
  ZEROCLAVE_ENDPOINT: process.env.ZEROCLAVE_ENDPOINT,
  ZEROCLAVE_TIMEOUT_MS: process.env.ZEROCLAVE_TIMEOUT_MS ?? '15000',
});
const reportUrl = new URL('../.local/cls-transport-live-report.json', import.meta.url);
const receiver = await startOtlpCollector();
let report;
try {
  console.log('Synthetic fixtures → real ZeroClave → OTLP/protobuf → LOCAL collector → local read-back');
  const exporter = new OTLPTraceExporter({ ...clsExporterOptions(config), url: receiver.url });
  report = await runClsExample(config, {
    exporter,
    search: async ({ traceId, spanId }) => receiver.records.filter((row) => row.traceID === traceId && row.spanID === spanId),
    readbackTimeoutMs: 3_000,
  });
  report = { ...report, mode: 'real-detector-local-collector', cloudPersisted: false };
  console.log('PASS: actual protobuf HTTP receiver collected the masked fields. CLS cloud was NOT contacted.');
  console.log(JSON.stringify(report.stored, null, 2));
} catch (error) {
  const failure = [error?.code, error?.message].find((value) => typeof value === 'string' && /^cls_[a-z_]+$/u.test(value))
    ?? 'cls_transport_test_failed';
  report = { testedAt: new Date().toISOString(), passed: false, cloudPersisted: false,
    mode: 'real-detector-local-collector', failure };
  console.error(`FAIL: ${failure}; no CLS cloud success is claimed.`);
  process.exitCode = 1;
} finally {
  await receiver.close();
  await writeClsReport(report, reportUrl);
  console.log(`Report: ${fileURLToPath(reportUrl)}`);
}
