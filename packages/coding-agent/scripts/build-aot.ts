#!/usr/bin/env bun

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { buildBinary } from "./build-binary";

const packageDir = path.join(import.meta.dir, "..");

/** Reject bytecode-only binaries, including builds made with stock Bun. */
export async function verifyAotBinary(outfile: string, env: NodeJS.ProcessEnv): Promise<string> {
	const proc = Bun.spawn([outfile, "--version"], {
		cwd: path.dirname(outfile),
		env: { ...env, BUN_STATIC_HEAP_VERBOSE: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (exitCode !== 0 || !stderr.includes("[aot] image registered: true")) {
		throw new Error(`Pi-Bolt AOT verification failed (exit ${exitCode}); no usable AOT image.\n${stderr}`);
	}
	return stdout;
}

async function main(): Promise<void> {
	if (process.argv[2] === "--compile") {
		const outfile = process.argv[3];
		if (!outfile) throw new Error("Missing AOT build output path");
		await buildBinary({ outfile, bytecodeOrder: process.argv[4] });
		return;
	}
	if (Bun.env.CROSS_TARGET || Bun.env.BUN_COMPILE_EXECUTABLE_PATH) {
		throw new Error("Pi-Bolt AOT builds are host-only; unset CROSS_TARGET and BUN_COMPILE_EXECUTABLE_PATH");
	}
	if (!Bun.env.PIBOLT_BUN) {
		throw new Error("Set PIBOLT_BUN to the Pi-Bolt runtime's bun executable (not pi-bolt); see README.md");
	}
	const runtime = path.resolve(Bun.env.PIBOLT_BUN);
	const dist = path.join(packageDir, "dist");
	await fs.mkdir(dist, { recursive: true });
	await using temp = await TempDir.create(path.join(dist, ".omp-aot-"));
	const training = temp.join(process.platform === "win32" ? "omp-training.exe" : "omp-training");
	const profile = temp.join("bytecode.order");
	const candidate = temp.join(process.platform === "win32" ? "omp-aot.exe" : "omp-aot");
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATH: `${path.dirname(runtime)}${path.delimiter}${process.env.PATH ?? ""}`,
		HOME: temp.join("home"),
		XDG_CONFIG_HOME: temp.join("home", ".config"),
		XDG_DATA_HOME: temp.join("home", ".local", "share"),
		XDG_STATE_HOME: temp.join("home", ".local", "state"),
		XDG_CACHE_HOME: temp.join("home", ".cache"),
		PI_CODING_AGENT_DIR: temp.join("agent"),
		PI_PROFILE: undefined,
		OMP_PROFILE: undefined,
		BUN_AOT: "0",
		BUN_STATIC_HEAP: "0",
		BUN_AOT_JIT: "1",
		BUN_JSC_useJIT: "1",
		// Extensions may patch builtins; keep normal Bun semantics.
		BUN_JSC_useImmutableIntrinsics: undefined,
	};
	const run = async (command: string[], childEnv = env): Promise<void> => {
		const proc = Bun.spawn(command, { cwd: packageDir, env: childEnv, stdout: "inherit", stderr: "inherit" });
		if ((await proc.exited) !== 0) throw new Error(`AOT build command failed: ${command.join(" ")}`);
	};
	// A real omp profile also activates Pi-Bolt's linked-bytecode/AOT pipeline.
	await run([runtime, import.meta.path, "--compile", training]);
	await run([training, "--version"], { ...env, BUN_BYTECODE_ORDER_OUT: profile });
	if (!(await Bun.file(profile).exists()) || !/^F [a-f0-9]{16}$/m.test(await Bun.file(profile).text())) {
		throw new Error("Pi-Bolt did not record a bytecode profile; stock Bun cannot build AOT executables");
	}
	try {
		await run([runtime, import.meta.path, "--compile", candidate, profile], {
			...env,
			BUN_AOT: "1",
			BUN_STATIC_HEAP: "1",
			// omp's top-level module exceeds Pi-Bolt's 256 KiB cap; declined modules crash on startup.
			BUN_JSC_maximumAOTCandidateBytecodeSize: "524288",
			BUN_JSC_omitBytecodeFromStaticHeap: "0",
			BUN_JSC_allowAOTDeclinedFunctions: "0",
			BUN_JSC_useImmutableIntrinsics: "0",
			BUN_JSC_useJIT: "0",
		});
	} finally {
		// Native compiler exits bypass the child build script's finally.
		await run([runtime, "--cwd=../stats", "run", "gen:stats:reset"]);
	}
	const version = await verifyAotBinary(candidate, {
		...env,
		BUN_AOT: "1",
		BUN_JSC_useJIT: "1",
	});
	await run([candidate, "--smoke-test"], { ...env, BUN_AOT: "1" });
	const outfile = path.join(dist, path.basename(candidate));
	await fs.rename(candidate, outfile);
	console.log(`Pi-Bolt AOT verified: ${version.trim()}\n${outfile}`);
	// shortcut: macOS native children inherit disabled ASLR; isolate native spawning before daily use.
	if (process.platform === "darwin") console.warn("Experimental only: native shell subprocesses run without ASLR.");
}

if (import.meta.main) await main();
