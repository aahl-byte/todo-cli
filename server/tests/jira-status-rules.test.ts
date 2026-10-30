import { describe, expect, it } from "vitest";
import { statusRuleInstances, statusRules, validateStatusRules } from "@/lib/jira/status-rules";
import { STATUSES } from "@/lib/model";

const REJECT = { jiraFrom: "QA", jiraTo: "In Development", from: "in-qa", to: "qa-rejected", note: "QA moved the Jira ticket" };

describe("jira-status-transitions rows", () => {
  it("round-trip through instances, in test mode until the switch is on", () => {
    const saved = statusRuleInstances({ moves: false, rules: [REJECT] });
    expect(saved).toEqual([{ id: "jira-qa-in-development", name: "Jira QA → In Development: in-qa → qa-rejected", dry_run: true,
      settings: { jira_from: "QA", jira_to: "In Development", from: "in-qa", to: "qa-rejected", note: "QA moved the Jira ticket" } }]);
    expect(statusRules(saved)).toEqual({ moves: false, rules: [{ ...REJECT, id: "jira-qa-in-development", live: false }] });
    expect(statusRuleInstances({ moves: true, rules: [REJECT, { ...REJECT, from: "qa-approved" }] }).map((i) => [i.id, i.dry_run]))
      .toEqual([["jira-qa-in-development", undefined], ["jira-qa-in-development-2", undefined]]);
  });

  it("refuse a row without its statuses, or a Jira move listed twice from one status", () => {
    const problems = validateStatusRules({ moves: true, rules: [REJECT, { ...REJECT, jiraFrom: "qa" }, { ...REJECT, jiraTo: "", to: "" }] },
                                         STATUSES, ["QA", "In Development"]);
    expect(problems.map((p) => p.message)).toEqual([
      "Jira qa → In Development from in-qa has two rows.",
      "Jira QA → ? needs both Jira statuses.",
      "Jira QA → ? needs both todo statuses.",
    ]);
    expect(validateStatusRules({ moves: true, rules: [{ ...REJECT, jiraTo: "Gone" }] }, STATUSES, ["QA"]))
      .toEqual([{ level: "warning", message: "Jira has no status Gone." }]);
  });
});
