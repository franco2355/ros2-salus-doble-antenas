import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProcessesModal } from "../packages/nav2/modules/processes/frontend";
import type { ProcessesState } from "../packages/nav2/modules/processes/service/impl/ProcessesService";

class FakeProcessesService {
  private readonly listeners = new Set<(state: ProcessesState) => void>();

  constructor(private state: ProcessesState) {}

  getState(): ProcessesState {
    return {
      ...this.state,
      processes: this.state.processes.map((entry) => ({ ...entry }))
    };
  }

  subscribe(listener: (state: ProcessesState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  async open(): Promise<void> {
    return undefined;
  }

  close(): void {
    return;
  }

  async refresh(): Promise<void> {
    return undefined;
  }

  selectProcess(label: string): void {
    this.state = {
      ...this.state,
      selectedProcess: label
    };
    this.emit();
  }

  setSearch(value: string): void {
    this.state = {
      ...this.state,
      search: value
    };
    this.emit();
  }

  setOutputEnabled(label: string, enabled: boolean): void {
    this.state = {
      ...this.state,
      processes: this.state.processes.map((entry) =>
        entry.label === label
          ? {
              ...entry,
              outputEnabled: enabled
            }
          : entry
      )
    };
    this.emit();
  }

  async startProcess(): Promise<void> {
    return undefined;
  }

  async stopProcess(): Promise<void> {
    return undefined;
  }

  patchProcess(label: string, patch: Partial<ProcessesState["processes"][number]>): void {
    this.state = {
      ...this.state,
      processes: this.state.processes.map((entry) =>
        entry.label === label
          ? {
              ...entry,
              ...patch
            }
          : entry
      )
    };
    this.emit();
  }

  private emit(): void {
    const snapshot = this.getState();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}

function createRuntime(state: ProcessesState) {
  const processesService = new FakeProcessesService(state);
  const connectionSnapshot = {
    connected: true,
    lastError: "",
    connecting: false,
    preset: "real",
    host: "",
    port: "",
    txBytes: 0,
    rxBytes: 0
  };
  const connectionService: {
    getState: () => typeof connectionSnapshot;
    subscribe: (listener: (state: typeof connectionSnapshot) => void) => () => void;
  } = {
    getState: () => ({ connected: true, lastError: "", connecting: false, preset: "real", host: "", port: "", txBytes: 0, rxBytes: 0 }),
    subscribe: (listener: (state: ReturnType<typeof connectionService.getState>) => void) => {
      listener(connectionService.getState());
      return () => undefined;
    }
  };
  const eventBus = { emit: vi.fn() };

  return {
    processesService,
    services: {
      getService<T>(serviceId: string): T {
        if (serviceId === "service.processes") return processesService as T;
        if (serviceId === "service.connection") return connectionService as T;
        throw new Error(`Service not found: ${serviceId}`);
      }
    },
    eventBus
  };
}

describe("ProcessesModal", () => {
  it("renders details and output placeholder", async () => {
    const runtime = createRuntime({
      open: true,
      loading: false,
      error: "",
      search: "",
      selectedProcess: "healthcheck",
      processes: [
        {
          label: "healthcheck",
          command: "./tools/healthcheck-lidar.sh",
          cwd: "/ros2_ws",
          running: false,
          status: "idle",
          lastError: "",
          outputEnabled: false,
          lastRequestId: "",
          stdoutText: "",
          stderrText: ""
        }
      ]
    });

    render(<ProcessesModal runtime={runtime as never} />);

    expect(screen.getByRole("button", { name: "stdout" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "stderr" })).toBeInTheDocument();
    expect(screen.getByText("Sin output.")).toBeInTheDocument();
    expect(screen.getByText("CWD:")).toBeInTheDocument();
    expect(screen.getByText("Process:")).toBeInTheDocument();
    expect(screen.getAllByText("/ros2_ws")).toHaveLength(1);
    expect(screen.queryByText("Sin detalles")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy" })).toBeDisabled();
    const searchInput = screen.getByPlaceholderText("Buscar proceso...");
    expect(searchInput.parentElement).toContainElement(screen.getByRole("button", { name: "Reload" }));
  });

  it("copies selected output buffer without ansi escapes", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText },
      configurable: true
    });

    const runtime = createRuntime({
      open: true,
      loading: false,
      error: "",
      search: "",
      selectedProcess: "healthcheck",
      processes: [
        {
          label: "healthcheck",
          command: "./tools/healthcheck-lidar.sh",
          cwd: "/ros2_ws",
          running: false,
          status: "success",
          lastError: "",
          outputEnabled: true,
          lastRequestId: "req-1",
          stdoutText: "\u001b[32mLiDAR OK\u001b[0m\n",
          stderrText: "\u001b[31mwarning\u001b[0m\n"
        }
      ]
    });

    render(<ProcessesModal runtime={runtime as never} />);

    expect(screen.queryByText("\u001b[31mwarning\u001b[0m")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "stderr" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("warning\n");
    });
    expect(screen.getByText("warning")).toHaveStyle({ color: "#cf222e" });
    expect(runtime.eventBus.emit).toHaveBeenCalledWith(
      "console.event",
      expect.objectContaining({
        level: "info",
        text: "Output copiado: healthcheck (stderr)"
      })
    );
  });

  it("sigue final si usuario estaba cerca de fondo", async () => {
    const runtime = createRuntime({
      open: true,
      loading: false,
      error: "",
      search: "",
      selectedProcess: "healthcheck",
      processes: [
        {
          label: "healthcheck",
          command: "./tools/healthcheck-lidar.sh",
          cwd: "/ros2_ws",
          running: false,
          status: "success",
          lastError: "",
          outputEnabled: true,
          lastRequestId: "req-1",
          stdoutText: "old\n",
          stderrText: ""
        }
      ]
    });

    render(<ProcessesModal runtime={runtime as never} />);

    const viewport = screen.getByTestId("process-output-scroll");
    let scrollTopValue = 76;
    let scrollHeightValue = 200;
    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      get: () => 100
    });
    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      get: () => scrollHeightValue
    });
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      }
    });

    fireEvent.scroll(viewport);
    scrollHeightValue = 260;
    await act(async () => {
      runtime.processesService.patchProcess("healthcheck", {
        stdoutText: "old\nnew\n"
      });
    });

    await waitFor(() => {
      expect(scrollTopValue).toBe(260);
    });
  });

  it("no mueve scroll si usuario subio", async () => {
    const runtime = createRuntime({
      open: true,
      loading: false,
      error: "",
      search: "",
      selectedProcess: "healthcheck",
      processes: [
        {
          label: "healthcheck",
          command: "./tools/healthcheck-lidar.sh",
          cwd: "/ros2_ws",
          running: false,
          status: "success",
          lastError: "",
          outputEnabled: true,
          lastRequestId: "req-1",
          stdoutText: "old\n",
          stderrText: ""
        }
      ]
    });

    render(<ProcessesModal runtime={runtime as never} />);

    const viewport = screen.getByTestId("process-output-scroll");
    let scrollTopValue = 10;
    let scrollHeightValue = 200;
    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      get: () => 100
    });
    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      get: () => scrollHeightValue
    });
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollTopValue = value;
      }
    });

    fireEvent.scroll(viewport);
    scrollHeightValue = 260;
    await act(async () => {
      runtime.processesService.patchProcess("healthcheck", {
        stdoutText: "old\nnew\n"
      });
    });

    await waitFor(() => {
      expect(viewport.textContent).toContain("old\nnew\n");
    });
    expect(scrollTopValue).toBe(10);
  });
});
