import { expect, it } from "bun:test";
import {
	decodeJsonValue,
	encodeJsonValue,
	type JsonValue,
	type MessageCodec,
	type ProtoMessage,
	pb,
} from "../src/discovery/protobuf";

interface Envelope extends ProtoMessage {
	enabled?: boolean;
	choice: { case: undefined; value?: undefined } | { case: "text"; value: string };
}

const EnvelopeSchema = pb<Envelope>("test.Envelope", [
	{ no: 1, name: "enabled", kind: "bool", optional: true },
	{
		kind: "oneof",
		name: "choice",
		variants: [{ no: 2, name: "text", kind: "string" }],
	},
]);

interface Counter extends ProtoMessage {
	value: number;
}

const CounterSchema = pb<Counter>("test.Counter", [{ no: 1, name: "value", kind: "int32" }]);

interface Node extends ProtoMessage {
	label: string;
	child?: Node;
}

const NodeSchema: MessageCodec<Node> = pb<Node>("test.Node", [
	{ no: 1, name: "label", kind: "string" },
	{ no: 2, name: "child", kind: "message", T: () => NodeSchema },
]);

interface StringMap extends ProtoMessage {
	entries: Record<string, string>;
}

const StringMapSchema = pb<StringMap>("test.StringMap", [
	{ no: 1, name: "entries", kind: "map", K: "string", V: "string" },
]);

interface BinaryPayload extends ProtoMessage {
	data: Uint8Array;
}

const BinaryPayloadSchema = pb<BinaryPayload>("test.BinaryPayload", [{ no: 1, name: "data", kind: "bytes" }]);

it("preserves selected oneofs and explicit optional defaults", () => {
	const decoded = EnvelopeSchema.decode(
		EnvelopeSchema.encode({ enabled: false, choice: { case: "text", value: "hello" } }),
	);

	expect(decoded).toMatchObject({ enabled: false, choice: { case: "text", value: "hello" } });
	expect(EnvelopeSchema.toJson(decoded)).toEqual({ enabled: false, text: "hello" });
});

it("retains unknown wire fields while re-encoding a message", () => {
	const input = new Uint8Array([0x08, 0x2a, 0x10, 0x07]);

	expect(CounterSchema.encode(CounterSchema.decode(input))).toEqual(input);
});

it("round-trips JSON values with empty struct keys", () => {
	const value: JsonValue = { "": ["kept", { nested: true }], count: 1 };

	expect(decodeJsonValue(encodeJsonValue(value))).toEqual(value);
});

it("resolves recursive static message descriptors on demand", () => {
	const decoded = NodeSchema.decode(
		NodeSchema.encode({ label: "root", child: { label: "child", child: { label: "leaf" } } }),
	);

	expect(decoded.child?.child?.label).toBe("leaf");
});

it("round-trips a map whose key is __proto__ without prototype pollution", () => {
	// An object-literal `__proto__` sets the prototype instead of an own key,
	// so build the entries through JSON.parse to get a genuine own data key.
	const entries = JSON.parse('{"__proto__":"polluted","safe":"ok"}') as Record<string, string>;
	const decoded = StringMapSchema.decode(StringMapSchema.encode({ entries }));

	expect(Object.getPrototypeOf(decoded.entries)).toBeNull();
	expect(Object.keys(decoded.entries).sort()).toEqual(["__proto__", "safe"]);
	expect(Reflect.get(decoded.entries, "__proto__")).toBe("polluted");
	expect(decoded.entries.safe).toBe("ok");

	const json = StringMapSchema.toJson(decoded) as { entries: Record<string, string> };
	expect(Object.keys(json.entries).sort()).toEqual(["__proto__", "safe"]);
	expect(Reflect.get(json.entries, "__proto__")).toBe("polluted");
});

it("encodes bytes from ArrayBuffer, views, and serialized Buffer objects", () => {
	const fromView = BinaryPayloadSchema.encode({
		data: new Uint8Array([1, 2, 3]).subarray(1) as unknown as Uint8Array,
	});
	expect(BinaryPayloadSchema.decode(fromView).data).toEqual(new Uint8Array([2, 3]));

	const fromBufferObj = BinaryPayloadSchema.encode({
		data: { type: "Buffer", data: [4, 5, 6] } as unknown as Uint8Array,
	});
	expect(BinaryPayloadSchema.decode(fromBufferObj).data).toEqual(new Uint8Array([4, 5, 6]));

	const fromIndexedObj = BinaryPayloadSchema.encode({
		data: { "0": 7, "1": 8, "2": 9 } as unknown as Uint8Array,
	});
	expect(BinaryPayloadSchema.decode(fromIndexedObj).data).toEqual(new Uint8Array([7, 8, 9]));
});
