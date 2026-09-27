"""
Compatibility smoke tests: upstream `gel` Python client against `disc serve`.

Validates that disc's Gel binary wire protocol implementation accepts a real
client through the full handshake → query loop. We do not run the upstream
gel-python test suite because it depends on Gel-server-specific features
(extensions, stored procedures, transaction semantics, etc.).

The disc server must already be running on the host:port given by
DISC_HOST / DISC_BINARY_PORT (defaults: 127.0.0.1:5656). The runner script
at tests/gel-compat/run.sh handles that.
"""

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


def test_insert_returns_id(client):
    item = client.query_single(
        "INSERT Item { name := <str>$name, count := <int32>$count }",
        name="alpha",
        count=1,
    )
    assert item is not None
    assert hasattr(item, "id")
    uuid.UUID(str(item.id))  # raises if not a valid uuid


def test_select_filter_by_id(client):
    inserted = client.query_single(
        "INSERT Item { name := <str>$name, count := <int32>$count }",
        name="bravo",
        count=2,
    )
    fetched = client.query_single(
        "SELECT Item { id, name, count } FILTER .id = <uuid>$id",
        id=inserted.id,
    )
    assert fetched.name == "bravo"
    assert fetched.count == 2


def test_update_then_reselect(client):
    inserted = client.query_single(
        "INSERT Item { name := <str>$name, count := <int32>$count }",
        name="charlie",
        count=3,
    )
    client.query(
        "UPDATE Item FILTER .id = <uuid>$id SET { count := <int32>$new }",
        id=inserted.id,
        new=99,
    )
    fetched = client.query_single(
        "SELECT Item { count } FILTER .id = <uuid>$id",
        id=inserted.id,
    )
    assert fetched.count == 99


def test_select_multi_row(client):
    rows = client.query("SELECT Item { id, name, count }")
    assert len(rows) >= 3  # at least the three inserted above


def test_delete_then_missing(client):
    inserted = client.query_single(
        "INSERT Item { name := <str>$name, count := <int32>$count }",
        name="delta",
        count=4,
    )
    client.query(
        "DELETE Item FILTER .id = <uuid>$id",
        id=inserted.id,
    )
    fetched = client.query(
        "SELECT Item { id } FILTER .id = <uuid>$id",
        id=inserted.id,
    )
    assert len(fetched) == 0


def test_select_set_literal(client):
    assert list(client.query("SELECT {1, 2, 2}")) == [1, 2, 2]
    assert list(client.query("SELECT {<str>$a, <str>$b}", a="x", b="y")) == ["x", "y"]


def test_with_select_shape(client):
    name = f"echo-{uuid.uuid4()}"
    client.query_single(
        "INSERT Item { name := <str>$name, count := <int32>$count }",
        name=name,
        count=5,
    )
    filtered = client.query(
        "WITH n := <str>$n SELECT Item { name, count } FILTER .name = n",
        n=name,
    )
    assert [(r.name, r.count) for r in filtered] == [(name, 5)]
    aliased = client.query(
        "WITH i := (SELECT Item FILTER .name = <str>$n) SELECT i { name }",
        n=name,
    )
    assert [r.name for r in aliased] == [name]


def test_query_single_scalar(client):
    assert client.query_single("SELECT 42") == 42


def test_count_is_an_int64(client):
    total = client.query_single("SELECT count(Item)")
    assert isinstance(total, int)
    assert total == len(client.query("SELECT Item"))


def test_path_select_returns_the_property_values(client):
    name = f"path-{uuid.uuid4()}"
    client.query_single(
        "INSERT Item { name := <str>$name, count := <int32>$count }",
        name=name,
        count=6,
    )
    names = list(client.query("SELECT Item.name"))
    assert all(isinstance(n, str) for n in names)
    assert name in names
