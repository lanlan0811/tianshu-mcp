import { describe, expect, it } from "vitest";
import { tallyContentVotes } from "../../src/visual/content-verdict.js";
import type { ContentVote } from "../../src/visual/types.js";

const vote = (index: number, passed: boolean | undefined, confidence?: number): ContentVote => ({
  index,
  ...(passed === undefined ? {} : { passed }),
  ...(confidence === undefined ? {} : { confidence }),
  reason: `sample ${index}: ${passed ?? "undecided"}`,
});

describe("tallyContentVotes", () => {
  it("3/3 pass yields CONTENT_MATCH", () => {
    const tally = tallyContentVotes({ votes: [vote(0, true), vote(1, true), vote(2, true)], samples: 3 });
    expect(tally.code).toBe("CONTENT_MATCH");
    expect(tally.status).toBe("passed");
    expect(tally.passedVotes).toBe(3);
    expect(tally.reason).toBe("sample 0: true");
  });

  it("2/3 pass yields CONTENT_MATCH (majority)", () => {
    const tally = tallyContentVotes({ votes: [vote(0, true), vote(1, false), vote(2, true)], samples: 3 });
    expect(tally.code).toBe("CONTENT_MATCH");
    expect(tally.failedVotes).toBe(1);
  });

  it("3/3 fail yields CONTENT_MISMATCH with the first failing reason", () => {
    const tally = tallyContentVotes({ votes: [vote(0, false), vote(1, false), vote(2, false)], samples: 3 });
    expect(tally.code).toBe("CONTENT_MISMATCH");
    expect(tally.status).toBe("failed");
    expect(tally.reason).toBe("sample 0: false");
  });

  it("1/2 tie yields CONTENT_UNCERTAIN", () => {
    const tally = tallyContentVotes({ votes: [vote(0, true), vote(1, false)], samples: 2 });
    expect(tally.code).toBe("CONTENT_UNCERTAIN");
    expect(tally.status).toBe("uncertain");
    expect(tally.reason).toContain("1 passed, 1 failed");
  });

  it("samples:1 with one pass yields CONTENT_MATCH", () => {
    const tally = tallyContentVotes({ votes: [vote(0, true)], samples: 1 });
    expect(tally.code).toBe("CONTENT_MATCH");
  });

  it("undecided votes do not count towards either side", () => {
    const tally = tallyContentVotes({
      votes: [vote(0, true), vote(1, undefined), vote(2, undefined)],
      samples: 3,
    });
    expect(tally.invalidVotes).toBe(2);
    expect(tally.code).toBe("CONTENT_UNCERTAIN");
  });

  it("averages confidence only over votes that report one", () => {
    const tally = tallyContentVotes({
      votes: [vote(0, true, 0.9), vote(1, true, 0.8), vote(2, true)],
      samples: 3,
    });
    expect(tally.confidence).toBe(0.85);
  });

  it("omits confidence when no vote reports one", () => {
    const tally = tallyContentVotes({ votes: [vote(0, true), vote(1, true)], samples: 2 });
    expect(tally.confidence).toBeUndefined();
    expect(tally.confidenceGate).toBe("off");
  });

  it("downgrades a clear majority to uncertain when mean confidence is below the gate", () => {
    const tally = tallyContentVotes({
      votes: [vote(0, true, 0.3), vote(1, true, 0.4), vote(2, true, 0.2)],
      samples: 3,
      minConfidence: 0.6,
    });
    expect(tally.code).toBe("CONTENT_UNCERTAIN");
    expect(tally.status).toBe("uncertain");
    expect(tally.confidenceGate).toBe("downgraded");
    expect(tally.reason).toContain("below configured 0.6");
  });

  it("keeps a clear majority when mean confidence meets the gate", () => {
    const tally = tallyContentVotes({
      votes: [vote(0, true, 0.9), vote(1, true, 0.8), vote(2, true, 0.7)],
      samples: 3,
      minConfidence: 0.6,
    });
    expect(tally.code).toBe("CONTENT_MATCH");
    expect(tally.confidenceGate).toBe("applied");
  });

  it("does not misjudge commands that omit confidence when the gate is configured", () => {
    const tally = tallyContentVotes({
      votes: [vote(0, true), vote(1, true), vote(2, true)],
      samples: 3,
      minConfidence: 0.6,
    });
    expect(tally.code).toBe("CONTENT_MATCH");
    expect(tally.confidence).toBeUndefined();
    expect(tally.confidenceGate).toBe("no-confidence");
  });

  it("rounds confidence to three decimals", () => {
    const tally = tallyContentVotes({
      votes: [vote(0, true, 1), vote(1, true), vote(2, true)],
      samples: 3,
    });
    expect(tally.confidence).toBe(1);
    const odd = tallyContentVotes({
      votes: [vote(0, true, 0.3333), vote(1, true), vote(2, true)],
      samples: 3,
    });
    expect(odd.confidence).toBe(0.333);
  });
});
