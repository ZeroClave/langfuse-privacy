# Contributing

Use Node.js 22 or 24 and npm. Run `npm ci --ignore-scripts` followed by `npm run check` before opening a pull request.

Keep the adapter small and the public API centered on `createZeroClaveMask`. Do not add a dependency on the DSH plugin or its UI. The service contract is `POST /v1/pii/detect` with codepoint entity offsets, matching request IDs and text revisions, and explicit `complete`/`partial` status.

For changes to detection, transformation, or failure behavior, add a meaningful test using synthetic text and a mocked service. Never put personal information, API keys, recordings, or production traces into an issue, fixture or snapshot. Tests must not depend on a live ZeroClave or Langfuse service.

New failure paths must throw a safe `ZeroClavePrivacyError`; do not return the original field, include arbitrary remote messages in errors, or ignore partial detection. Keep the README privacy scope accurate when changing supported fields or data types.

## Release checklist

1. Confirm the intended npm scope and GitHub repository permissions.
2. Update the version, lockfile and README status together.
3. Run `npm ci --ignore-scripts`, `npm run check` and `npm pack --dry-run`.
4. Inspect the packed files and smoke-test the tarball in a separate application.
5. Publish only with maintainer authorization. For a prerelease, use the `alpha` dist-tag (`npm publish --access public --tag alpha`).

CI validates changes; it does not publish packages or contact the production detector.
