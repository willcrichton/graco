import { Graco } from "./harness";

describe("init", () => {
  it("creates configuration files", () =>
    Graco.with({ src: "" }, async graco => {
      graco.test(".eslintrc.cjs");
      graco.test(".prettierrc.cjs");
      graco.test("tsconfig.json");
    }));

  it("configures vite for browser packages", () => {
    let src = { "src/index.ts": "" };
    return Graco.with({ src }, async graco => {
      graco.test("vite.config.ts");
    });
  });

  it("configures monorepos", () => {
    let src = {
      "packages/foo/src/lib.ts": `export let foo = "bar";\n`,
      "packages/foo/package.json": `{"name": "foo", "version": "0.0.1", "main": "dist/lib.js"}`,
    };
    return Graco.with({ src }, async graco => {
      graco.test("pnpm-workspace.yaml");
      graco.test("packages/foo/tsconfig.json");
    });
  });

  it("is idempotent", () =>
    Graco.with({ src: "" }, async graco => {
      expect(await graco.run("init")).toBe(0);
    }));
});
