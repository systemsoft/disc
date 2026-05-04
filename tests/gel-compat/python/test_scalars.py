"""
Scalar codec roundtrip tests + Cardinality.ONE behaviour.

The scalar roundtrip tests are currently expected to FAIL — they
document compat gap #6 (scalar SELECT shape mismatch). disc's typedesc
+ Data builder always emits an Object shape, so `SELECT <bool>$x`
returns `Object{id := None}` instead of the scalar `True`. Each test
is `xfail(strict=True)` so that when the gap is closed, the run will
flip to XPASS and force us to remove the marker — a forced refresh of
the known-good baseline.

The cardinality test exercises the wire Cardinality byte for AT_MOST_ONE
(`querySingle` on an empty filter must return None, not raise) and
already passes against current disc.
"""

import datetime as dt
import os
import uuid

import gel
import pytest

GAP_6 = (
    "P2-09 gap #6: scalar-only SELECT returns an Object{id} shape; "
    "disc's typedesc/Data builder doesn't emit a bare scalar codec. "
    "Will flip to XPASS once the gap is closed."
)


@pytest.fixture(scope="module")
def client():
    host = os.environ.get("DISC_HOST", "127.0.0.1")
    port = int(os.environ.get("DISC_BINARY_PORT", "5656"))
    c = gel.create_client(
        host=host,
        port=port,
        user="disc",
        database="main",
        tls_security="insecure",
    )
    yield c
    c.close()


@pytest.mark.xfail(strict=True, reason=GAP_6)
def test_str_roundtrip(client):
    out = client.query_single("SELECT <str>$x", x="hello-world")
    assert out == "hello-world"


@pytest.mark.xfail(strict=True, reason=GAP_6)
def test_int32_roundtrip(client):
    out = client.query_single("SELECT <int32>$x", x=2147483647)
    assert out == 2147483647


@pytest.mark.xfail(strict=True, reason=GAP_6)
def test_int64_roundtrip(client):
    out = client.query_single("SELECT <int64>$x", x=9223372036854775807)
    assert out == 9223372036854775807


@pytest.mark.xfail(strict=True, reason=GAP_6)
def test_bool_roundtrip_true(client):
    assert client.query_single("SELECT <bool>$x", x=True) is True


@pytest.mark.xfail(strict=True, reason=GAP_6)
def test_bool_roundtrip_false(client):
    assert client.query_single("SELECT <bool>$x", x=False) is False


@pytest.mark.xfail(strict=True, reason=GAP_6)
def test_float64_roundtrip(client):
    out = client.query_single("SELECT <float64>$x", x=3.141592653589793)
    assert out == pytest.approx(3.141592653589793)


@pytest.mark.xfail(strict=True, reason=GAP_6)
def test_uuid_roundtrip(client):
    u = uuid.uuid4()
    out = client.query_single("SELECT <uuid>$x", x=u)
    assert uuid.UUID(str(out)) == u


@pytest.mark.xfail(strict=True, reason=GAP_6)
def test_datetime_roundtrip(client):
    when = dt.datetime(2026, 5, 4, 12, 34, 56, tzinfo=dt.timezone.utc)
    out = client.query_single("SELECT <datetime>$x", x=when)
    assert dt.datetime.fromisoformat(str(out).replace("Z", "+00:00")) == when


def test_query_single_returns_none_on_empty(client):
    """querySingle is AT_MOST_ONE — empty filter returns None, no exception."""
    out = client.query_single(
        "SELECT Item FILTER .id = <uuid>$id",
        id=uuid.UUID("00000000-0000-0000-0000-000000000000"),
    )
    assert out is None
