import blessed from "blessed";
import chalk from "chalk";
import * as commander from "commander";
import esbuild, { Plugin } from "esbuild";
import { sassPlugin } from "esbuild-sass-plugin";
import fs from "fs-extra";
import _ from "lodash";
import { IDependencyMap, IPackageJson } from "package-json-type";
import path from "path";

import { Command } from "./command";
import { binPath, findJsFile, getManifest, spawn } from "./common";

interface BuildFlags {
  watch?: boolean;
  release?: boolean;
}

abstract class Logger {
  start() {}
  abstract register(name: string): void;
  abstract log(name: string, data: string): void;
  end() {}
}

class OnceLogger extends Logger {
  logs: {
    name: string;
    logs: string[];
  }[] = [];

  register(name: string) {
    this.logs.push({ name, logs: [] });
  }

  log(name: string, data: string) {
    let entry = this.logs.find(r => r.name == name);
    if (!entry) throw new Error(`No logger named: ${name}`);
    entry.logs.push(data);
  }

  end() {
    this.logs.forEach(({ name, logs }) => {
      console.log(chalk.bold(name) + "\n");
      logs.forEach(log => console.log(log));
      console.log(chalk.bold(".".repeat(80)) + "\n");
    });
  }
}

class WatchLogger extends Logger {
  screen = blessed.screen({
    fastCSR: true,
    terminal: "xterm-256color",
    fullUnicode: true,
  });
  boxes: blessed.Widgets.Log[];
  boxMap: { [name: string]: number } = {};

  constructor() {
    super();
    this.screen.title = "my window title";
    this.boxes = _.range(0, 2)
      .map(x =>
        _.range(0, 2).map(y =>
          blessed.log({
            top: x == 0 ? "0" : "50%",
            left: y == 0 ? "0" : "50%",
            width: "50%",
            height: "50%",
            border: { type: "line" },
            style: { border: { fg: "#eeeeee" } },
          })
        )
      )
      .flat();

    this.boxes.forEach(box => this.screen.append(box));

    // Quit on Escape, q, or Control-C.
    this.screen.key(["escape", "q", "C-c"], function (ch, key) {
      return process.exit(0);
    });
  }

  register(name: string) {
    let i = Object.keys(this.boxMap).length;
    this.boxMap[name] = i;
    this.boxes[i].setLabel(name);
  }

  log(name: string, data: string) {
    this.boxes[this.boxMap[name]].log(data);
  }

  start() {
    this.screen.render();
  }
}

export class BuildCommand extends Command {
  logger: Logger;

  constructor(readonly flags: BuildFlags, readonly manifest: IPackageJson) {
    super();
    this.logger = flags.watch ? new WatchLogger() : new OnceLogger();
  }

  async check(): Promise<boolean> {
    let tscPath = path.join(binPath, "tsc");

    let opts = ["-emitDeclarationOnly"];
    if (this.flags.watch) {
      opts.push("-w");
    }

    this.logger.register("tsc");
    return spawn(tscPath, opts, data => this.logger.log("tsc", data));
  }

  async lint(): Promise<boolean> {
    let eslintPath = path.join(binPath, "eslint");
    let eslintOpts = ["--ext", "js,ts,tsx", "src"];

    let script, opts;
    if (this.flags.watch) {
      let watchPath = path.join(binPath, "watch");
      script = watchPath;
      opts = [`${eslintPath} ${eslintOpts.join(" ")}`, `src`];
    } else {
      script = eslintPath;
      opts = eslintOpts;
    }

    this.logger.register("eslint");

    return spawn(script, opts, data => this.logger.log("eslint", data));
  }

  async compileLibrary(entry: string): Promise<boolean> {
    let keys = (map?: IDependencyMap) => Object.keys(map || {});
    let external = keys(this.manifest.peerDependencies).concat(
      keys(this.manifest.dependencies)
    );

    let logger = this.logger;
    logger.register("esbuild");

    let plugins: Plugin[] = [
      sassPlugin(),
      {
        name: "files",
        setup(build) {
          let loaders = ["url", "raw"];
          loaders.forEach(loader => {
            let filter = new RegExp(`\\?${loader}$`);
            build.onResolve({ filter }, args => {
              let p = args.path.slice(0, -(loader.length + 1));
              p = path.resolve(path.join(args.resolveDir, p));
              return { path: p, namespace: loader };
            });
          });

          let toCopy = new Set<string>();
          build.onLoad({ filter: /.*/, namespace: "url" }, args => {
            toCopy.add(args.path);
            let url = JSON.stringify("./" + path.basename(args.path));
            let contents = `export default new URL(${url}, import.meta.url);`;
            return { contents, loader: "js" };
          });
          build.onEnd(() => {
            toCopy.forEach(p => {
              fs.copyFileSync(
                p,
                path.join(build.initialOptions.outdir!, path.basename(p))
              );
            });
          });

          build.onLoad({ filter: /.*/, namespace: "raw" }, args => {
            let contents = fs.readFileSync(args.path, "utf-8");
            return { contents, loader: "text" };
          });
        },
      },
      {
        name: "logging",
        setup(build) {
          build.onEnd(result => {
            if (!result.errors.length) logger.log("esbuild", "Build complete!");
            result.errors.forEach(error => {
              logger.log(
                "esbuild",
                chalk.red("✘ ") +
                  chalk.whiteBright.bgRed(" ERROR ") +
                  " " +
                  chalk.bold(error.text)
              );
              if (error.location) {
                logger.log(
                  "esbuild",
                  `\t${error.location.file}:${error.location.line}:${error.location.column}`
                );
              }
            });
            logger.log("esbuild", "\n");
          });
        },
      },
    ];

    try {
      let result = await esbuild.build({
        entryPoints: [entry],
        format: "esm",
        outdir: "dist",
        bundle: true,
        watch: this.flags.watch,
        minify: this.flags.release,
        sourcemap: !this.flags.release,
        external,
        plugins,
        logLevel: "silent",
      });
      return result.errors.length == 0;
    } catch (e) {
      return false;
    }
  }

  async compileWebsite(_entry: string): Promise<boolean> {
    let vitePath = path.join(binPath, "vite");

    let opts = ["build", "--minify=false"];
    if (this.flags.watch) {
      opts.push("-w");
    }

    this.logger.register("vite");
    return spawn(vitePath, opts, data => this.logger.log("vite", data));
  }

  compile(): Promise<boolean> {
    let lib = findJsFile("src/lib");
    if (lib) return this.compileLibrary(lib);

    let index = findJsFile("src/index");
    if (index) return this.compileWebsite(index);

    throw new Error("No valid entry point");
  }

  async run(): Promise<boolean> {
    await fs.rm("dist", { recursive: true, force: true });

    this.logger.start();
    let results = await Promise.all([
      this.check(),
      this.lint(),
      this.compile(),
    ]);

    let buildPath = "build.mjs";
    if (fs.existsSync(buildPath))
      await import(path.join(process.cwd(), buildPath));

    this.logger.end();
    return results.every(x => x);
  }

  static register(program: commander.Command) {
    program
      .command("build")
      .option("-w, --watch", "Watch for changes and rebuild")
      .option("-r, --release", "Build for production")
      .action(flags => new BuildCommand(flags, getManifest()).main());
  }
}
