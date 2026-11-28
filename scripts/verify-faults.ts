#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Console, Effect, Schema } from "effect";

const ROOT = path.resolve(import.meta.dir, "..");
const EFFECT_TSGO_BIN = path.join(ROOT, "node_modules", ".bin", "effect-tsgo");

class FaultCheckError extends Schema.TaggedError<
  FaultCheckError,
  { readonly brand: unique symbol }
>()("FaultCheckError", {
  message: Schema.String,
}) {}

interface PlantCase {
  readonly id: string;
  readonly check: "lint" | "test";
  readonly targetFile: string;
  readonly find: string;
  readonly replace: string;
  readonly expected: string;
}

const PLANTS: ReadonlyArray<PlantCase> = [
  {
    id: "drop-approval-abort-signal",
    check: "lint",
    targetFile: "src/AgentBridge.ts",
    find: "try: (signal) => {",
    replace: "try: () => {\n                const signal = undefined;",
    expected: "require-try-promise-abort-signal",
  },
  {
    id: "drop-row-query-excess-property",
    check: "lint",
    targetFile: "src/AgentBridge.ts",
    find: 'const decodeRowQuery = Schema.decodeUnknownSync(RowQuerySchema, {\n  onExcessProperty: "error",\n});',
    replace: "const decodeRowQuery = Schema.decodeUnknownSync(RowQuerySchema);",
    expected: "require-excess-property-error",
  },
  {
    id: "cloud-sdk-in-src",
    check: "lint",
    targetFile: "src/index.ts",
    find: 'export * from "./AgentBridge.js";',
    replace:
      'import type { S3Client } from "@aws-sdk/client-s3";\nexport type Leaked = S3Client;\nexport * from "./AgentBridge.js";',
    expected: "no-cloud-sdk-in-src",
  },
];

const runCmd = Effect.fn("runCmd")(function* (
  cmd: ReadonlyArray<string>,
  cwd: string,
) {
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const proc = Bun.spawn([...cmd], { cwd, stdout: "pipe", stderr: "pipe" });
      const onAbort = () => {
        proc.kill();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        const exitCode = await proc.exited;
        const stdout = await new Response(proc.stdout).text();
        const stderr = await new Response(proc.stderr).text();
        return { exitCode, output: `${stdout}\n${stderr}` };
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
    catch: (error) =>
      new FaultCheckError({
        message: error instanceof Error ? error.message : String(error),
      }),
  });
});

const copyTree = Effect.fn("copyTree")(function* () {
  return yield* Effect.uninterruptible(
    Effect.tryPromise({
      try: async () => {
        const tmp = await fs.mkdtemp(
          path.join(os.tmpdir(), "effect-ui-agent-faults-"),
        );
        await fs.symlink(
          path.join(ROOT, "node_modules"),
          path.join(tmp, "node_modules"),
        );
        for (const item of [
          "src",
          "tests",
          "package.json",
          "tsconfig.json",
          ".oxlintrc.json",
          "bunfig.toml",
        ]) {
          await fs.cp(path.join(ROOT, item), path.join(tmp, item), {
            recursive: true,
          });
        }
        return tmp;
      },
      catch: (error) =>
        new FaultCheckError({
          message: error instanceof Error ? error.message : String(error),
        }),
    }),
  );
});

const removeDir = (dir: string) =>
  Effect.uninterruptible(
    Effect.tryPromise({
      try: () => fs.rm(dir, { recursive: true, force: true }),
      catch: () => undefined,
    }),
  ).pipe(Effect.ignore);

const main = Effect.gen(function* () {
  const cleanDir = yield* copyTree();
  try {
    const clean = yield* runCmd(
      [EFFECT_TSGO_BIN, "oxlint", "--type-aware", "src"],
      cleanDir,
    );
    if (clean.exitCode !== 0) {
      yield* Console.error(`CLEAN CHECK FAILED:\n${clean.output}`);
      return 1;
    }
  } finally {
    yield* removeDir(cleanDir);
  }

  let caught = 0;
  const failures: Array<string> = [];

  for (const plant of PLANTS) {
    const dir = yield* copyTree();
    try {
      const target = path.join(dir, plant.targetFile);
      const original = yield* Effect.tryPromise({
        try: (signal) => fs.readFile(target, { encoding: "utf8", signal }),
        catch: (error) =>
          new FaultCheckError({
            message: error instanceof Error ? error.message : String(error),
          }),
      });
      if (!original.includes(plant.find)) {
        failures.push(`${plant.id}: NOT APPLIED`);
        continue;
      }
      const mutated = original.replace(plant.find, plant.replace);
      yield* Effect.tryPromise({
        try: (signal) =>
          fs.writeFile(target, mutated, { encoding: "utf8", signal }),
        catch: (error) =>
          new FaultCheckError({
            message: error instanceof Error ? error.message : String(error),
          }),
      });
      const res = yield* runCmd(
        [EFFECT_TSGO_BIN, "oxlint", "--type-aware", "src"],
        dir,
      );
      if (res.exitCode !== 0 && res.output.includes(plant.expected)) {
        caught += 1;
      } else {
        failures.push(
          `${plant.id}: MISSED (exit=${String(res.exitCode)})\n${res.output.slice(0, 300)}`,
        );
      }
    } finally {
      yield* removeDir(dir);
    }
  }

  if (failures.length > 0) {
    yield* Console.error(
      `Planted faults missed (${String(caught)}/${String(PLANTS.length)}):\n${failures.join("\n")}`,
    );
    return 1;
  }

  yield* Console.log(
    `PASS: clean copy green; ${String(caught)}/${String(PLANTS.length)} planted faults caught.`,
  );
  return 0;
});

process.exitCode = await Effect.runPromise(main);
