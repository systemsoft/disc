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

import json
import os
import random
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


def test_arrays_decode_as_lists(client):
    assert client.query_single("SELECT [1, 2]") == [1, 2]
    assert client.query_single("SELECT <array<str>>$tags", tags=["a", "b"]) == ["a", "b"]
    assert client.query_single("SELECT array_agg({1, 2})") == [1, 2]


def test_tuples_and_named_tuples_decode_as_tuples(client):
    assert tuple(client.query_single("SELECT (1, 'a')")) == (1, "a")
    named = client.query_single("SELECT (a := 1, b := 'x')")
    assert (named.a, named.b) == (1, "x")
    pairs = client.query("SELECT enumerate({'x', 'y'})")
    assert [tuple(pair) for pair in pairs] == [(0, "x"), (1, "y")]


def test_exclusive_violation_raises_constraint_violation_error(client):
    code = f"label-{uuid.uuid4()}"
    client.query("INSERT Label { code := <str>$code }", code=code)
    with pytest.raises(gel.ConstraintViolationError):
        client.query("INSERT Label { code := <str>$code }", code=code)


def test_query_json_returns_the_result_as_a_json_array(client):
    name = f"json-{uuid.uuid4()}"
    client.query(
        "INSERT Item { name := <str>$name, count := <int32>$count }",
        name=name,
        count=7,
    )
    text = client.query_json(
        "SELECT Item { name, count } FILTER .name = <str>$name", name=name
    )
    assert json.loads(text) == [{"name": name, "count": 7}]
    assert client.query_json("SELECT Item { name } FILTER .name = 'nobody'") == "[]"


def test_query_single_json_returns_one_object_or_null(client):
    name = f"json1-{uuid.uuid4()}"
    client.query(
        "INSERT Item { name := <str>$name, count := <int32>$count }",
        name=name,
        count=8,
    )
    one = "SELECT Item { name, count } FILTER .name = <str>$name LIMIT 1"
    expected = {"name": name, "count": 8}
    assert json.loads(client.query_single_json(one, name=name)) == expected
    assert json.loads(client.query_required_single_json(one, name=name)) == expected
    assert client.query_single_json(one, name="nobody") == "null"


def test_group_returns_key_grouping_and_elements(client):
    count = random.randint(1_000_000, 2_000_000_000)
    names = sorted(f"grp-{uuid.uuid4()}" for _ in range(2))
    for name in names:
        client.query(
            "INSERT Item { name := <str>$name, count := <int32>$count }",
            name=name,
            count=count,
        )
    groups = client.query("GROUP Item { name } BY .count")
    [group] = [g for g in groups if g.key.count == count]
    assert list(group.grouping) == ["count"]
    assert sorted(e.name for e in group.elements) == names


def test_nested_multi_link_shapes(client):
    a, b = sorted(f"book-{uuid.uuid4()}" for _ in range(2))
    client.query("INSERT Book { title := <str>$t, tags := {'x', 'y'} }", t=a)
    client.query("INSERT Book { title := <str>$t }", t=b)
    name = f"author-{uuid.uuid4()}"
    client.query(
        """
        INSERT Author {
          name := <str>$name,
          books := (SELECT Book FILTER .title = <str>$a OR .title = <str>$b),
          best := (SELECT Book FILTER .title = <str>$a LIMIT 1)
        }
        """,
        name=name,
        a=a,
        b=b,
    )
    author = client.query_single(
        """
        SELECT Author { name, books: { title, tags }, best: { title } }
        FILTER .name = <str>$name
        """,
        name=name,
    )
    books = sorted(author.books, key=lambda book: book.title)
    assert [(book.title, sorted(book.tags)) for book in books] == [
        (a, ["x", "y"]),
        (b, []),
    ]
    assert author.best.title == a

    # A link without a sub-shape is its objects' ids.
    bare = client.query_single(
        "SELECT Author { books, best } FILTER .name = <str>$name", name=name
    )
    best_id = client.query_single("SELECT Book { id } FILTER .title = <str>$a", a=a).id
    assert bare.best.id == best_id
    assert best_id in [book.id for book in bare.books]
    assert len(bare.books) == 2

    nested = json.loads(
        client.query_json(
            "SELECT Author { name, books: { title } } FILTER .name = <str>$name",
            name=name,
        )
    )
    assert sorted(book["title"] for book in nested[0]["books"]) == [a, b]


def test_objects_carry_an_implicit_id(client):
    # The client always asks for ids (INJECT_OUTPUT_OBJECT_IDS); they're hidden.
    inserted = client.query_single(
        "INSERT Item { name := <str>$name, count := <int32>$count }",
        name=f"implicit-{uuid.uuid4()}",
        count=9,
    )
    fetched = client.query_single(
        "SELECT Item { name } FILTER .id = <uuid>$id", id=inserted.id
    )
    assert fetched.id == inserted.id
    assert "id" not in repr(fetched)
    described = client._describe_query("SELECT Item { name }")
    assert described.output_type.elements["id"].is_implicit
    assert not described.output_type.elements["name"].is_implicit


def test_link_properties_splats_and_object_group_keys(client):
    title = f"member-{uuid.uuid4()}"
    client.query("INSERT Book { title := <str>$t }", t=title)
    team = client.query_single(
        """
        INSERT Team {
          name := <str>$name,
          members := (SELECT Book FILTER .title = <str>$t) { @role := 'lead' }
        }
        """,
        name=f"team-{uuid.uuid4()}",
        t=title,
    )
    fetched = client.query_single(
        "SELECT Team { members: { title, @role } } FILTER .id = <uuid>$id",
        id=team.id,
    )
    [member] = fetched.members
    assert (member.title, member["@role"]) == (title, "lead")
    members = client._describe_query(
        "SELECT Team { members: { title, @role } }"
    ).output_type.elements["members"]
    assert members.kind == gel.enums.ElementKind.LINK
    member_kinds = members.type.element_type.elements
    assert member_kinds["@role"].kind == gel.enums.ElementKind.LINK_PROPERTY

    splat = client.query_single("SELECT Book { * } FILTER .title = <str>$t", t=title)
    assert (splat.title, list(splat.tags)) == (title, [])

    client.query(
        "INSERT Author { name := <str>$n, best := (SELECT Book FILTER .title = <str>$t LIMIT 1) }",
        n=f"keyed-{uuid.uuid4()}",
        t=title,
    )
    groups = client.query("GROUP Author { name } USING b := .best BY b")
    assert any(g.key.b is not None and g.key.b.id for g in groups)


def test_execute_runs_without_a_result(client):
    assert client.execute("UPDATE Item FILTER .name = 'nobody' SET { count := 0 }") is None


def test_single_results_of_many_elements_raise(client):
    for name in ("one", "two"):
        client.query(
            "INSERT Item { name := <str>$name, count := <int32>$count }",
            name=f"many-{name}-{uuid.uuid4()}",
            count=10,
        )
    # The client re-raises the server's ResultCardinalityMismatchError as an
    # InterfaceError naming the method, the server's as its cause.
    for query in (client.query_single, client.query_single_json):
        for text in ("SELECT Item { name }", "SELECT {1, 2}"):
            with pytest.raises(gel.InterfaceError) as raised:
                query(text)
            assert isinstance(raised.value.__cause__, gel.ResultCardinalityMismatchError)
    with pytest.raises(gel.NoDataError):
        client.query_required_single(
            "SELECT Item { name } FILTER .name = 'nobody' LIMIT 1"
        )
