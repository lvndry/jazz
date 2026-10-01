/** Qualify terminal acquisition cleanup when startup or disposal fails partway. */

import { expect, test } from "bun:test";
import { TerminalScope } from "./terminal-scope";

test("terminal release exhausts resources once, even when an earlier cleanup throws", () => {
  const scope = new TerminalScope();
  const released: number[] = [];
  const failure = new Error("cleanup failed");
  scope.add(() => {
    released.push(1);
  });
  scope.add(() => {
    released.push(2);
    throw failure;
  });
  scope.add(() => {
    released.push(3);
  });
  expect(() => scope.release()).toThrow(failure);
  scope.release();
  expect(released).toEqual([3, 2, 1]);
  scope.add(() => {
    released.push(4);
  });
  expect(released).toEqual([3, 2, 1, 4]);
});
