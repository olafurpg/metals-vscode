import { LanguageClient, Disposable } from "vscode-languageclient";
import {
  TreeDataProvider,
  TreeItem,
  Event,
  EventEmitter,
  TreeItemCollapsibleState,
  window,
  OutputChannel,
  Uri,
  TreeView
} from "vscode";
import {
  TreeViewNode,
  MetalsTreeViews,
  MetalsTreeViewChildren,
  MetalsTreeViewDidChange,
  MetalsTreeViewVisibilityDidChange,
  MetalsRevealTreeView,
  MetalsTreeViewParent
} from "./protocol";

export function startTreeView(
  client: LanguageClient,
  out: OutputChannel
): MetalsTreeViews {
  let views: Map<string, MetalsTreeDataProvider> = new Map();
  let treeViews: Map<string, TreeView<string>> = new Map();
  let viewIds: string[] = ["build", "compile"];
  const disposables = viewIds.map(viewId => {
    let provider = new MetalsTreeDataProvider(client, out, viewId, views);
    views.set(viewId, provider);
    const view = window.createTreeView(viewId, {
      treeDataProvider: provider
    });
    treeViews.set(viewId, view);
    const onDidChangeVisibility = view.onDidChangeVisibility(e => {
      out.appendLine(`view: ${viewId} visible: ${e.visible}`);
      client.sendNotification(MetalsTreeViewVisibilityDidChange.type, {
        viewId: viewId,
        visible: e.visible
      });
    });
    return [view, onDidChangeVisibility];
  });
  client.onNotification(MetalsTreeViewDidChange.type, params => {
    params.nodes.forEach(node => {
      let provider = views.get(node.viewId);
      if (!provider) return;
      if (node.nodeUri) {
        provider.items.set(node.nodeUri, node);
      }
      if (node.nodeUri) {
        provider.didChange.fire(node.nodeUri);
      } else {
        provider.didChange.fire(undefined);
      }
    });
  });
  return {
    disposables: ([] as Disposable[]).concat(...disposables),
    reveal(params: MetalsRevealTreeView): void {
      out.appendLine(JSON.stringify(params));
      const view = treeViews.get(params.viewId);
      const x = views.get(params.viewId);
      out.appendLine(JSON.stringify(params));
      if (view) {
        view.reveal(params.uri, {
          expand: 3,
          select: false,
          focus: true
        });
      } else {
        out.appendLine(`unknown view: ${params.viewId}`);
      }
    }
  };
}

class MetalsTreeDataProvider implements TreeDataProvider<string> {
  didChange = new EventEmitter<string>();
  onDidChangeTreeData?: Event<string> = this.didChange.event;
  items: Map<string, TreeViewNode> = new Map();
  constructor(
    readonly client: LanguageClient,
    readonly out: OutputChannel,
    readonly viewId: string,
    readonly views: Map<string, MetalsTreeDataProvider>
  ) {}
  getTreeItem(uri: string): TreeItem {
    this.out.appendLine("getTreeItem() " + uri);
    const item = this.items.get(uri);
    if (!item) return {};

    const result: TreeItem = {
      label: item.label,
      id: item.nodeUri,
      resourceUri: item.nodeUri ? Uri.parse(item.nodeUri) : undefined,
      collapsibleState:
        item.collapseState == "collapsed"
          ? TreeItemCollapsibleState.Collapsed
          : item.collapseState == "expanded"
          ? TreeItemCollapsibleState.Expanded
          : TreeItemCollapsibleState.None,
      command: item.command,
      tooltip: item.tooltip
    };
    result.collapsibleState;
    return result;
  }
  getParent(uri: string): Thenable<string | undefined> {
    this.out.appendLine("getParent() " + JSON.stringify(uri));
    return this.client
      .sendRequest(MetalsTreeViewParent.type, {
        viewId: this.viewId,
        nodeUri: uri
      })
      .then(
        result => result.uri,
        e => {
          this.out.appendLine(JSON.stringify(e));
          return undefined;
        }
      );
  }
  getChildren(uri?: string): Thenable<string[] | undefined> {
    this.out.appendLine("getChildren() " + JSON.stringify(uri));
    return this.client
      .sendRequest(MetalsTreeViewChildren.type, {
        viewId: this.viewId,
        nodeUri: uri
      })
      .then(
        result => {
          result.nodes.forEach(n => {
            if (n.nodeUri) {
              this.items.set(n.nodeUri, n);
            }
          });
          return result.nodes.map(n => n.nodeUri).filter(notEmpty);
        },
        e => {
          this.out.appendLine(JSON.stringify(e));
          return undefined;
        }
      );
  }
}

function notEmpty<TValue>(value: TValue | null | undefined): value is TValue {
  return value !== null && value !== undefined;
}
