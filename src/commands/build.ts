import blessed from "blessed";
import chalk from "chalk";
import fs from "fs-extra";
import { createServer } from "http-server";
import _ from "lodash";
import path from "path";

import {
  Command,
  CommonFlags,
  Registration,
  binPath,
  gracoPkgRoot,
} from "../common";
import { Package, Workspace } from "../workspace";

interface BuildFlags {
  watch?: boolean;
  release?: boolean;
  only?: string;
}

abstract class Logger {
  start() {}
  abstract log(pkg: string, process: string, data: string): void;
  end() {}
}

const PROCESSES: [string, number][] = [
  ["build", 0.5],
  ["check", 0.5],
  ["lint", 0.5],
  ["script", 0.5],
];

class OnceLogger extends Logger {
  logs: {
    name: string;
    logs: string[];
  }[];

  constructor(readonly flags: BuildFlags) {
    super();
    this.logs = PROCESSES.map(([name]) => ({ name, logs: [] }));
  }

  // TODO: handle process
  log(_process: string, name: string, data: string) {
    if (this.flags.only) process.stdout.write(data);
    else {
      let entry = this.logs.find(r => r.name == name);
      if (!entry) throw new Error(`No logger named: ${name}`);
      entry.logs.push(data);
    }
  }

  end() {
    if (this.flags.only) return;
    this.logs.forEach(({ name, logs }) => {
      console.log(chalk.bold(name) + "\n");
      logs.forEach(log => console.log(log));
      console.log(chalk.bold(".".repeat(80)) + "\n");
    });
  }
}

class ProcessLog {
  widget: blessed.Widgets.Log;

  constructor(name: string, opts: blessed.Widgets.LogOptions) {
    this.widget = blessed.log({
      ...opts,
      border: { type: "line" },
      style: { border: { fg: "#eeeeee" } },
      label: name,
    });
  }

  log(data: string) {
    // Hacky support for ANSI codes that Vite uses.
    // Note: blessed-xterm solves this issue, but is build in a way
    // that conflicts with other plugins (it pollutes global namespace
    // which breaks sass). Need to find a more durable solution.
    if (data.includes("[2K")) this.widget.deleteBottom();
    else this.widget.log(data.replace("[1G", ""));
  }
}

class PackageLog {
  processes: { [name: string]: ProcessLog } = {};

  constructor(screen: blessed.Widgets.Screen, gridHeight: number) {
    let left = 0;
    let top = 0;
    let width = screen.width as number;
    let topRowHeight = Math.round((gridHeight * 2) / 3);
    let curHeight = topRowHeight;
    PROCESSES.forEach(([name, frac]) => {
      let boxWidth = Math.floor(frac * width);
      let process = new ProcessLog(name, {
        top,
        left,
        width: boxWidth,
        height: curHeight,
      });

      left += boxWidth;
      if (left >= width) {
        left = 0;
        top = topRowHeight;
        curHeight = gridHeight - topRowHeight;
      }

      this.processes[name] = process;
      screen.append(process.widget);
    });
  }

  log(name: string, data: string) {
    this.processes[name].log(data);
  }

  show() {
    Object.values(this.processes).forEach(log => log.widget.show());
  }

  hide() {
    Object.values(this.processes).forEach(log => log.widget.hide());
  }
}

class WatchLogger extends Logger {
  screen = blessed.screen({
    fastCSR: true,
    terminal: "xterm-256color",
    fullUnicode: true,
  });
  packages: { [name: string]: PackageLog } = {};

  constructor(ws: Workspace, only?: string[]) {
    super();
    this.screen.title = "Graco";

    let rootSet = only || ws.packages.map(p => p.name);
    let packages = ws.dependencyClosure(rootSet);
    let labels = packages.map(pkg =>
      pkg.name.startsWith("@") ? pkg.name.split("/")[1] : pkg.name
    );
    let buttonWidth = _.max(labels.map(s => s.length))! + 4;
    let buttonHeight = 3;
    let gridHeight = (this.screen.height as number) - buttonHeight;
    let buttons = packages.map((pkg, i) => {
      let log = new PackageLog(this.screen, gridHeight);
      let defaultShow =
        (only && only.length == 1 && only[0] == pkg.name) || i == 0;
      if (defaultShow) log.show();
      else log.hide();
      this.packages[pkg.name] = log;

      let button = blessed.button({
        top: gridHeight,
        left: i * buttonWidth,
        content: labels[i],
        align: "center",
        width: buttonWidth,
        height: buttonHeight,
        border: { type: "line" },
        style: {
          fg: defaultShow ? "green" : "black",
          hover: {
            bg: "#f0f0f0",
          },
        },
      });
      button.on("click", () => {
        Object.values(this.packages).forEach(log => log.hide());
        buttons.forEach(btn => {
          btn.style.fg = "black";
        });
        log.show();
        button.style.fg = "green";
        this.screen.render();
      });
      this.screen.append(button);
      return button;
    });

    // Quit on Escape, q, or Control-C.
    this.screen.key(["escape", "q", "C-c"], function (ch, key) {
      return process.exit(0);
    });
  }

