import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { assertIssueEligible, assertIssueReconciled, selectImplementationIssue } from "../src/lib/issue-eligibility.mjs";

test("Epic selection refreshes child readiness and dependency receipts on every transition", async () => {
  let landed = false;
  const commit = "a".repeat(40);
  const calls: string[] = [];
  const run = async (command: string, args: string[]) => {
    calls.push(args.join(" "));
    if (command === "jj") return args[0] === "git" ? "origin https://github.com/owner/repo.git" : landed ? commit : "";
    const url = args[1]!;
    if (url.endsWith("issues/10")) return JSON.stringify([{ number: 10, state: "open", labels: ["epic"] }]);
    if (url.includes("/sub_issues") && !url.includes("/10/")) return "[[]]";
    if (url.includes("/sub_issues")) return JSON.stringify([[{ number: 11, state: landed ? "closed" : "open", state_reason: landed ? "completed" : null }, { number: 12, state: "open" }]]);
    if (url.endsWith("issues/11")) return JSON.stringify([{ number: 11, state: landed ? "closed" : "open", labels: ["ready-for-agent"] }]);
    if (url.endsWith("issues/12")) return JSON.stringify([{ number: 12, state: "open", labels: ["ready-for-agent"] }]);
    if (url.includes("/dependencies/blocked_by")) return JSON.stringify([url.includes("/12/") ? [{ number: 11, state: landed ? "closed" : "open", state_reason: landed ? "completed" : null }] : []]);
    if (url.includes("/comments")) return JSON.stringify([[{ body: `Completed via Peach local integration.\nVerification: passed\nDelivery: local integration\nIntegrated commit: \`${commit}\`\n<!-- peach-local-completion:11:${commit} -->` }]]);
    throw new Error(url);
  };
  assert.equal(await selectImplementationIssue("/repo", 10, "main", run, async () => null), 11);
  await assert.rejects(selectImplementationIssue("/repo", 12, "main", run), /blocked/);
  landed = true;
  assert.equal(await selectImplementationIssue("/repo", 10, "main", run, async () => null), 12);
  assert.ok(calls.filter((call) => call.includes("issues/10/sub_issues")).length === 2);
  assert.ok(calls.some((call) => call.includes(commit)));
});

test("no route or parent readiness admits a parked or unready child", async () => {
  const run = async (command: string, args: string[]) => {
    if (command === "jj") return "origin https://github.com/owner/repo.git";
    const url = args[1]!;
    if (url.endsWith("issues/10")) return JSON.stringify([{ number: 10, state: "open", labels: ["epic", "ready-for-agent"] }]);
    if (url.includes("/sub_issues")) return JSON.stringify([[{ number: 11, state: "open" }]]);
    return JSON.stringify([{ number: 11, state: "open", labels: ["ready-for-agent", "someday"] }]);
  };
  await assert.rejects(selectImplementationIssue("/repo", 10, "main", run, async () => null), /not ready/);
});

test("canonical external blocker prevents unattended implementation", async () => {
  const run = async (command: string, args: string[]) => {
    if (command === "jj") return "origin https://github.com/owner/repo.git";
    const url = args[1]!;
    if (url.endsWith("issues/10")) return JSON.stringify([{ number: 10, state: "open", labels: ["epic"] }]);
    if (url.includes("/sub_issues")) return JSON.stringify([[{ number: 11, state: "open" }]]);
    return JSON.stringify([{ number: 11, state: "open", labels: ["ready-for-agent", "blocked: external"] }]);
  };
  await assert.rejects(selectImplementationIssue("/repo", 10, "main", run, async () => null), /not ready/);
});

test("continuation requires the exact child receipt and closed Issue", async () => {
  let closed = false;
  let commit = "a".repeat(40);
  const run = async (command: string, args: string[]) => {
    if (command === "jj") return "origin https://github.com/owner/repo.git";
    if (args[1]!.includes("/comments")) return JSON.stringify([[{ body: "Completed via Peach local integration.\nVerification: passed\nIntegrated commit: `" + commit + "`\n<!-- peach-local-completion:11:" + commit + " -->" }]]);
    return JSON.stringify([{ state: closed ? "closed" : "open" }]);
  };
  await assert.rejects(assertIssueReconciled("/repo", 11, commit, run), /Reconcile/);
  closed = true;
  await assertIssueReconciled("/repo", 11, commit, run);
  commit = "b".repeat(40);
  await assert.rejects(assertIssueReconciled("/repo", 11, "a".repeat(40), run), /Reconcile/);
});

