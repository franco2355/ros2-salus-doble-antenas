import type { EventBus } from "../../../../../../core/events/eventBus";
import type { Nav2IncomingMessage } from "../../../../protocol/messages";
import type { ProcessesDispatcher } from "../../dispatcher/impl/ProcessesDispatcher";

export interface ProcessDefinition {
  label: string;
  command: string;
  cwd: string;
  running: boolean;
}

export type ProcessStatus = "idle" | "running" | "success" | "error";
export type ProcessOutputStream = "stdout" | "stderr";

export interface ProcessViewState extends ProcessDefinition {
  status: ProcessStatus;
  lastError: string;
  outputEnabled: boolean;
  lastRequestId: string;
  stdoutText: string;
  stderrText: string;
}

export interface ProcessesState {
  open: boolean;
  loading: boolean;
  error: string;
  search: string;
  selectedProcess: string;
  processes: ProcessViewState[];
}

type Listener = (state: ProcessesState) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProcessDefinition(raw: unknown): ProcessDefinition | null {
  if (!isRecord(raw)) return null;
  const label = String(raw.label ?? "").trim();
  if (!label) return null;
  return {
    label,
    command: String(raw.command ?? "").trim(),
    cwd: String(raw.cwd ?? "").trim(),
    running: raw.running === true
  };
}

function parseProcessList(message: Nav2IncomingMessage): ProcessDefinition[] {
  const direct = Array.isArray(message.process_list) ? message.process_list : [];
  const payload = isRecord(message.payload) ? message.payload : null;
  const nested = payload && Array.isArray(payload.process_list) ? payload.process_list : [];
  const source = nested.length > 0 || direct.length === 0 ? nested : direct;
  return source.map((entry) => parseProcessDefinition(entry)).filter((entry): entry is ProcessDefinition => entry !== null);
}

export class ProcessesService {
  private readonly listeners = new Set<Listener>();
  private state: ProcessesState = {
    open: false,
    loading: false,
    error: "",
    search: "",
    selectedProcess: "",
    processes: []
  };

  constructor(
    private readonly dispatcher: ProcessesDispatcher,
    private readonly eventBus: EventBus
  ) {
    this.dispatcher.subscribeProcessExecutorState((message) => {
      this.applyProcessExecutorState(message);
    });
    this.dispatcher.subscribeProcessFinished((message) => {
      this.applyProcessFinished(message);
    });
    this.dispatcher.subscribeProcessOutput((message) => {
      this.applyProcessOutput(message);
    });
  }

  getState(): ProcessesState {
    return {
      ...this.state,
      processes: this.state.processes.map((entry) => ({ ...entry }))
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  async open(): Promise<void> {
    this.state = {
      ...this.state,
      open: true
    };
    this.emit();
    await this.loadProcesses();
  }

  close(): void {
    this.state = {
      ...this.state,
      open: false,
      loading: false
    };
    this.emit();
  }

  async refresh(): Promise<void> {
    this.state = {
      ...this.state,
      loading: true,
      error: ""
    };
    this.emit();
    const response = await this.dispatcher.reloadProcesses();
    if (response.ok === false) {
      const message = String(response.error ?? "reload_processes failed");
      this.state = {
        ...this.state,
        loading: false,
        error: message
      };
      this.emit();
      throw new Error(message);
    }
    await this.loadProcesses();
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
        entry.label === label && !entry.running
          ? {
              ...entry,
              outputEnabled: enabled
            }
          : entry
      )
    };
    this.emit();
  }

  async startSelectedProcess(): Promise<void> {
    const label = this.state.selectedProcess.trim();
    if (!label) {
      throw new Error("No process selected");
    }
    await this.startProcess(label);
  }

  async startProcess(label: string): Promise<void> {
    const process = this.state.processes.find((entry) => entry.label === label);
    if (!process) {
      throw new Error(`Unknown process: ${label}`);
    }
    if (process.running) {
      throw new Error(`process already running: ${label}`);
    }

    const response = await this.dispatcher.startProcess(label, process.outputEnabled);
    if (response.ok === false) {
      const message = String(response.error ?? `start_process failed: ${label}`);
      this.setProcessState(label, {
        status: "error",
        lastError: message,
        running: false,
        lastRequestId: String(response.requestId ?? "")
      });
      this.state = {
        ...this.state,
        error: message
      };
      this.emit();
      throw new Error(message);
    }

    this.setProcessState(label, {
      status: "running",
      lastError: "",
      running: true,
      lastRequestId: String(response.requestId ?? ""),
      stdoutText: "",
      stderrText: ""
    });
    this.state = {
      ...this.state,
      error: ""
    };
    this.emit();
  }

