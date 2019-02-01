"use strict";

import * as path from "path";
import { spawn, ChildProcessPromise } from "promisify-child-process";
import {
  workspace,
  ExtensionContext,
  window,
  commands,
  StatusBarAlignment,
  ProgressLocation,
  IndentAction,
  languages,
  WebviewPanel,
  ViewColumn,
  OutputChannel,
  ConfigurationTarget
} from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  RevealOutputChannelOn,
  ExecuteCommandRequest,
  ShutdownRequest,
  ExitNotification,
  CancellationToken
} from "vscode-languageclient";
import { exec } from "child_process";
import { ClientCommands } from "./client-commands";
import {
  MetalsSlowTask,
  MetalsStatus,
  MetalsDidFocus,
  ExecuteClientCommand,
  MetalsInputBox,
  MetalsTreeViewDidChange
} from "./protocol";
import { LazyProgress } from "./lazy-progress";
import * as fs from "fs";
import * as semver from "semver";
import { getJavaHome } from "./getJavaHome";
import { startTreeView } from "./treeview";
import { start } from "repl";

const outputChannel = window.createOutputChannel("Metals");
const openSettingsAction = "Open settings";
const openSettingsCommand = "workbench.action.openSettings";

export async function activate(context: ExtensionContext) {
  detectLaunchConfigurationChanges();
  checkServerVersion();

  getJavaHome()
    .then(javaHome => fetchAndLaunchMetals(context, javaHome))
    .catch(err => {
      const message =
        "Unable to find Java 8 home. To fix this problem, update the 'Java Home' setting to point to a Java 8 home directory";
      outputChannel.appendLine(message);
      outputChannel.appendLine(err);
      window.showErrorMessage(message, openSettingsAction).then(choice => {
        if (choice === openSettingsAction) {
          commands.executeCommand("workbench.action.openSettings");
        }
      });
    });
}

function fetchAndLaunchMetals(context: ExtensionContext, javaHome: string) {
  if (fs.existsSync(dottyIdeArtifact())) {
    outputChannel.appendLine(
      `Metals will not start since Dotty is enabled for this workspace. ` +
        `To enable Metals, remove the file ${dottyIdeArtifact()} and run 'Reload window'`
    );
    return;
  }

  outputChannel.appendLine(`Java home: ${javaHome}`);
  const javaPath = path.join(javaHome, "bin", "java");
  const coursierPath = path.join(context.extensionPath, "./coursier");

  const config = workspace.getConfiguration("metals");
  const serverVersionConfig: string = config.get("serverVersion");
  const serverVersion = serverVersionConfig
    ? serverVersionConfig
    : config.inspect("serverVersion").defaultValue;
  const serverProperties: string[] = workspace
    .getConfiguration("metals")
    .get("serverProperties")
    .toString()
    .split(" ")
    .filter(e => e.length > 0);

  const process = spawn(
    javaPath,
    serverProperties.concat([
      "-jar",
      coursierPath,
      "fetch",
      "-p",
      "--ttl",
      // Use infinite ttl to avoid redunant "Checking..." logs when using SNAPSHOT
      // versions. Metals SNAPSHOT releases are effectively immutable since we
      // never publish the same version twice.
      "Inf",
      `org.scalameta:metals_2.12:${serverVersion}`,
      "-r",
      "bintray:scalacenter/releases",
      "-r",
      "sonatype:releases",
      "-r",
      "sonatype:snapshots",
      "-p"
    ]),
    { env: { COURSIER_NO_TERM: "true" } }
  );
  const title = `Downloading Metals v${serverVersion}`;
  trackDownloadProgress(title, outputChannel, process).then(
    classpath => {
      launchMetals(
        outputChannel,
        context,
        javaPath,
        classpath,
        serverProperties
      );
    },
    () => {
      const msg =
        `Failed to download Metals, make sure you have an internet connection, ` +
        `the Metals version '${serverVersion}' is correct and the Java Home '${javaPath}' is valid. ` +
        `You can configure the Metals version and Java Home under settings.`;
      outputChannel.show();
      window.showErrorMessage(msg, openSettingsAction).then(choice => {
        if (choice === openSettingsAction) {
          commands.executeCommand(openSettingsCommand);
        }
      });
    }
  );
}

