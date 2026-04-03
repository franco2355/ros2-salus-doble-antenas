import type { ModalDialogDefinition } from "../types/ui";
import { OrderedRegistry } from "./orderedRegistry";

export class ModalRegistry extends OrderedRegistry<ModalDialogDefinition> {
  registerModalDialog(definition: ModalDialogDefinition): void {
    this.register(definition);
  }
}