  log(pkg: string, process: string, data: string) {
    this.packages[pkg].log(process, data);
  }

  start() {
    this.screen.render();
  }
}

export class BuildCommand implements Command {
  logger: Logger;

  constructor(
    readonly flags: BuildFlags & CommonFlags,
    readonly ws: Workspace
  ) {
    this.logger = flags.watch
      ? new WatchLogger(ws, flags.packages)
      : new OnceLogger(flags);
  }

  async check(pkg: Package): Promise<boolean> {
    let tscPath = path.join(binPath, "tsc");

    let opts = [pkg.target == "lib" ? "-emitDeclarationOnly" : "-noEmit"];
    if (this.flags.watch) {
      opts.push("-w");
    }

    return pkg.spawn({
      script: tscPath,
      opts,
      onData: data => this.logger.log(pkg.name, "check", data),
    });
  }

  async lint(pkg: Package): Promise<boolean> {
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

    // TODO: flag like -Werror to make lints a failure
    await pkg.spawn({
      script,
      opts,
      onData: data => this.logger.log(pkg.name, "lint", data),
    });
    return true;
  }

  async compileLibrary(pkg: Package): Promise<boolean> {
    let gracoBuildPath = path.join(
      gracoPkgRoot,
      "dist",
      "compile-entrypoint.mjs"
    );

    let opts = [gracoBuildPath, pkg.entryPoint];
    if (this.flags.watch) opts.push("-w");
    if (this.flags.release) opts.push("--release");

    return pkg.spawn({
      script: "node",
      opts,
      onData: data => this.logger.log(pkg.name, "build", data),
    });
  }

  async compileWebsite(pkg: Package): Promise<boolean> {
    let vitePath = path.join(binPath, "vite");

    let opts = ["build"];
    if (this.flags.watch) {
      opts = opts.concat(["--watch", "--minify=false"]);
    }

    return pkg.spawn({
      script: vitePath,
      opts,
      onData: data => this.logger.log(pkg.name, "build", data),
    });
  }

  async buildScript(pkg: Package): Promise<boolean> {
    let buildPath = pkg.path("build.mjs");
    if (fs.existsSync(buildPath)) {
      let opts = [buildPath];
      if (this.flags.watch) opts.push("-w");
      return await pkg.spawn({
        script: "node",
        opts,
        onData: data => this.logger.log(pkg.name, "script", data),
      });
    } else {
      return true;
    }
  }

  compile(pkg: Package): Promise<boolean> {
    if (pkg.platform == "node") return this.compileLibrary(pkg);
    /* pkg.platform == "browser" */ else return this.compileWebsite(pkg);
  }

  async serve(pkg: Package): Promise<boolean> {
    if (pkg.platform == "browser" && pkg.target == "bin" && this.flags.watch) {
      let server = createServer({
        root: pkg.path("dist"),
      });
      server.listen(8000);
    }

    return true;
  }

  parallel(): boolean {
    return this.flags.watch || false;
  }

  async run(pkg: Package): Promise<boolean> {
    await fs.mkdirp(pkg.path("dist"));

    this.logger.start();

    // http-server causes an unavoidable node warning,
    // see: https://github.com/http-party/http-server/issues/537
    // therefore we silence the warning,
    // see: https://stackoverflow.com/a/73525885
    let emit = process.emit;
    process.emit = function (name: any, data: any) {
      if (name === `warning` && typeof data === `object`) {
        return false;
      }
      return emit.apply(process, arguments as any);
    } as any;

    let processes: { [k: string]: (pkg: Package) => Promise<boolean> } = {
      check: this.check,
      compile: this.compile,
      lint: this.lint,
      buildScript: this.buildScript,
      serve: this.serve,
    };
    let toRun = this.flags.only ? [this.flags.only] : Object.keys(processes);

    let results = await Promise.all(
      toRun.map(k => processes[k].call(this, pkg))
    );

    this.logger.end();
    return results.every(x => x);
  }

  static register: Registration = program =>
    program
      .command("build")
      .option("-w, --watch", "Watch for changes and rebuild")
      .option("-r, --release", "Build for production")
      .option("--only <process>", "Only run given process");
}
