import { describe, expect, it, vi } from "vitest";
import { ProcessesService } from "../packages/nav2/modules/processes/service/impl/ProcessesService";
import type { Nav2IncomingMessage } from "../packages/nav2/protocol/messages";

describe("processes service", () => {
  it("loads process catalog on open", async () => {
    const subscribers: {
      processExecutorState?: (message: Nav2IncomingMessage) => void;
      processFinished?: (message: Nav2IncomingMessage) => void;
      processOutput?: (message: Nav2IncomingMessage) => void;
    } = {};
    const dispatcher = {
      requestProcesses: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "process_executor_state",
        ok: true,
        process_list: [
          {
            label: "healthcheck",
            command: "./tools/healthcheck-lidar.sh",
            cwd: "/ros2_ws",
            running: false
          }
        ] as never
      }),
      reloadProcesses: vi.fn(),
      startProcess: vi.fn(),
      stopProcess: vi.fn(),
      subscribeProcessExecutorState: vi.fn((callback: (message: Nav2IncomingMessage) => void) => {
        subscribers.processExecutorState = callback;
        return () => undefined;
      }),
      subscribeProcessFinished: vi.fn((callback: (message: Nav2IncomingMessage) => void) => {
        subscribers.processFinished = callback;
        return () => undefined;
      }),
      subscribeProcessOutput: vi.fn((callback: (message: Nav2IncomingMessage) => void) => {
        subscribers.processOutput = callback;
        return () => undefined;
      })
    };
    const eventBus = { emit: vi.fn() };
    const service = new ProcessesService(dispatcher as never, eventBus as never);

    await service.open();

    const state = service.getState();
    expect(state.selectedProcess).toBe("healthcheck");
    expect(state.processes).toEqual([
      expect.objectContaining({
        label: "healthcheck",
        command: "./tools/healthcheck-lidar.sh",
        cwd: "/ros2_ws",
        running: false,
        status: "idle",
        outputEnabled: true,
        stdoutText: "",
        stderrText: ""
      })
    ]);
  });

  it("refreshes process catalog after reload_processes", async () => {
    const dispatcher = {
      requestProcesses: vi.fn<() => Promise<Nav2IncomingMessage>>()
        .mockResolvedValueOnce({
          op: "process_executor_state",
          ok: true,
          process_list: [{ label: "first", command: "echo 1", cwd: "/tmp", running: false }] as never
        })
        .mockResolvedValueOnce({
          op: "process_executor_state",
          ok: true,
          process_list: [{ label: "second", command: "echo 2", cwd: "/tmp", running: false }] as never
        }),
      reloadProcesses: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        request: "reload_processes",
        ok: true
      }),
      startProcess: vi.fn(),
      stopProcess: vi.fn(),
      subscribeProcessExecutorState: vi.fn(() => () => undefined),
      subscribeProcessFinished: vi.fn(() => () => undefined),
      subscribeProcessOutput: vi.fn(() => () => undefined)
    };
    const service = new ProcessesService(dispatcher as never, { emit: vi.fn(), on: vi.fn() } as never);

    await service.open();
    await service.refresh();

    expect(dispatcher.reloadProcesses).toHaveBeenCalledTimes(1);
    expect(dispatcher.requestProcesses).toHaveBeenCalledTimes(2);
    expect(service.getState().processes[0]?.label).toBe("second");
  });

  it("starts process with configured output flag and stores matching output", async () => {
    const subscribers: {
      processOutput?: (message: Nav2IncomingMessage) => void;
    } = {};
    const dispatcher = {
      requestProcesses: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "process_executor_state",
        ok: true,
        process_list: [{ label: "healthcheck", command: "run", cwd: "/ros2_ws", running: false }] as never
      }),
      reloadProcesses: vi.fn(),
      startProcess: vi.fn<(process: string, output: boolean) => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        request: "start_process",
        ok: true,
        requestId: "req-125"
      }),
      stopProcess: vi.fn(),
      subscribeProcessExecutorState: vi.fn(() => () => undefined),
      subscribeProcessFinished: vi.fn(() => () => undefined),
      subscribeProcessOutput: vi.fn((callback: (message: Nav2IncomingMessage) => void) => {
        subscribers.processOutput = callback;
        return () => undefined;
      })
    };
    const eventBus = { emit: vi.fn(), on: vi.fn() };
    const service = new ProcessesService(dispatcher as never, eventBus as never);

    await service.open();
    service.setOutputEnabled("healthcheck", true);
    await service.startProcess("healthcheck");
    subscribers.processOutput?.({
      op: "process_output",
      process: "healthcheck",
      stream: "stdout",
      data: "LiDAR OK\n",
      requestId: "req-125"
    });
    subscribers.processOutput?.({
      op: "process_output",
      process: "healthcheck",
      stream: "stderr",
      data: "ignored\n",
      requestId: "req-999"
    });

    expect(dispatcher.startProcess).toHaveBeenCalledWith("healthcheck", true);
    expect(service.getState().processes[0]?.stdoutText).toBe("LiDAR OK\n");
    expect(service.getState().processes[0]?.stderrText).toBe("");
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it("marks process as error on failed ack and keeps output after process_finished", async () => {
    const subscribers: {
      processFinished?: (message: Nav2IncomingMessage) => void;
      processExecutorState?: (message: Nav2IncomingMessage) => void;
      processOutput?: (message: Nav2IncomingMessage) => void;
    } = {};
    const dispatcher = {
      requestProcesses: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "process_executor_state",
        ok: true,
        process_list: [{ label: "healthcheck", command: "run", cwd: "/ros2_ws", running: false }] as never
      }),
      reloadProcesses: vi.fn(),
      startProcess: vi.fn<() => Promise<Nav2IncomingMessage>>()
        .mockResolvedValueOnce({
          op: "ack",
          request: "start_process",
          ok: false,
          error: "process already running: healthcheck",
          requestId: "req-1"
        })
        .mockResolvedValueOnce({
          op: "ack",
          request: "start_process",
          ok: true,
          requestId: "req-2"
        }),
      stopProcess: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        request: "stop_process",
        ok: true,
        requestId: "req-3"
      }),
      subscribeProcessExecutorState: vi.fn((callback: (message: Nav2IncomingMessage) => void) => {
        subscribers.processExecutorState = callback;
        return () => undefined;
      }),
      subscribeProcessFinished: vi.fn((callback: (message: Nav2IncomingMessage) => void) => {
        subscribers.processFinished = callback;
        return () => undefined;
      }),
      subscribeProcessOutput: vi.fn((callback: (message: Nav2IncomingMessage) => void) => {
        subscribers.processOutput = callback;
        return () => undefined;
      })
    };
    const service = new ProcessesService(dispatcher as never, { emit: vi.fn(), on: vi.fn() } as never);

    await service.open();
    await expect(service.startProcess("healthcheck")).rejects.toThrow("process already running: healthcheck");
    expect(service.getState().processes[0]?.status).toBe("error");

    service.setOutputEnabled("healthcheck", true);
    await service.startProcess("healthcheck");
    subscribers.processExecutorState?.({
      op: "process_executor_state",
      process_list: [{ label: "healthcheck", command: "run", cwd: "/ros2_ws", running: true }] as never
    });
    subscribers.processOutput?.({
      op: "process_output",
      process: "healthcheck",
      stream: "stderr",
      data: "process exited with code 7\n",
      requestId: "req-2"
    });
    expect(service.getState().processes[0]?.status).toBe("running");

    subscribers.processFinished?.({
      op: "process_finished",
      process: "healthcheck",
      ok: false,
      error: "process exited with code 7",
      requestId: "req-2"
    });

    const state = service.getState();
    expect(state.processes[0]).toEqual(
      expect.objectContaining({
        status: "error",
        running: false,
        lastError: "process exited with code 7",
        stdoutText: "",
        stderrText: "process exited with code 7\n"
      })
    );
  });

  it("clears previous output on new process run", async () => {
    const subscribers: {
      processFinished?: (message: Nav2IncomingMessage) => void;
      processOutput?: (message: Nav2IncomingMessage) => void;
    } = {};
    const dispatcher = {
      requestProcesses: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "process_executor_state",
        ok: true,
        process_list: [{ label: "healthcheck", command: "run", cwd: "/ros2_ws", running: false }] as never
      }),
      reloadProcesses: vi.fn(),
      startProcess: vi.fn<() => Promise<Nav2IncomingMessage>>()
        .mockResolvedValueOnce({
          op: "ack",
          request: "start_process",
          ok: true,
          requestId: "req-1"
        })
        .mockResolvedValueOnce({
          op: "ack",
          request: "start_process",
          ok: true,
          requestId: "req-2"
        }),
      stopProcess: vi.fn(),
      subscribeProcessExecutorState: vi.fn(() => () => undefined),
      subscribeProcessFinished: vi.fn((callback: (message: Nav2IncomingMessage) => void) => {
        subscribers.processFinished = callback;
        return () => undefined;
      }),
      subscribeProcessOutput: vi.fn((callback: (message: Nav2IncomingMessage) => void) => {
        subscribers.processOutput = callback;
        return () => undefined;
      })
    };
    const service = new ProcessesService(dispatcher as never, { emit: vi.fn(), on: vi.fn() } as never);

    await service.open();
    service.setOutputEnabled("healthcheck", true);
    await service.startProcess("healthcheck");
    subscribers.processOutput?.({
      op: "process_output",
      process: "healthcheck",
      stream: "stdout",
      data: "old\n",
      requestId: "req-1"
    });
    subscribers.processFinished?.({
      op: "process_finished",
      process: "healthcheck",
      ok: true,
      requestId: "req-1"
    });

    await service.startProcess("healthcheck");

    expect(service.getState().processes[0]?.stdoutText).toBe("");
    expect(service.getState().processes[0]?.stderrText).toBe("");
  });

  it("stops running process", async () => {
    const dispatcher = {
      requestProcesses: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "process_executor_state",
        ok: true,
        process_list: [{ label: "healthcheck", command: "run", cwd: "/ros2_ws", running: true }] as never
      }),
      reloadProcesses: vi.fn(),
      startProcess: vi.fn(),
      stopProcess: vi.fn<() => Promise<Nav2IncomingMessage>>().mockResolvedValue({
        op: "ack",
        request: "stop_process",
        ok: true,
        requestId: "req-stop"
      }),
      subscribeProcessExecutorState: vi.fn(() => () => undefined),
      subscribeProcessFinished: vi.fn(() => () => undefined),
      subscribeProcessOutput: vi.fn(() => () => undefined)
    };
    const service = new ProcessesService(dispatcher as never, { emit: vi.fn(), on: vi.fn() } as never);

    await service.open();
    await service.stopProcess("healthcheck");

    expect(dispatcher.stopProcess).toHaveBeenCalledWith("healthcheck");
  });
});
