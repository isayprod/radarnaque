import { describe, expect, test } from "vitest";
import { readSse, type SseMessage } from "../lib/sse";
import { sseBody } from "./helpers";

async function collect(
	stream: ReadableStream<Uint8Array>,
): Promise<SseMessage[]> {
	const out: SseMessage[] = [];
	for await (const message of readSse(stream)) out.push(message);
	return out;
}

describe("readSse", () => {
	test("reassembles events split across chunks", async () => {
		expect(
			await collect(sseBody("event: sea", 'rch\ndata: {"q":"pr', 'ix"}\n\n')),
		).toEqual([{ event: "search", data: '{"q":"prix"}' }]);
	});

	test("decodes utf-8 split inside a code point", async () => {
		// « € » vaut trois octets (E2 82 AC) : la coupure tombe au milieu.
		const bytes = new TextEncoder().encode(
			'event: thinking\ndata: {"text":"5 € é"}\n\n',
		);
		const cut = bytes.indexOf(0xe2) + 1;
		const messages = await collect(
			sseBody(bytes.slice(0, cut), bytes.slice(cut)),
		);
		expect(messages).toEqual([{ event: "thinking", data: '{"text":"5 € é"}' }]);
		// Chaque octet séparément : le texte reste identique.
		const oneByOne = Array.from(bytes, (b) => Uint8Array.of(b));
		expect(await collect(sseBody(...oneByOne))).toEqual(messages);
	});

	test("ignores comment lines", async () => {
		expect(await collect(sseBody(": ping\n\n"))).toEqual([]);
		expect(
			await collect(
				sseBody(
					": ping\n\n",
					'event: stage\n: ping\ndata: {"stage":"cache"}\n\n',
				),
			),
		).toEqual([{ event: "stage", data: '{"stage":"cache"}' }]);
	});

	test("handles CRLF", async () => {
		expect(
			await collect(
				sseBody("event: stage\r", '\ndata: {"stage":"photos"}\r\n\r', "\n"),
			),
		).toEqual([{ event: "stage", data: '{"stage":"photos"}' }]);
	});

	test("several data lines are joined; an event without data is dropped", async () => {
		expect(
			await collect(
				sseBody("event: a\n\n", "event: b\ndata: 1\ndata:2\n\n", "data: x\n\n"),
			),
		).toEqual([
			{ event: "b", data: "1\n2" },
			{ event: "message", data: "x" },
		]);
	});

	test("an unterminated event at the end of the stream is dropped", async () => {
		expect(await collect(sseBody('event: result\ndata: {"score":5'))).toEqual(
			[],
		);
	});

	test("stopping early cancels the stream", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: 1\n\n"));
			},
			cancel() {
				cancelled = true;
			},
		});
		for await (const _ of readSse(body)) break;
		expect(cancelled).toBe(true);
	});
});
