"""
Scalar codec roundtrip tests + Cardinality.AT_MOST_ONE behaviour.

These tests cover scalar `SELECT <T>$x` roundtrips for the codecs in
`protocol/scalar-codecs.ts`, plus the AT_MOST_ONE cardinality contract
where `querySingle` on an empty filter must return None rather than
raising. Originally introduced as `xfail` while gap #6 (scalar-only
SELECT returning an Object{id} shape) was open; closed once
`buildDescriptors` started emitting CTYPE_BASE_SCALAR for bare-scalar
top-level SELECT expressions.
"""

import datetime as dt
import os
import uuid

import gel
import pytest


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


def test_str_roundtrip(client):
    out = client.query_single("SELECT <str>$x", x="hello-world")
    assert out == "hello-world"


def test_int32_roundtrip(client):
    out = client.query_single("SELECT <int32>$x", x=2147483647)
    assert out == 2147483647


def test_int64_roundtrip(client):
    out = client.query_single("SELECT <int64>$x", x=9223372036854775807)
    assert out == 9223372036854775807


def test_bool_roundtrip_true(client):
    assert client.query_single("SELECT <bool>$x", x=True) is True


def test_bool_roundtrip_false(client):
    assert client.query_single("SELECT <bool>$x", x=False) is False


def test_float64_roundtrip(client):
    out = client.query_single("SELECT <float64>$x", x=3.141592653589793)
    assert out == pytest.approx(3.141592653589793)


def test_uuid_roundtrip(client):
    u = uuid.uuid4()
    out = client.query_single("SELECT <uuid>$x", x=u)
    assert uuid.UUID(str(out)) == u


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


def test_datetime_str_error_carries_gel_hint(client):
    """A str that is no ISO 8601 datetime: Gel 7.1's message and hint."""
    with pytest.raises(gel.InvalidValueError) as err:
        client.query_single("SELECT <datetime>'x'")
    assert str(err.value).split("\n")[0] == "invalid input syntax for type std::datetime: 'x'"
    assert err.value._hint == (
        "Please use ISO8601 format. Example: 2010-12-27T23:59:59-07:00. "
        'Alternatively "to_datetime" function provides custom formatting options.'
    )


def test_array_of_arrays_argument_roundtrip(client):
    """gel-python sends an array of arrays, each inner one in a tuple; so does Gel."""
    out = client.query_single("SELECT <array<array<int64>>>$p", p=[[1, 2], [], [3]])
    assert out == [[1, 2], [], [3]]
    assert client.query_single("SELECT [[1, 2], [3]]") == [[1, 2], [3]]
