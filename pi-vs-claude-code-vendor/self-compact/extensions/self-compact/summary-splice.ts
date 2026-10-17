/**
 * Summary-instruction splicing for the compaction summary request.
 *
 * Pure and dependency-free so it is unit-testable from the vendored layout
 * (summary.ts imports the pi graph, which does not resolve from tests/).
 * Split out of summary.ts 2026-10-16 — pi 1.1.0 compat, see DIVERGENCE.md.
 *
 * Two recognized input shapes:
 *  - exact: a user text block starting with one of OUR serialized inputs
 *    (pi <= 0.55 renderer) — replace it, front-trimming to the budget. Exact
 *    matching keeps tag-like text inside the history from cutting the
 *    conversation short.
 *  - core-rendered: pi >= 1.1.0 renders the summary input itself
 *    ("# Conversation ..."); we cannot reconstruct its text, so append the
 *    instructions to that block and front-trim its body instead.
 * Anything else is refused: an unrecognized input must never get instructions
 * silently.
 */

export const TRIM_MARKER = "[earlier conversation truncated to fit summary budget]";

export function replaceInstructions(context: { messages: any[] }, inputs: string[], instructions: string, budgetChars: number): { messages: any[]; truncated: boolean } {
	let truncated = false;
	// The core-rendered branch applies to AT MOST the last user text block:
	// instructions must ride the request exactly once, so a quoted or prior
	// "# Conversation" block inside the history is left untouched.
	const lastUserIdx = context.messages.reduce((last: number, m: any, i: number) => (m?.role === "user" ? i : last), -1);
	const trimTail = (text: string, budgetChars: number): string => {
		// Bounded in UTF-16 code units, matching the budget itself (derived from
		// .length in summary.ts) — a codepoint slice can double-count astral
		// text. Adjust the cut so a surrogate pair is never split: an orphaned
		// low surrogate at the cut is dropped.
		const tail = text.slice(-budgetChars);
		return /^[\uDC00-\uDFFF]/.test(tail) ? tail.slice(1) : tail;
	};
	const messages = context.messages.map((message: any, mi: number) => {
		if (message.role !== "user") return message;
		const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
		const isLastUser = mi === lastUserIdx;
		let sawCoreRendered = false;
		return {
			...message,
			content: content.map((block: any) => {
				if (block.type !== "text") return block;
				const input = inputs.find((candidate) => block.text.startsWith(candidate));
				if (input !== undefined) {
					let body = input;
					if (body.length > budgetChars) {
						body = `${TRIM_MARKER}\n${trimTail(body, budgetChars)}`;
						truncated = true;
					}
					return { ...block, text: `${body}${instructions}` };
				}
				if (isLastUser && !sawCoreRendered && block.text.startsWith("# Conversation")) {
					sawCoreRendered = true;
					const over = block.text.length > budgetChars;
					const body = over ? `${TRIM_MARKER}\n${trimTail(block.text, budgetChars)}` : block.text;
					if (over) truncated = true;
					return { ...block, text: `${body}\n\n${instructions}` };
				}
				throw new Error("Unrecognized Pi summary input; cannot replace instructions safely.");
			}),
		};
	});
	return { messages, truncated };
}
