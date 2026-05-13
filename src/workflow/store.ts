import { load, type LoadedWorkflow } from "./loader.js";

/**
 * Singleton in-process cache for the parsed WORKFLOW.md. The Elixir
 * implementation uses a GenServer (WorkflowStore); we model it as a simple
 * value holder with explicit reload — concurrent reads are safe because the
 * Node event loop is single-threaded.
 */
class WorkflowStore {
  #current: LoadedWorkflow | null = null;

  current(): LoadedWorkflow | null {
    return this.#current;
  }

  set(value: LoadedWorkflow): void {
    this.#current = value;
  }

  async forceReload(): Promise<LoadedWorkflow | null> {
    const result = await load();
    if (result.ok) {
      this.#current = result.value;
      return this.#current;
    }
    return null;
  }

  reset(): void {
    this.#current = null;
  }
}

export const workflowStore = new WorkflowStore();
