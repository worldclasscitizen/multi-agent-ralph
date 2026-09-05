import { resolve } from "node:path";
import { atomicJson, report } from "../scripts/lib/release.mjs";
export default class EvidenceReporter {
  onBegin(config, suite) { this.suite = suite; }
  async onEnd(result) {
    const checks = this.suite.allTests().map((test) => ({ name: test.title, passed: test.outcome() === "expected" }));
    checks.push({ name: "browser suite", passed: result.status === "passed" });
    await atomicJson(resolve(".release/evidence/accessibility.json"), await report("accessibility", checks, { maxNodes: 32, revisions: 8, logLines: 100000 }));
  }
}
