import { createHash } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { landedHome } from "./workspace-paths.mjs";
import { writeWorkspaceJson } from "./workspace-transaction.mjs";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Retain proven landing evidence independently of the disposable working directory. */
export async function archiveIntegratedWorkspaceEvidence(gitDirectory, state) {
  const artifactDirectory = landedHome();
  const file = join(artifactDirectory, "artifact-" + digest([await realpath(gitDirectory), state.artifactCommitId]) + ".json");
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  try {
    const previous = JSON.parse(await readFile(file, "utf8"));
    if (previous.workspaceName !== state.workspaceName || previous.integrationRoot !== state.integrationRoot
      || previous.artifactCommitId !== state.artifactCommitId || previous.artifactChangeId !== state.artifactChangeId
      || previous.integrationBranch !== state.integrationBranch || previous.issueNumber !== state.issueNumber) {
      throw new Error("Archived integrated delivery identity changed");
    }
    return;
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  await writeWorkspaceJson(file, { ...state, phase: "landed" });
}