test("a coherent Epic with internal phases stays its own live delivery unit", async () => {
  const calls: string[] = [];
  const run = async (command: string, args: string[]) => {
    calls.push(args.join(" "));
    if (command === "jj") return "origin https://github.com/owner/repo.git";
    if (args[1]!.includes("/sub_issues") || args[1]!.includes("/dependencies/")) return "[[]]";
    return JSON.stringify([{ number: 10, state: "open", labels: ["epic", "ready-for-agent"], body: "## Phase 1\n- [ ] Implement\n## Phase 2\n- [ ] Checkpoint and verify" }]);
  };
  for (let step = 0; step < 3; step++) assert.equal(await selectImplementationIssue("/repo", 10, "main", run, async () => null), 10);
  assert.ok(calls.every((call) => !call.includes("--method") && !call.includes("issues/11")));
});

test("a decomposed Epic stays open while its exact parent source receipt permits continuation", async () => {
  const commit = "a".repeat(40);
  let receipt = "";
  let children = true;
  const run = async (command: string, args: string[]) => {
    if (command === "jj") return "origin https://github.com/owner/repo.git";
    if (args[1]!.includes("/comments")) return JSON.stringify([[{ body: receipt }]]);
    if (args[1]!.includes("/sub_issues")) return JSON.stringify([children ? [{ number: 11 }] : []]);
    return JSON.stringify([{ number: 10, state: "open", labels: ["epic"] }]);
  };
  await assert.rejects(assertIssueReconciled("/repo", 10, commit, run), /Reconcile/);
  receipt = "Epic source reconciled via Peach local integration.\nVerification: passed\nIntegrated commit: `" + commit + "`\n<!-- peach-local-completion:10:receipt -->";
  await assertIssueReconciled("/repo", 10, commit, run);
  await assert.rejects(assertIssueReconciled("/repo", 10, "b".repeat(40), run), /Reconcile/);
  children = false;
  await assert.rejects(assertIssueReconciled("/repo", 10, commit, run), /Reconcile/);
});

function unblockedEpic() {
  const calls: string[] = [];
  const run = async (command: string, args: string[]) => {
    calls.push(args.join(" "));
    if (command === "jj") return "origin https://github.com/owner/repo.git";
    const url = args[1]!;
    if (url.includes("/dependencies/")) return "[[]]";
    if (url.includes("/sub_issues")) return JSON.stringify([url.includes("/10/") ? [
      { number: 11, state: "open" }, { number: 12, state: "open" },
    ] : []]);
    if (url.endsWith("issues/10")) return JSON.stringify([{
      number: 10, state: "open", labels: ["epic", "ready-for-agent"],
      body: '<!-- peach-route {"version":1,"preferredNext":[11],"parallelNow":[11,12],"futureAfter":[]} -->',
    }]);
    const number = Number(url.split("/").at(-1));
    return JSON.stringify([{ number, state: "open", labels: ["ready-for-agent"] }]);
  };
  return { run, calls };
}