  async stopSelectedProcess(): Promise<void> {
    const label = this.state.selectedProcess.trim();
    if (!label) {
      throw new Error("No process selected");
    }
    await this.stopProcess(label);
  }

  async stopProcess(label: string): Promise<void> {
    const process = this.state.processes.find((entry) => entry.label === label);
    if (!process) {
      throw new Error(`Unknown process: ${label}`);
    }
    if (!process.running) {
      throw new Error(`process is not running: ${label}`);
    }

    const response = await this.dispatcher.stopProcess(label);
    if (response.ok === false) {
      const message = String(response.error ?? `stop_process failed: ${label}`);
      this.setProcessState(label, {
        status: "error",
        lastError: message,
        lastRequestId: String(response.requestId ?? "")
      });
      this.state = {
        ...this.state,
        error: message
      };
      this.emit();
      throw new Error(message);
    }

    this.state = {
      ...this.state,
      error: ""
    };
    this.emit();
  }

  private async loadProcesses(): Promise<void> {
    this.state = {
      ...this.state,
      loading: true,
      error: ""
    };
    this.emit();

    try {
      const response = await this.dispatcher.requestProcesses();
      const nextProcesses = parseProcessList(response);
      this.mergeProcessList(nextProcesses);
      this.state = {
        ...this.state,
        loading: false,
        error: ""
      };
      this.emit();
    } catch (error) {
      this.state = {
        ...this.state,
        loading: false,
        error: String(error)
      };
      this.emit();
      throw error;
    }
  }

  private mergeProcessList(definitions: ProcessDefinition[]): void {
    const currentByLabel = new Map(this.state.processes.map((entry) => [entry.label, entry] as const));
    const nextProcesses = definitions.map((definition) => {
      const current = currentByLabel.get(definition.label);
      const status: ProcessStatus = definition.running
        ? "running"
        : current?.status === "success" || current?.status === "error"
          ? current.status
          : "idle";
      const lastError = status === "error" ? current?.lastError ?? "" : "";
      return {
        ...definition,
        status,
        lastError,
        outputEnabled: current?.outputEnabled ?? true,
        lastRequestId: current?.lastRequestId ?? "",
        stdoutText: current?.stdoutText ?? "",
        stderrText: current?.stderrText ?? ""
      };
    });
    const selectedExists = nextProcesses.some((entry) => entry.label === this.state.selectedProcess);
    this.state = {
      ...this.state,
      selectedProcess: selectedExists ? this.state.selectedProcess : nextProcesses[0]?.label ?? "",
      processes: nextProcesses
    };
  }

  private applyProcessExecutorState(message: Nav2IncomingMessage): void {
    this.mergeProcessList(parseProcessList(message));
    this.emit();
  }

  private applyProcessFinished(message: Nav2IncomingMessage): void {
    const label = String(message.process ?? "").trim();
    if (!label) return;
    const succeeded = message.ok === true;
    const errorText = String(message.error ?? "").trim();
    this.setProcessState(label, {
      status: succeeded ? "success" : "error",
      running: false,
      lastError: succeeded ? "" : errorText,
      lastRequestId: String(message.requestId ?? "")
    });
    this.emit();
  }

  private applyProcessOutput(message: Nav2IncomingMessage): void {
    const label = String(message.process ?? "").trim();
    const stream = String(message.stream ?? "").trim() as ProcessOutputStream;
    const requestId = String(message.requestId ?? "").trim();
    const data = String(message.data ?? "");
    if (!label || !data) return;
    const process = this.state.processes.find((entry) => entry.label === label);
    if (!process) return;
    if (requestId && process.lastRequestId && requestId !== process.lastRequestId) return;
    if (!process.outputEnabled) return;
    this.setProcessState(label, {
      stdoutText:
        stream === "stdout" ? `${process.stdoutText}${data.endsWith("\n") ? data : `${data}\n`}` : process.stdoutText,
      stderrText:
        stream === "stderr" ? `${process.stderrText}${data.endsWith("\n") ? data : `${data}\n`}` : process.stderrText
    });
    this.emit();
  }

  private setProcessState(
    label: string,
    patch: Partial<
      Pick<ProcessViewState, "status" | "lastError" | "running" | "lastRequestId" | "stdoutText" | "stderrText">
    >
  ): void {
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
  }

  private emit(): void {
    const snapshot = this.getState();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}
