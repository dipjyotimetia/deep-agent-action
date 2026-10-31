import { describe, expect, test } from "bun:test";
import { isForkPr, forkRunAllowed, isUntrustedPrHead } from "../src/github/fork.js";
import { makeContext } from "./mockContext.js";

describe("isForkPr", () => {
  test("non-PR is never a fork", () => {
    expect(isForkPr(makeContext({ isPR: false }))).toBe(false);
  });

  test("same-repo PR is not a fork", () => {
    const ctx = makeContext({
      isPR: true,
      prHeadRepoFullName: "acme/widgets",
      prBaseRepoFullName: "acme/widgets",
    });
    expect(isForkPr(ctx)).toBe(false);
  });

  test("different head repo is a fork", () => {
    const ctx = makeContext({
      isPR: true,
      prHeadRepoFullName: "mallory/widgets",
      prBaseRepoFullName: "acme/widgets",
    });
    expect(isForkPr(ctx)).toBe(true);
  });

  test("undetermined when head repo unknown", () => {
    expect(isForkPr(makeContext({ isPR: true }))).toBeUndefined();
  });
});

describe("forkRunAllowed", () => {
  test("allows same-repo PRs", () => {
    const ctx = makeContext({
      isPR: true,
      prHeadRepoFullName: "acme/widgets",
      prBaseRepoFullName: "acme/widgets",
    });
    expect(forkRunAllowed(ctx, undefined).allowed).toBe(true);
  });

  test("blocks fork PRs by default", () => {
    const ctx = makeContext({
      isPR: true,
      prHeadRepoFullName: "mallory/widgets",
      prBaseRepoFullName: "acme/widgets",
    });
    expect(forkRunAllowed(ctx, undefined).allowed).toBe(false);
  });

  test("blocks fork PRs without the gating label", () => {
    const ctx = makeContext({
      isPR: true,
      prHeadRepoFullName: "mallory/widgets",
      prBaseRepoFullName: "acme/widgets",
      labels: ["bug"],
    });
    expect(forkRunAllowed(ctx, "agent-approved").allowed).toBe(false);
  });

  test("allows fork PRs when a maintainer applied the gating label", () => {
    const ctx = makeContext({
      isPR: true,
      prHeadRepoFullName: "mallory/widgets",
      prBaseRepoFullName: "acme/widgets",
      labels: ["agent-approved"],
    });
    expect(forkRunAllowed(ctx, "agent-approved").allowed).toBe(true);
  });

  test("treats undetermined PR fork status as untrusted", () => {
    const ctx = makeContext({ isPR: true });
    expect(forkRunAllowed(ctx, "agent-approved").allowed).toBe(false);
  });
});

describe("isUntrustedPrHead", () => {
  test("is false for issues and same-repo PRs", () => {
    expect(isUntrustedPrHead(makeContext({ isPR: false }))).toBe(false);
    expect(
      isUntrustedPrHead(
        makeContext({
          isPR: true,
          prHeadRepoFullName: "acme/widgets",
          prBaseRepoFullName: "acme/widgets",
        }),
      ),
    ).toBe(false);
  });

  test("is true for a fork, and for a PR whose head repository is unknown", () => {
    expect(
      isUntrustedPrHead(
        makeContext({
          isPR: true,
          prHeadRepoFullName: "mallory/widgets",
          prBaseRepoFullName: "acme/widgets",
        }),
      ),
    ).toBe(true);
    expect(isUntrustedPrHead(makeContext({ isPR: true }))).toBe(true);
  });
});
