import { Nav2DispatcherBase } from "../../../../protocol/Nav2DispatcherBase";
import type { Nav2IncomingMessage } from "../../../../protocol/messages";

export class ProcessesDispatcher extends Nav2DispatcherBase {
  constructor(id: string, transportId: string) {
    super(id, transportId);
  }

  async requestProcesses(): Promise<Nav2IncomingMessage> {
    return this.request("get_processes", {}, { timeoutMs: 5000 });
  }

  async reloadProcesses(): Promise<Nav2IncomingMessage> {
    return this.request("reload_processes", {}, { timeoutMs: 5000 });
  }

  async startProcess(process: string, output: boolean): Promise<Nav2IncomingMessage> {
    return this.request(
      "start_process",
      {
        process,
        output
      } as never,
      { timeoutMs: 5000 }
    );
  }

  async stopProcess(process: string): Promise<Nav2IncomingMessage> {
    return this.request(
      "stop_process",
      {
        process
      } as never,
      { timeoutMs: 5000 }
    );
  }

  subscribeProcessExecutorState(callback: (message: Nav2IncomingMessage) => void): () => void {
    return this.subscribe("process_executor_state", callback);
  }

  subscribeProcessOutput(callback: (message: Nav2IncomingMessage) => void): () => void {
    return this.subscribe("process_output", callback);
  }

  subscribeProcessFinished(callback: (message: Nav2IncomingMessage) => void): () => void {
    return this.subscribe("process_finished", callback);
  }

  subscribeAck(callback: (message: Nav2IncomingMessage) => void): () => void {
    return this.subscribe("ack", callback);
  }
}
