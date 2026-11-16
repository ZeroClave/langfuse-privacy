import { fileURLToPath } from 'node:url';
import { slsConfig } from '../examples/alibaba-sls/sls.mjs';
import { runSlsExample, writeSlsReport } from '../examples/alibaba-sls/run.mjs';
import { createLocalSlsClient, startSlsCollector } from '../test/helpers/sls-local-collector.mjs';

// Explicit synthetic credentials and loopback only; never load .env.sls here.
const config = slsConfig({
  SLS_REGION: 'cn-hangzhou',
  SLS_PROJECT: 'zeroclave-local-test',
  SLS_LOGSTORE: 'privacy-demo',
  ALIBABA_CLOUD_ACCESS_KEY_ID: 'synthetic-local-id',
  ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'synthetic-local-secret',
  ALIBABA_CLOUD_SECURITY_TOKEN: 'synthetic-local-sts-token',
  ZEROCLAVE_ENDPOINT: process.env.ZEROCLAVE_ENDPOINT,
  ZEROCLAVE_TIMEOUT_MS: process.env.ZEROCLAVE_TIMEOUT_MS ?? '15000',
});
const reportUrl = new URL('../.local/sls-transport-live-report.json', import.meta.url);
const receiver = await startSlsCollector({ credentials: config, logstore: config.logstore });
let report;
try {
  console.log('Synthetic fixtures → real ZeroClave → SLS SDK signed protobuf → LOCAL collector → local read-back');
  const client = await createLocalSlsClient(config, receiver);
  report = await runSlsExample(config, { client, readbackTimeoutMs: 3_000 });
  report = { ...report, mode: 'real-detector-local-collector', cloudPersisted: false };
  console.log('PASS: local receiver collected and returned the masked log. Alibaba SLS cloud was NOT contacted.');
  console.log(JSON.stringify(report.stored, null, 2));
} catch (error) {
  const failure = [error?.code, error?.message].find((value) => typeof value === 'string' && /^sls_[a-z_]+$/u.test(value))
    ?? 'sls_transport_test_failed';
  report = { testedAt: new Date().toISOString(), passed: false, persisted: false, cloudPersisted: false,
    mode: 'real-detector-local-collector', failure };
  console.error(`FAIL: ${failure}; no Alibaba SLS cloud success is claimed.`);
  process.exitCode = 1;
} finally {
  await receiver.close();
  await writeSlsReport(report, reportUrl);
  console.log(`Report: ${fileURLToPath(reportUrl)}`);
}
