// Load this module before your application's tracing/instrumentation libraries.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor, type MaskFunction } from '@langfuse/otel';
import { createZeroClaveMask } from '@zeroclave/langfuse-privacy';

const mask: MaskFunction = createZeroClaveMask();

export const sdk = new NodeSDK({
  spanProcessors: [new LangfuseSpanProcessor({ mask })],
});

sdk.start();
