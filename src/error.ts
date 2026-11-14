export type ZeroClavePrivacyErrorCode =
  | 'invalid_options'
  | 'unsupported_input'
  | 'input_too_large'
  | 'detection_failed'
  | 'invalid_response'
  | 'incomplete_detection'
  | 'timeout';

// Langfuse may log mask exceptions. Never attach input, response bodies, or causes.
export class ZeroClavePrivacyError extends Error {
  constructor(readonly code: ZeroClavePrivacyErrorCode) {
    super(`ZeroClave privacy masking failed (${code}).`);
    this.name = 'ZeroClavePrivacyError';
  }
}