function launchMetals(
  outputChannel: OutputChannel,
  context: ExtensionContext,
  javaPath: string,
  metalsClasspath: string,
  serverProperties: string[]
) {
  // Make editing Scala docstrings slightly nicer.
  enableScaladocIndentation();

  const baseProperties = [
    `-Dmetals.input-box=on`,
    `-Dmetals.client=vscode`,
    `-Xss4m`,
    `-Xms100m`,
    `-XX:+UseG1GC`,
    `-XX:+UseStringDeduplication`
  ];
  const mainArgs = ["-classpath", metalsClasspath, "scala.meta.metals.Main"];
  // let user properties override base properties
  const launchArgs = baseProperties
    .concat(jvmopts())
    .concat(serverProperties)
    .concat(mainArgs);

  const serverOptions: ServerOptions = {
    run: { command: javaPath, args: launchArgs },
    debug: { command: javaPath, args: launchArgs }
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "scala" }],
    synchronize: {
      configurationSection: "metals"
    },
    revealOutputChannelOn: RevealOutputChannelOn.Never,
    outputChannel: outputChannel
  };

  const client = new LanguageClient(
    "metals",
    "Metals",
    serverOptions,
    clientOptions
  );

  function registerCommand(command: string, callback: (...args: any[]) => any) {
    context.subscriptions.push(commands.registerCommand(command, callback));
  }

  registerCommand("metals.restartServer", () => {
    // First try to gracefully shutdown the server with LSP `shutdown` and `exit`.
    // If Metals doesn't respond within 4 seconds we kill the process.
    const timeout = (ms: number) =>
      new Promise((_resolve, reject) => setTimeout(reject, ms));
    const gracefullyTerminate = client
      .sendRequest(ShutdownRequest.type)
      .then(() => {
        client.sendNotification(ExitNotification.type);
        window.showInformationMessage("Metals is restarting");
      });
    Promise.race([gracefullyTerminate, timeout(4000)]).catch(() => {
      window.showWarningMessage(
        "Metals is unresponsive, killing the process and starting a new server."
      );
      const serverPid = client["_serverProcess"].pid;
      exec(`kill ${serverPid}`);
    });
  });

  // startTreeView(client, outputChannel);

  context.subscriptions.push(client.start());

  client.onReady().then(_ => {
    let doctor: WebviewPanel;
    function getDoctorPanel(isReload: boolean): WebviewPanel {
      if (!doctor) {
        doctor = window.createWebviewPanel(
          "metals-doctor",
          "Metals Doctor",
          ViewColumn.Active
        );
        context.subscriptions.push(doctor);
        doctor.onDidDispose(() => {
          doctor = undefined;
        });
      } else if (!isReload) {
        doctor.reveal();
      }
      return doctor;
    }
    [
      "build-import",
      "build-connect",
      "sources-scan",
      "doctor-run",
      "compile-cascade",
      "compile-cancel"
    ].forEach(command => {
      registerCommand("metals." + command, async () =>
        client.sendRequest(ExecuteCommandRequest.type, { command: command })
      );
    });

    let channelOpen = false;
    const clientCommands: {
      [k in keyof typeof ClientCommands]: (...args: unknown[]) => unknown
    } = {
      focusDiagnostics: () =>
        commands.executeCommand("workbench.action.problems.focus"),
      runDoctor: () => commands.executeCommand("metals.doctor-run"),
      // Open or close the extension output channel. The user may have to trigger
      // this command twice in case the channel has been focused through another
      // button. There is no `isFocused` API to check if a channel is focused.
      toggleLogs: () => {
        if (channelOpen) {
          client.outputChannel.hide();
          channelOpen = false;
        } else {
          client.outputChannel.show(true);
          channelOpen = true;
        }
      }
    };
    Object.keys(clientCommands).forEach(k =>
      registerCommand(k, clientCommands[k])
    );

    // Handle the metals/executeClientCommand extension notification.
    client.onNotification(ExecuteClientCommand.type, params => {
      const isRun = params.command === "metals-doctor-run";
      const isReload = params.command === "metals-doctor-reload";
      if (isRun || (doctor && isReload)) {
        const html = params.arguments[0];
        if (typeof html === "string") {
          const panel = getDoctorPanel(isReload);
          panel.webview.html = html;
        }
      }
      // Ignore other commands since they are less important.
    });

    // The server updates the client with a brief text message about what
    // it is currently doing, for example "Compiling..".
    const item = window.createStatusBarItem(StatusBarAlignment.Right, 100);
    item.command = ClientCommands.toggleLogs;
    item.hide();
    client.onNotification(MetalsStatus.type, params => {
      item.text = params.text;
      if (params.show) {
        item.show();
      } else if (params.hide) {
        item.hide();
      }
      if (params.tooltip) {
        item.tooltip = params.tooltip;
      }
      if (params.command) {
        item.command = params.command;
        commands.getCommands().then(values => {
          if (values.indexOf(params.command) < 0) {
            registerCommand(params.command, () => {
              client.sendRequest(ExecuteCommandRequest.type, {
                command: params.command
              });
            });
          }
        });
      } else {
        item.command = undefined;
      }
    });

    window.onDidChangeActiveTextEditor(editor => {
      if (editor.document.languageId == "scala") {
        client.sendNotification(
          MetalsDidFocus.type,
          editor.document.uri.toString()
        );
      }
    });

    client.onRequest(MetalsInputBox.type, (options, requestToken) => {
      return window.showInputBox(options, requestToken).then(result => {
        if (result === undefined) {
          return { cancelled: true };
        } else {
          return { value: result };
        }
      });
    });

    // Long running tasks such as "import project" trigger start a progress
    // bar with a "cancel" button.
    client.onRequest(MetalsSlowTask.type, (params, requestToken) => {
      return new Promise(requestResolve => {
        window.withProgress(
          {
            location: ProgressLocation.Notification,
            title: params.message,
            cancellable: true
          },
          (progress, progressToken) => {
            // Open logs so user can keep track of progress.
            client.outputChannel.show(true);

            // Update total running time every second.
            let seconds = 0;
            const interval = setInterval(() => {
              seconds += 1;
              progress.report({ message: readableSeconds(seconds) });
            }, 1000);

            // Hide logs and clean up resources on completion.
            function onComplete() {
              clearInterval(interval);
              client.outputChannel.hide();
            }

            // Client triggered cancelation from the progress notification.
            progressToken.onCancellationRequested(() => {
              onComplete();
              requestResolve({ cancel: true });
            });

            return new Promise(progressResolve => {
              // Server completed long running task.
              requestToken.onCancellationRequested(() => {
                onComplete();
                progress.report({ increment: 100 });
                setTimeout(() => progressResolve(), 1000);
              });
            });
          }
        );
      });
    });

    context.subscriptions.concat(startTreeView(client, outputChannel));
  });
}