test("Epic selection skips a live-owned preferred sibling and refreshes after release", async () => {
  const { run, calls } = unblockedEpic();
  const owned = new Set([11]);
  const read: number[] = [];
  const readWorkspace = async (number: number) => {
    if (number !== 10) assert.ok(calls.some((call) => call.includes(`/issues/${number}/dependencies/`)), "ownership is read after live dependency proof");
    read.push(number);
    return { name: `repo-i${number}`, lock: owned.has(number) ? { pid: 123 } : null };
  };
  assert.equal(await selectImplementationIssue("/repo", 10, "main", run, readWorkspace), 12);
  assert.deepEqual(read, [11, 12, 12]);
  owned.add(12);
  await assert.rejects(selectImplementationIssue("/repo", 10, "main", run, readWorkspace),
    /No eligible child remains:.*#11 has a current writer.*#12 has a current writer/);
  owned.delete(11);
  assert.equal(await selectImplementationIssue("/repo", 10, "main", run, readWorkspace), 11);
  assert.deepEqual([...owned], [12], "selection never releases a writer");
  assert.ok(calls.every((call) => !/--method|workspace add/.test(call)), "selection allocates and publishes nothing");
});

test("missing or failed native ownership evidence cannot admit a child", async () => {
  const { run } = unblockedEpic();
  await assert.rejects(selectImplementationIssue("/repo", 10, "main", run), /requires live native workspace ownership/);
  await assert.rejects(selectImplementationIssue("/repo", 10, "main", run, async () => {
    throw new Error("Ambiguous native ownership");
  }), /Ambiguous native ownership/);
});

test("an explicit leaf still reaches owned-task recovery instead of sibling selection", async () => {
  const { run } = unblockedEpic();
  assert.equal(await selectImplementationIssue("/repo", 11, "main", run, async () => {
    assert.fail("A direct Issue request must use the existing recovery ownership boundary");
  }), 11);
});

test("a writer acquired during frontier refresh does not strand an available sibling", async () => {
  const { run } = unblockedEpic();
  let firstOwned = false;
  const read: number[] = [];
  const readWorkspace = async (number: number) => {
    read.push(number);
    if (number === 12) firstOwned = true;
    return { name: `repo-i${number}`, lock: number === 11 && firstOwned ? { pid: 123 } : null };
  };
  assert.equal(await selectImplementationIssue("/repo", 10, "main", run, readWorkspace), 12);
  assert.deepEqual(read, [11, 12, 11, 12]);
});


test("not-planned prerequisites never become satisfied through an old commit receipt", async () => {
  const run = async (command: string) => command === "jj" ? "origin https://github.com/owner/repo.git" : JSON.stringify([[{ number: 11, state: "closed", state_reason: "not_planned" }]]);
  await assert.rejects(assertIssueEligible("/repo", 12, "main", run), /only completed delivery/);
});

test("foreign dependencies use their repository publication proof, never equal local Issue numbers", async () => {
  const commit = "a".repeat(40);
  let published = true;
  const calls: string[] = [];
  const receipt = `Completed via Peach GitHub source publication.\nIntegrated commit: \`${commit}\`\nVerification: passed\nDelivery: git remote publication\nSource publication: complete; remote=origin; ref=develop; target=${commit}; observed=${commit}; coverage=exact\n<!-- peach-local-completion:11:receipt -->`;
  const run = async (command: string, args: string[]) => {
    calls.push(`${command} ${args.join(" ")}`);
    if (command === "jj" && args[0] === "git") return "origin https://github.com/owner/repo.git";
    if (command === "jj") throw new Error("Foreign source cannot be verified in local ancestry");
    const route = args[1]!;
    if (route.includes("owner/repo/issues/12/dependencies")) return JSON.stringify([[{ number: 11, repository_url: "https://api.github.com/repos/owner/other", state: "closed", state_reason: "completed" }]]);
    if (route.includes("owner/other/issues/11/comments")) return JSON.stringify([[{ body: receipt }]]);
    if (route === "repos/owner/other/git/ref/heads/develop") return JSON.stringify([{ object: { sha: published ? commit : "b".repeat(40) } }]);
    if (route.startsWith("repos/owner/other/compare/")) return JSON.stringify([{ status: "diverged", merge_base_commit: { sha: "c".repeat(40) } }]);
    throw new Error(`Unexpected identity ${route}`);
  };
  await assertIssueEligible("/repo", 12, "main", run);
  published = false;
  await assert.rejects(assertIssueEligible("/repo", 12, "main", run), /not proven delivered/);
  assert.ok(calls.every((call) => !call.includes("owner/repo/issues/11")));
});

test("published-source completion receipts permit exact native continuation", async () => {
  const commit = "c".repeat(40);
  const run = async (_executable: string, args: string[]) => {
    if (args[0] === "git") return "origin https://github.com/owner/repo.git";
    if (args[1]?.includes("comments")) return JSON.stringify([[{ body: `Completed via Peach GitHub source publication.\nIntegrated commit: \`${commit}\`\nVerification: passed\n<!-- peach-local-completion:12:example -->` }]]);
    return JSON.stringify([[{ state: "closed", state_reason: "completed", labels: [] }]]);
  };
  await assertIssueReconciled("/repo", 12, commit, run);
  await assert.rejects(assertIssueReconciled("/repo", 12, "d".repeat(40), run), /Reconcile/);
});
