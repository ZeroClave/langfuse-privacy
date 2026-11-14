# Browser demo

The demo sends text to the real ZeroClave detector, runs the actual Langfuse span processor, and displays the masked text and final in-memory export. It does not generate an LLM response or persist a trace to Langfuse Cloud. No Langfuse account or keys are required.

```sh
npm ci --ignore-scripts
npm run demo
```

Open `http://localhost:3017`. The default listener is loopback. Set `HOST=0.0.0.0` to make it reachable from an OrbStack VM, and `PORT` to select another port. `ZEROCLAVE_ENDPOINT` and `ZEROCLAVE_TIMEOUT_MS` can override the detector URL and the default 15-second budget.

Use the built-in synthetic examples first. The service does not write submitted text or results to disk. Text is still sent to the detection service, and the browser displays it on the current page. This is a development demo without accounts or authentication; keep it on your development network.

Each request creates an isolated in-memory Langfuse exporter. Inputs are capped at 10,000 UTF-16 units, and the demo permits two concurrent requests. Failed or partial detection produces an error with no original-text fallback. A successful response with no findings is presented as such, without claiming the text contains no PII.

## Linux service

Build and run `npm run check` before installing. Use `zeroclave-langfuse-demo.service.in` as a systemd template. Replace `@USER@`, `@ROOT@`, and `@NODE@` with your non-root service user, absolute repository directory, and Node.js executable. Install the rendered file as `/etc/systemd/system/zeroclave-langfuse-demo.service`, then run:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now zeroclave-langfuse-demo
sudo systemctl status zeroclave-langfuse-demo
```

The template listens on all interfaces at port 3017 and restarts on failure. It runs with read-only access to the application directory.
