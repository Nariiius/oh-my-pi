import { dlopen, FFIType } from "bun:ffi";

export type ModifierKey = "shift" | "command" | "control" | "option";

const CG_EVENT_SOURCE_STATE_COMBINED_SESSION_STATE = 0;
const CG_FLAG_SHIFT = 0x00020000;
const CG_FLAG_CONTROL = 0x00040000;
const CG_FLAG_ALTERNATE = 0x00080000;
const CG_FLAG_COMMAND = 0x00100000;

const MODIFIER_FLAGS: Record<ModifierKey, number> = {
	shift: CG_FLAG_SHIFT,
	command: CG_FLAG_COMMAND,
	control: CG_FLAG_CONTROL,
	option: CG_FLAG_ALTERNATE,
};

let getModifierFlags: (() => number) | null | undefined;

function loadNativeBinding(): (() => number) | null {
	if (getModifierFlags !== undefined) return getModifierFlags;
	getModifierFlags = null;

	if (process.platform !== "darwin") {
		return null;
	}
	if (process.arch !== "x64" && process.arch !== "arm64") {
		return null;
	}

	try {
		const { symbols } = dlopen("CoreGraphics.framework", {
			CGEventSourceFlagsState: {
				args: [FFIType.int32_t],
				returns: FFIType.u64,
			},
		});

		const fn = symbols.CGEventSourceFlagsState;
		if (typeof fn !== "function") {
			return null;
		}

		getModifierFlags = () => Number(fn(CG_EVENT_SOURCE_STATE_COMBINED_SESSION_STATE));
		return getModifierFlags;
	} catch {
		return null;
	}
}

export function isNativeModifierPressed(key: ModifierKey): boolean {
	const fn = loadNativeBinding();
	if (!fn) return false;
	try {
		const flags = fn();
		const flag = MODIFIER_FLAGS[key];
		return (flags & flag) !== 0;
	} catch {
		return false;
	}
}
