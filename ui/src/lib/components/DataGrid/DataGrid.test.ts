import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import DataGrid from "./DataGrid.svelte";

describe("DataGrid", () => {
  const mockData = [
    {
      id: "1",
      name: "John Doe",
      email: "john@example.com",
      created_at: "2024-01-01",
    },
    {
      id: "2",
      name: "Jane Smith",
      email: "jane@example.com",
      created_at: "2024-01-02",
    },
    {
      id: "3",
      name: "Bob Johnson",
      email: "bob@example.com",
      created_at: "2024-01-03",
    },
  ];

  const mockColumns = [
    { key: "id", label: "ID", sortable: false },
    { key: "name", label: "Name", sortable: true },
    { key: "email", label: "Email", sortable: true },
    { key: "created_at", label: "Created", sortable: true, type: "date" },
  ];

  it("renders data in grid format", () => {
    render(DataGrid, { data: mockData, columns: mockColumns });

    // Headers
    expect(screen.getByText("ID")).toBeInTheDocument();
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Email")).toBeInTheDocument();

    // Data
    expect(screen.getByText("John Doe")).toBeInTheDocument();
    expect(screen.getByText("jane@example.com")).toBeInTheDocument();
  });

  it("sorts data when clicking sortable column", async () => {
    render(DataGrid, { data: mockData, columns: mockColumns });

    const nameHeader = screen.getByText("Name");
    await fireEvent.click(nameHeader);

    // Check if data is sorted
    const cells = screen.getAllByRole("cell");
    const names = cells.filter((_, i) => i % 4 === 1).map((c) => c.textContent);
    expect(names).toEqual(["Bob Johnson", "Jane Smith", "John Doe"]);

    // Click again for reverse sort
    await fireEvent.click(nameHeader);
    const reversedNames = cells.filter((_, i) => i % 4 === 1).map((c) =>
      c.textContent
    );
    expect(reversedNames).toEqual(["John Doe", "Jane Smith", "Bob Johnson"]);
  });

  it("supports row selection", async () => {
    const onSelect = vi.fn();
    render(DataGrid, {
      data: mockData,
      columns: mockColumns,
      selectable: true,
      onSelect,
    });

    const checkboxes = screen.getAllByRole("checkbox");
    await fireEvent.click(checkboxes[1]); // First data row checkbox

    expect(onSelect).toHaveBeenCalledWith([mockData[0]]);
  });

  it("supports select all functionality", async () => {
    const onSelect = vi.fn();
    render(DataGrid, {
      data: mockData,
      columns: mockColumns,
      selectable: true,
      onSelect,
    });

    const selectAllCheckbox = screen.getAllByRole("checkbox")[0];
    await fireEvent.click(selectAllCheckbox);

    expect(onSelect).toHaveBeenCalledWith(mockData);
  });

  it("enables inline editing when editable", async () => {
    const onEdit = vi.fn();
    render(DataGrid, {
      data: mockData,
      columns: mockColumns,
      editable: true,
      onEdit,
    });

    const nameCell = screen.getByText("John Doe");
    await fireEvent.dblClick(nameCell);

    // Cell should become editable
    const input = screen.getByDisplayValue("John Doe");
    expect(input).toBeInTheDocument();

    // Change value
    await fireEvent.input(input, { target: { value: "John Updated" } });
    await fireEvent.keyDown(input, { key: "Enter" });

    expect(onEdit).toHaveBeenCalledWith({
      row: mockData[0],
      field: "name",
      value: "John Updated",
    });
  });

  it("shows pagination controls", () => {
    const largeMockData = Array.from({ length: 50 }, (_, i) => ({
      id: String(i + 1),
      name: `User ${i + 1}`,
      email: `user${i + 1}@example.com`,
    }));

    render(DataGrid, {
      data: largeMockData,
      columns: mockColumns.slice(0, 3),
      paginated: true,
      pageSize: 10,
    });

    expect(screen.getByText("Page 1 of 5")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /previous/i }))
      .toBeInTheDocument();
  });

  it("navigates through pages", async () => {
    const largeMockData = Array.from({ length: 25 }, (_, i) => ({
      id: String(i + 1),
      name: `User ${i + 1}`,
      email: `user${i + 1}@example.com`,
    }));

    render(DataGrid, {
      data: largeMockData,
      columns: mockColumns.slice(0, 3),
      paginated: true,
      pageSize: 10,
    });

    // Initially shows first 10 items
    expect(screen.getByText("User 1")).toBeInTheDocument();
    expect(screen.queryByText("User 11")).not.toBeInTheDocument();

    // Go to next page
    const nextBtn = screen.getByRole("button", { name: /next/i });
    await fireEvent.click(nextBtn);

    expect(screen.queryByText("User 1")).not.toBeInTheDocument();
    expect(screen.getByText("User 11")).toBeInTheDocument();
    expect(screen.getByText("Page 2 of 3")).toBeInTheDocument();
  });

  it("filters data based on search input", async () => {
    render(DataGrid, {
      data: mockData,
      columns: mockColumns,
      searchable: true,
    });

    const searchInput = screen.getByPlaceholderText(/search/i);
    await fireEvent.input(searchInput, { target: { value: "jane" } });

    expect(screen.getByText("Jane Smith")).toBeInTheDocument();
    expect(screen.queryByText("John Doe")).not.toBeInTheDocument();
    expect(screen.queryByText("Bob Johnson")).not.toBeInTheDocument();
  });

  it("exports data when export button is clicked", async () => {
    const onExport = vi.fn();
    render(DataGrid, {
      data: mockData,
      columns: mockColumns,
      exportable: true,
      onExport,
    });

    const exportBtn = screen.getByRole("button", { name: /export/i });
    await fireEvent.click(exportBtn);

    expect(onExport).toHaveBeenCalledWith(mockData);
  });

  it("shows loading state", () => {
    render(DataGrid, {
      data: [],
      columns: mockColumns,
      loading: true,
    });

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows empty state when no data", () => {
    render(DataGrid, {
      data: [],
      columns: mockColumns,
      emptyMessage: "No records found",
    });

    expect(screen.getByText("No records found")).toBeInTheDocument();
  });

  it("highlights row on hover", async () => {
    const { container } = render(DataGrid, {
      data: mockData,
      columns: mockColumns,
      hoverable: true,
    });

    const firstRow = container.querySelector("tbody tr");
    await fireEvent.mouseEnter(firstRow);

    expect(firstRow).toHaveClass("hover");
  });

  it("supports custom cell rendering", () => {
    const columnsWithRenderer = [
      ...mockColumns,
      {
        key: "actions",
        label: "Actions",
        sortable: false,
        render: (_value, row) => `Edit ${row.id}`,
      },
    ];

    render(DataGrid, {
      data: mockData,
      columns: columnsWithRenderer,
    });

    expect(screen.getByText("Edit 1")).toBeInTheDocument();
    expect(screen.getByText("Edit 2")).toBeInTheDocument();
  });
});
