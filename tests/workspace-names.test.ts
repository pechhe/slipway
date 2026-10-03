import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { legacyIssueWorkspaceName, projectCode, taskWorkspaceName } from "../src/lib/workspace-jj.mjs";

test("project codes are two letters from the folder name", () => {
  assert.equal(projectCode("peach-pi"), "pp");
  assert.equal(projectCode("YardSmith"), "ys");
  assert.equal(projectCode("slipway"), "sl");
  assert.equal(projectCode("my_cool.app"), "mc");
});

test("Issue workspaces are named by project code and Issue number", () => {
  assert.equal(taskWorkspaceName("pp", 412, "Fix toast"), "pp-412");
  assert.equal(legacyIssueWorkspaceName("peach-pi", 412), "peach-pi-i412");
});

test("task workspaces are named by project code and a short task slug", () => {
  assert.equal(taskWorkspaceName("pp", null, "Fix toast"), "pp-fix-toast");
  assert.equal(taskWorkspaceName("ys", null, "Rework the invoice export pipeline"), "ys-rework-the-invoice");
  assert.equal(taskWorkspaceName("ys", null, "Supercalifragilisticexpialidocious"), "ys-supercalifragilisticexpi");
  assert.match(taskWorkspaceName("pp", null, "  "), /^pp-[0-9a-f]{6}$/);
  assert.match(taskWorkspaceName("pp", null), /^pp-[0-9a-f]{6}$/);
});
