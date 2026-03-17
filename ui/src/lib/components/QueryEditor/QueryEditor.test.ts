import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import QueryEditor from "./QueryEditor.svelte";

describe("QueryEditor", () => {
  const mockOnExecute = vi.fn();

  beforeEach(() => {
    mockOnExecute.mockClear();
  });

  it("renders editor with initial value", () => {
    const initialQuery = "SELECT User { name, email }";
    render(QueryEditor, {
      value: initialQuery,
      onExecute: mockOnExecute,
    });

    // Editor should be present
    const editor = document.querySelector(".query-editor");
    expect(editor).toBeInTheDocument();
  });

  it("shows execute button", () => {
    render(QueryEditor, { onExecute: mockOnExecute });

    const executeBtn = screen.getByRole("button", { name: /execute/i });
    expect(executeBtn).toBeInTheDocument();
  });

  it("executes query on button click", async () => {
    const query = "SELECT User { name }";
    render(QueryEditor, {
      value: query,
      onExecute: mockOnExecute,
    });

    const executeBtn = screen.getByRole("button", { name: /execute/i });
    await fireEvent.click(executeBtn);

    expect(mockOnExecute).toHaveBeenCalledWith(query);
  });

  it("executes query with keyboard shortcut (Cmd/Ctrl+Enter)", async () => {
    const query = "SELECT Post { title }";
    const { container } = render(QueryEditor, {
      value: query,
      onExecute: mockOnExecute,
    });

    // Simulate Cmd+Enter
    const editorElement = container.querySelector(".cm-editor");
    await fireEvent.keyDown(editorElement, {
      key: "Enter",
      metaKey: true,
    });

    expect(mockOnExecute).toHaveBeenCalledWith(query);
  });

  it("shows loading state during execution", async () => {
    render(QueryEditor, {
      onExecute: mockOnExecute,
      loading: true,
    });

    const executeBtn = screen.getByRole("button");
    expect(executeBtn).toHaveAttribute("disabled");
    expect(executeBtn).toHaveTextContent("Executing...");
  });

  it("displays error message", () => {
    const errorMessage = "Syntax error at line 1";
    render(QueryEditor, {
      onExecute: mockOnExecute,
      error: errorMessage,
    });

    expect(screen.getByText(errorMessage)).toBeInTheDocument();
    expect(screen.getByText(errorMessage).closest(".error-message"))
      .toHaveClass("error-message");
  });

  it("shows query history panel", async () => {
    const history = [
      { query: "SELECT User { name }", timestamp: new Date(), success: true },
      { query: "SELECT Post { title }", timestamp: new Date(), success: false },
    ];

    render(QueryEditor, {
      onExecute: mockOnExecute,
      showHistory: true,
      history,
    });

    expect(screen.getByText("Query History")).toBeInTheDocument();
    expect(screen.getByText("SELECT User { name }")).toBeInTheDocument();
    expect(screen.getByText("SELECT Post { title }")).toBeInTheDocument();
  });

  it("loads query from history on click", async () => {
    const history = [
      { query: "SELECT User { name }", timestamp: new Date(), success: true },
    ];

    let currentValue = "";
    const { component } = render(QueryEditor, {
      onExecute: mockOnExecute,
      showHistory: true,
      history,
      onChange: (val) => {
        currentValue = val;
      },
    });

    const historyItem = screen.getByText("SELECT User { name }");
    await fireEvent.click(historyItem);

    expect(currentValue).toBe("SELECT User { name }");
  });

  it("provides auto-complete suggestions", async () => {
    const suggestions = ["User", "Post", "Comment"];

    render(QueryEditor, {
      onExecute: mockOnExecute,
      autoComplete: true,
      suggestions,
    });

    // Type to trigger autocomplete
    const editor = document.querySelector(".cm-content");
    await fireEvent.input(editor, { target: { value: "SELECT U" } });

    await waitFor(() => {
      expect(document.querySelector(".cm-autocomplete")).toBeInTheDocument();
      expect(screen.getByText("User")).toBeInTheDocument();
    });
  });

  it("formats query on format button click", async () => {
    const unformattedQuery = 'select User{name,email}filter.name="John"';
    const formattedQuery = `select User {
  name,
  email
}
filter .name = "John"`;

    let currentValue = unformattedQuery;

    render(QueryEditor, {
      value: currentValue,
      onExecute: mockOnExecute,
      onChange: (val) => {
        currentValue = val;
      },
      onFormat: () => formattedQuery,
    });

    const formatBtn = screen.getByRole("button", { name: /format/i });
    await fireEvent.click(formatBtn);

    expect(currentValue).toBe(formattedQuery);
  });

  it("shows execution time for results", () => {
    render(QueryEditor, {
      onExecute: mockOnExecute,
      executionTime: 245,
    });

    expect(screen.getByText("Executed in 245ms")).toBeInTheDocument();
  });

  it("supports multiple query tabs", async () => {
    render(QueryEditor, {
      onExecute: mockOnExecute,
      multiTab: true,
    });

    // Should show initial tab
    expect(screen.getByText("Query 1")).toBeInTheDocument();

    // Add new tab button
    const addTabBtn = screen.getByRole("button", { name: /new tab/i });
    await fireEvent.click(addTabBtn);

    expect(screen.getByText("Query 2")).toBeInTheDocument();
  });
});
