import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import SchemaTree from "./SchemaTree.svelte";

describe("SchemaTree", () => {
  const mockSchema = {
    modules: [
      {
        name: "default",
        types: [
          {
            name: "User",
            properties: [
              { name: "id", type: "uuid", required: true },
              {
                name: "email",
                type: "str",
                required: true,
                constraint: "exclusive",
              },
              { name: "name", type: "str", required: true },
              {
                name: "created_at",
                type: "datetime",
                default: "datetime_current()",
              },
            ],
            links: [
              { name: "posts", target: "Post", cardinality: "many" },
            ],
          },
          {
            name: "Post",
            properties: [
              { name: "id", type: "uuid", required: true },
              { name: "title", type: "str", required: true },
              { name: "body", type: "str", required: true },
              {
                name: "created_at",
                type: "datetime",
                default: "datetime_current()",
              },
            ],
            links: [
              {
                name: "author",
                target: "User",
                cardinality: "one",
                required: true,
              },
            ],
          },
        ],
      },
    ],
  };

  it("renders module names", () => {
    render(SchemaTree, { schema: mockSchema });
    expect(screen.getByText("default")).toBeInTheDocument();
  });

  it("renders type names", () => {
    render(SchemaTree, { schema: mockSchema });
    expect(screen.getByText("User")).toBeInTheDocument();
    expect(screen.getByText("Post")).toBeInTheDocument();
  });

  it("expands and collapses types", async () => {
    render(SchemaTree, { schema: mockSchema });

    const userType = screen.getByText("User");

    // Properties should not be visible initially
    expect(screen.queryByText("email")).not.toBeInTheDocument();

    // Click to expand
    await fireEvent.click(userType);

    // Properties should now be visible
    expect(screen.getByText("email")).toBeInTheDocument();
    expect(screen.getByText("name")).toBeInTheDocument();

    // Click to collapse
    await fireEvent.click(userType);

    // Properties should be hidden again
    expect(screen.queryByText("email")).not.toBeInTheDocument();
  });

  it("displays property details correctly", async () => {
    render(SchemaTree, { schema: mockSchema });

    const userType = screen.getByText("User");
    await fireEvent.click(userType);

    // Check property type and constraints
    const emailProp = screen.getByText("email").closest(".property-item");
    expect(emailProp).toHaveTextContent("str");
    expect(emailProp).toHaveTextContent("required");
    expect(emailProp).toHaveTextContent("exclusive");
  });

  it("displays links correctly", async () => {
    render(SchemaTree, { schema: mockSchema });

    const userType = screen.getByText("User");
    await fireEvent.click(userType);

    const postsLink = screen.getByText("posts").closest(".link-item");
    expect(postsLink).toHaveTextContent("Post");
    expect(postsLink).toHaveTextContent("many");
  });

  it("highlights selected type", async () => {
    const { component } = render(SchemaTree, {
      schema: mockSchema,
      onTypeSelect: () => {},
    });

    const userType = screen.getByText("User");
    await fireEvent.click(userType);

    expect(userType.closest(".type-node")).toHaveClass("selected");
  });

  it("emits type selection event", async () => {
    let selectedType = null;

    render(SchemaTree, {
      schema: mockSchema,
      onTypeSelect: (type) => {
        selectedType = type;
      },
    });

    const userType = screen.getByText("User");
    await fireEvent.click(userType);

    expect(selectedType).toEqual(mockSchema.modules[0].types[0]);
  });

  it("displays search filter", async () => {
    render(SchemaTree, { schema: mockSchema, searchable: true });

    const searchInput = screen.getByPlaceholderText("Search types...");
    expect(searchInput).toBeInTheDocument();

    // Type in search
    await fireEvent.input(searchInput, { target: { value: "User" } });

    // User should be visible, Post should be hidden
    expect(screen.getByText("User")).toBeInTheDocument();
    expect(screen.queryByText("Post")).not.toBeInTheDocument();
  });
});
