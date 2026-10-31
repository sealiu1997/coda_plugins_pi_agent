import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePiExtraArgs, extensionPathsFromArgs } from "../agent/pi-args.mjs";

test("extra Pi args accept the same string and array forms in main and title processes", () => {
  assert.deepEqual(parsePiExtraArgs("--extension /models/a.mjs --foo"), ["--extension", "/models/a.mjs", "--foo"]);
  assert.deepEqual(parsePiExtraArgs(["--extension", "/models/a.mjs"]), ["--extension", "/models/a.mjs"]);
  assert.deepEqual(parsePiExtraArgs(undefined), []);
});

test("explicit long and short extension flags are extracted for the isolated title process", () => {
  const args = parsePiExtraArgs(
    "--extension /models/a.mjs -e /models/b.mjs --extension=/models/c.mjs -e=/models/d.mjs --model hidden",
  );
  assert.deepEqual(extensionPathsFromArgs(args), [
    "/models/a.mjs",
    "/models/b.mjs",
    "/models/c.mjs",
    "/models/d.mjs",
  ]);
  assert.equal(args.includes("--model"), true);
});

test("an extension flag without a path and unrelated args add no title extension", () => {
  assert.deepEqual(extensionPathsFromArgs(["--extension", "--verbose", "-e=", "--model", "p/m"]), []);
});

test('all four extension spellings become valid Pi CLI arguments', () => {
  for (const form of ['--extension /a','-e /a','--extension=/a','-e=/a']) {
    const args=parsePiExtraArgs(form);
    assert.deepEqual(extensionPathsFromArgs(args),['/a']);
    assert.equal(args.length,2); assert.ok(['--extension','-e'].includes(args[0]));
    assert.deepEqual(parsePiExtraArgs(form.split(' ')),args);
  }
});