function trackDownloadProgress(
  title: string,
  output: OutputChannel,
  download: ChildProcessPromise
): Promise<string> {
  const progress = new LazyProgress();
  let stdout: Buffer[] = [];
  download.stdout.on("data", (out: Buffer) => {
    stdout.push(out);
  });
  download.stderr.on("data", (err: Buffer) => {
    const msg = err.toString().trim();
    if (!msg.startsWith("Downloading")) {
      output.appendLine(msg);
    }
    progress.startOrContinue(title, output, download);
  });
  download.on("close", (code: number) => {
    if (code != 0) {
      // something went wrong, print stdout to the console to help troubleshoot.
      stdout.forEach(buffer => output.append(buffer.toString()));
      throw Error(`coursier exit: ${code}`);
    }
  });
  return download.then(() =>
    stdout.map(buffer => buffer.toString().trim()).join("")
  );
}

function readableSeconds(totalSeconds: number): string {
  const minutes = (totalSeconds / 60) | 0;
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    if (seconds === 0) return `${minutes}m`;
    else return `${minutes}m${seconds}s`;
  } else {
    return `${seconds}s`;
  }
}

function enableScaladocIndentation() {
  // Adapted from:
  // https://github.com/Microsoft/vscode/blob/9d611d4dfd5a4a101b5201b8c9e21af97f06e7a7/extensions/typescript/src/typescriptMain.ts#L186
  languages.setLanguageConfiguration("scala", {
    indentationRules: {
      // ^(.*\*/)?\s*\}.*$
      decreaseIndentPattern: /^(.*\*\/)?\s*\}.*$/,
      // ^.*\{[^}"']*$
      increaseIndentPattern: /^.*\{[^}"']*$/
    },
    wordPattern: /(-?\d*\.\d\w*)|([^\`\~\!\@\#\%\^\&\*\(\)\-\=\+\[\{\]\}\\\|\;\:\'\"\,\.\<\>\/\?\s]+)/g,
    onEnterRules: [
      {
        // e.g. /** | */
        beforeText: /^\s*\/\*\*(?!\/)([^\*]|\*(?!\/))*$/,
        afterText: /^\s*\*\/$/,
        action: { indentAction: IndentAction.IndentOutdent, appendText: " * " }
      },
      {
        // e.g. /** ...|
        beforeText: /^\s*\/\*\*(?!\/)([^\*]|\*(?!\/))*$/,
        action: { indentAction: IndentAction.None, appendText: " * " }
      },
      {
        // e.g.  * ...|
        beforeText: /^(\t|(\ \ ))*\ \*(\ ([^\*]|\*(?!\/))*)?$/,
        action: { indentAction: IndentAction.None, appendText: "* " }
      },
      {
        // e.g.  */|
        beforeText: /^(\t|(\ \ ))*\ \*\/\s*$/,
        action: { indentAction: IndentAction.None, removeText: 1 }
      },
      {
        // e.g.  *-----*/|
        beforeText: /^(\t|(\ \ ))*\ \*[^/]*\*\/\s*$/,
        action: { indentAction: IndentAction.None, removeText: 1 }
      }
    ]
  });
}

function dottyIdeArtifact(): string {
  return path.join(workspace.rootPath, ".dotty-ide-artifact");
}

function detectLaunchConfigurationChanges() {
  workspace.onDidChangeConfiguration(e => {
    const promptRestartKeys = ["serverVersion", "serverProperties", "javaHome"];
    const shouldPromptRestart = promptRestartKeys.some(k =>
      e.affectsConfiguration(`metals.${k}`)
    );
    if (shouldPromptRestart) {
      window
        .showInformationMessage(
          "Server launch configuration change detected. Reload the window for changes to take effect",
          "Reload Window",
          "Not now"
        )
        .then(choice => {
          if (choice === "Reload Window") {
            commands.executeCommand("workbench.action.reloadWindow");
          }
        });
    }
  });
}

function checkServerVersion() {
  const config = workspace.getConfiguration("metals");
  const serverVersion = config.get<string>("serverVersion");
  const latestServerVersion = config.inspect<string>("serverVersion")
    .defaultValue;
  const isOutdated = (() => {
    try {
      return semver.lt(serverVersion, latestServerVersion);
    } catch (_e) {
      // serverVersion has an invalid format
      // ignore the exception here, and let subsequent checks handle this
      return false;
    }
  })();

  if (isOutdated) {
    const upgradeAction = `Upgrade to ${latestServerVersion} now`;

    window
      .showWarningMessage(
        `You are running an out-of-date version of Metals. Latest version is ${latestServerVersion}, but you have configured a custom server version ${serverVersion}`,
        upgradeAction,
        openSettingsAction,
        "Not now"
      )
      .then(choice => {
        switch (choice) {
          case upgradeAction:
            config.update(
              "serverVersion",
              latestServerVersion,
              ConfigurationTarget.Global
            );
            break;
          case openSettingsAction:
            commands.executeCommand(openSettingsCommand);
            break;
        }
      });
  }
}

function jvmopts(): string[] {
  const opts: string[] = [];
  const jvmoptsPath = path.join(workspace.rootPath, ".jvmopts");
  if (fs.existsSync(jvmoptsPath)) {
    outputChannel.appendLine("JVM options: " + jvmoptsPath);
    const text = fs.readFileSync(jvmoptsPath, "utf8");
    text.match(/[^\r\n]+/g).forEach(line => {
      if (
        line.startsWith("-") &&
        // We care most about enabling options like HTTP proxy settings.
        // We don't include memory options because Metals does not have the same
        // memory requirements as for example the sbt build.
        !line.startsWith("-Xms") &&
        !line.startsWith("-Xmx") &&
        !line.startsWith("-Xss")
      ) {
        opts.push(line);
      }
    });
  }
  return opts;
}
