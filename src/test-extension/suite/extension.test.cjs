const assert = require("node:assert/strict");
const vscode = require("vscode");

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, timeoutMs = 8000, intervalMs = 120) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error("Timeout waiting for condition");
}

suite("Cockpit extension smoke", () => {
  test("registers core commands", async () => {
    const commands = await vscode.commands.getCommands(true);

    assert.ok(commands.includes("cockpit.open"));
    assert.ok(commands.includes("cockpit.workspace.open"));
    assert.ok(commands.includes("cockpit.modal.open"));
    assert.ok(commands.includes("cockpit.toolbar.show"));
    assert.ok(commands.includes("cockpit.terminal.toggle"));
  });

  test("opens cockpit webview panel", async () => {
    await vscode.commands.executeCommand("cockpit.open");

    await waitUntil(() => {
      return vscode.window.tabGroups.all.some((group) =>
        group.tabs.some((tab) => tab.label.toLowerCase().includes("cockpit"))
      );
    });

    assert.ok(true);
  });

  test("executes integration commands without throw", async () => {
    await vscode.commands.executeCommand("cockpit.open");
    await vscode.commands.executeCommand("cockpit.workspace.open", "nav2.workspace.map");
    await vscode.commands.executeCommand("cockpit.modal.open", "modal.settings");
    await vscode.commands.executeCommand("cockpit.toolbar.show");
    await vscode.commands.executeCommand("cockpit.terminal.toggle");

    assert.ok(true);
  });
});
