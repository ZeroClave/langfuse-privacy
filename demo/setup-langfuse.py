"""Prepare an isolated local Langfuse stack from the official v4.80.0 compose.

Requires Python + PyYAML on the deployment host. Secrets are generated on that
host and never printed. Re-running preserves existing credentials and volumes.
"""

import os
from pathlib import Path
import secrets
import sys

import yaml


root = Path(sys.argv[1]).resolve()
root.mkdir(parents=True, exist_ok=True)
source = root / "docker-compose.upstream.yml"
config = yaml.safe_load(source.read_text())
services = config["services"]
services.pop("langfuse-ai-gateway", None)
for service in services.values():
    environment = service.get("environment", {})
    for key in list(environment):
        if key.startswith("LANGFUSE_AI_GATEWAY_"):
            del environment[key]
for name in ("postgres", "redis", "clickhouse", "langfuse-worker"):
    services[name].pop("ports", None)
for name in ("langfuse-web", "langfuse-worker"):
    for key in ("LANGFUSE_INGESTION_QUEUE_DELAY_MS", "LANGFUSE_INGESTION_CLICKHOUSE_WRITE_INTERVAL_MS"):
        services[name]["environment"][key] = "${" + key + ":-1000}"
services["langfuse-web"]["ports"] = ["3000:3000"]
services["minio"]["ports"] = ["127.0.0.1:9090:9000"]
for service in services.values():
    service["logging"] = {
        "driver": "json-file",
        "options": {"max-size": "10m", "max-file": "3"},
    }
    service["restart"] = "unless-stopped"
(root / "docker-compose.yml").write_text(yaml.safe_dump(config, sort_keys=False))

env_file = root / ".env"
if not env_file.exists():
    database_password = secrets.token_hex(24)
    storage_password = secrets.token_hex(24)
    values = {
        "LANGFUSE_IMAGE_TAG": "4.80.0",
        "NEXTAUTH_URL": "http://127.0.0.1:3000",
        "NEXTAUTH_SECRET": secrets.token_hex(32),
        "SALT": secrets.token_hex(32),
        "ENCRYPTION_KEY": secrets.token_hex(32),
        "POSTGRES_USER": "postgres",
        "POSTGRES_PASSWORD": database_password,
        "POSTGRES_DB": "langfuse",
        "DATABASE_URL": f"postgresql://postgres:{database_password}@postgres:5432/langfuse",
        "CLICKHOUSE_PASSWORD": secrets.token_hex(24),
        "REDIS_AUTH": secrets.token_hex(24),
        "MINIO_ROOT_USER": "zeroclave",
        "MINIO_ROOT_PASSWORD": storage_password,
        "TELEMETRY_ENABLED": "false",
        "LANGFUSE_INIT_ORG_ID": "zeroclave",
        "LANGFUSE_INIT_ORG_NAME": "ZeroClave",
        "LANGFUSE_INIT_PROJECT_ID": "zeroclave-privacy-demo",
        "LANGFUSE_INIT_PROJECT_NAME": "Privacy Demo",
        "LANGFUSE_INIT_PROJECT_PUBLIC_KEY": "pk-lf-" + secrets.token_hex(16),
        "LANGFUSE_INIT_PROJECT_SECRET_KEY": "sk-lf-" + secrets.token_hex(24),
        "LANGFUSE_INIT_USER_EMAIL": "demo@zeroclave.local",
        "LANGFUSE_INIT_USER_NAME": "ZeroClave Demo",
        "LANGFUSE_INIT_USER_PASSWORD": secrets.token_urlsafe(24),
    }
    for purpose in ("EVENT", "MEDIA", "BATCH_EXPORT"):
        values[f"LANGFUSE_S3_{purpose}_UPLOAD_ACCESS_KEY_ID" if purpose != "BATCH_EXPORT" else "LANGFUSE_S3_BATCH_EXPORT_ACCESS_KEY_ID"] = "zeroclave"
        values[f"LANGFUSE_S3_{purpose}_UPLOAD_SECRET_ACCESS_KEY" if purpose != "BATCH_EXPORT" else "LANGFUSE_S3_BATCH_EXPORT_SECRET_ACCESS_KEY"] = storage_password
    with os.fdopen(os.open(env_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
        output.write("".join(f"{key}={value}\n" for key, value in values.items()))

values = dict(line.split("=", 1) for line in env_file.read_text().splitlines() if line and not line.startswith("#"))
with env_file.open("a") as output:
    for key in ("LANGFUSE_INGESTION_QUEUE_DELAY_MS", "LANGFUSE_INGESTION_CLICKHOUSE_WRITE_INTERVAL_MS"):
        if key not in values:
            output.write(f"{key}=1000\n")
            values[key] = "1000"
demo_env = root / "demo.env"
with os.fdopen(os.open(demo_env, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as output:
    output.write("LANGFUSE_BASE_URL=http://127.0.0.1:3000\n")
    output.write("LANGFUSE_UI_URL=http://127.0.0.1:3000\n")
    output.write(f"LANGFUSE_PROJECT_ID={values['LANGFUSE_INIT_PROJECT_ID']}\n")
    output.write(f"LANGFUSE_PUBLIC_KEY={values['LANGFUSE_INIT_PROJECT_PUBLIC_KEY']}\n")
    output.write(f"LANGFUSE_SECRET_KEY={values['LANGFUSE_INIT_PROJECT_SECRET_KEY']}\n")
print("Langfuse configuration prepared; credentials remain in host-local files.")
