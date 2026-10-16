/**
 * replaceInstructions — the summary-instruction splicer (extracted, pi-free).
 * The refusal arm is the module's only defense against silently emitting an
 * un-instructed summary; these tests pin all three branches.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { replaceInstructions, TRIM_MARKER } from "../../extensions/self-compact/summary-splice.ts";

const INSTRUCTIONS = "USER INSTRUCTIONS: preserve evidence.";
const INPUTS = ["<conversation>\nseeded history\n</conversation>"];

const ctxWith = (text: string): any => ({ messages: [{ role: "user", content: [{ type: "text", text }] }] });

test("exact serialized input is replaced, instructions appended", () => {
	const { messages } = replaceInstructions(ctxWith(INPUTS[0]!), INPUTS, INSTRUCTIONS, 8000);
	const block = (messages as any[])[0].content[0];
	assert.ok(block.text.startsWith(INPUTS[0]));
	assert.match(block.text, /USER INSTRUCTIONS: preserve evidence\.$/);
});

test("core-rendered input (pi >= 1.1.0) gets instructions appended", () => {
	const body = "# Conversation\n[User]: hi\n\n[Assistant]: hello";
	const { messages } = replaceInstructions(ctxWith(body), INPUTS, INSTRUCTIONS, 8000);
	const block = (messages as any[])[0].content[0];
	assert.ok(block.text.startsWith("# Conversation"));
	assert.match(block.text, /USER INSTRUCTIONS: preserve evidence\.$/);
});

test("core-rendered input over budget is front-trimmed, instructions kept whole", () => {
	const body = `# Conversation\n${"x".repeat(9000)}`;
	const { messages, truncated } = replaceInstructions(ctxWith(body), INPUTS, INSTRUCTIONS, 1000);
	const block = (messages as any[])[0].content[0];
	assert.match(block.text, new RegExp(`^${TRIM_MARKER.replace(/[\[\]]/g, "\\$&")}`));
	assert.match(block.text, /USER INSTRUCTIONS: preserve evidence\.$/);
	assert.equal(truncated, true);
});

test("front-trim is UTF-16-bounded and never splits a surrogate pair", () => {
	// 1 astral char (2 UTF-16 units) + 9 BMP chars = 11 units, budget 10.
	const body = `# Conversation\n😀${"y".repeat(9)}`;
	const { messages, truncated } = replaceInstructions(ctxWith(body), INPUTS, INSTRUCTIONS, 10);
	const block = (messages as any[])[0].content[0];
	const retained = block.text.slice(TRIM_MARKER.length + 1, block.text.indexOf("\n\n"));
	assert.equal(truncated, true);
	// Codepoint-bounded trimming would emit 2 units per astral char — the
	// retained body must stay within the budget in UTF-16 terms.
	assert.ok(retained.length <= 10, `retained ${retained.length} units exceeds the 10-char budget`);
	assert.doesNotMatch(retained, /^[\uDC00-\uDFFF]/, "cut split a surrogate pair (orphaned low surrogate)");
	// The 😀 is dropped whole: its low surrogate would lead the raw slice.
	assert.equal(retained, "y".repeat(9));
});

test("an unrecognized input is REFUSED — never silently un-instructed", () => {
	assert.throws(
		() => replaceInstructions(ctxWith("totally unknown renderer output"), INPUTS, INSTRUCTIONS, 8000),
		/Unrecognized Pi summary input/,
	);
});

test("non-user messages pass through untouched", () => {
	const ctx = { messages: [{ role: "system", content: "sys" }, { role: "assistant", content: [{ type: "text", text: "unknowable" }] }, { role: "user", content: INPUTS[0] }] };
	const { messages } = replaceInstructions(ctx as any, INPUTS, INSTRUCTIONS, 8000);
	assert.equal((messages as any[])[0].content, "sys");
	assert.equal((messages as any[])[1].content[0].text, "unknowable");
	assert.match((messages as any[])[2].content[0].text, /preserve evidence/);
});
