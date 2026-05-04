# gel-compat — Python smoke

Connects upstream `gel` Python client to a running `disc serve --binary-port`
and exercises CRUD against the binary wire protocol.

## Run locally

From the repository root:

```bash
bash tests/gel-compat/run.sh
```

## Run only the Python suite (server already running)

```bash
cd tests/gel-compat/python
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
DISC_HOST=127.0.0.1 DISC_BINARY_PORT=5656 pytest -v
```

## Why these specific tests

We do not run the upstream gel-python test suite — it depends on
Gel-server-specific features (extensions, stored procedures, transaction
semantics) that disc does not implement. Instead this is a focused CRUD
smoke that validates the wire protocol surface the average client app
actually uses.
