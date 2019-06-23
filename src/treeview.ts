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
  Command,
  TreeView
} from "vscode";
import {
  TreeViewNode,
  MetalsTreeViewChildren,
  MetalsTreeViewDidChange,
  MetalsTreeViewVisibilityDidChange
} from "./protocol";

export function startTreeView(
  client: LanguageClient,
  out: OutputChannel
): Disposable[] {
  let views: Map<string, MetalsTreeDataProvider> = new Map();
  let viewIds: string[] = ["build", "compile"];
  const treeViews = viewIds.map(viewId => {
    let provider = new MetalsTreeDataProvider(client, out, viewId, views);
    views.set(viewId, provider);
    const view = window.createTreeView(viewId, {
      treeDataProvider: provider
    });
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
      let dataProvider = views.get(node.viewId);
      if (!dataProvider) return;
      if (node.nodeUri) {
        dataProvider.items.set(node.nodeUri, node);
      }
      if (node.nodeUri) {
        dataProvider.didChange.fire(node.nodeUri);
      } else {
        dataProvider.didChange.fire(undefined);
      }
    });
  });
  return ([] as Disposable[]).concat(...treeViews);
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
    this.out.appendLine("getTreeItem() " + JSON.stringify(uri));
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
  getChildren(uri?: string): Thenable<string[]> {
    this.out.appendLine("getChildren() " + JSON.stringify(uri));
    return this.client
      .sendRequest(MetalsTreeViewChildren.type, {
        viewId: this.viewId,
        nodeUri: uri
      })
      .then(result => {
        result.nodes.forEach(n => {
          if (n.nodeUri) {
            this.items.set(n.nodeUri, n);
          }
        });
        return result.nodes.map(n => n.nodeUri).filter(notEmpty);
      });
  }
}

function notEmpty<TValue>(value: TValue | null | undefined): value is TValue {
  return value !== null && value !== undefined;
}
