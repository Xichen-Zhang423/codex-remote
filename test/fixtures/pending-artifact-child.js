import fs from "node:fs/promises";
import path from "node:path";
import { ArtifactStore } from "../../src/artifact-store.js";
import { ArtifactTracker } from "../../src/artifact-tracker.js";

if (process.argv[2] && process.argv[3]) {
  const workspace = path.resolve(process.argv[2]);
  const vault = path.resolve(process.argv[3]);
  const store = await ArtifactStore.open({ root: vault });
  const tracker = new ArtifactTracker({ store });
  const handle = await tracker.beginTurn({
    localTaskId: "pending-child",
    threadId: "thread-e2e",
    cwd: workspace,
    cwdGeneration: 0,
  });
  await tracker.bindTurnId(handle, "turn-pending-child");
  await fs.writeFile(
    path.join(workspace, "late.txt"),
    "late from crashed service\n",
    "utf8",
  );
  const deadline = Date.now() + 5_000;
  while (!store.pendingTurns().some((pending) => pending.hints.has("late.txt"))) {
    if (Date.now() >= deadline) {
      throw new Error("timed out persisting late.txt watcher hint");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  process.exit(0); // Deliberately bypass tracker.close() and every shutdown handler.
}
