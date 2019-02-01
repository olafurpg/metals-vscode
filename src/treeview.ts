"use strict";

import {
  TreeDataProvider,
  TreeItem,
  Event,
  EventEmitter,
  TreeItemCollapsibleState,
  window,
  OutputChannel,
  Uri
} from "vscode";
import { LanguageClient, Disposable } from "vscode-languageclient";
import {
  MetalsTreeViewDidChange,
  MetalsTreeViewGetChildren,
  TreeViewNode
} from "./protocol";

export function startTreeView(
  client: LanguageClient,
  out: OutputChannel
): Disposable[] {
  const testView = new MetalsTreeView(client, out);
  client.onNotification(MetalsTreeViewDidChange.type, params => {
    testView.items[params.uri] = params;
    testView.didChange.fire(params.uri);
  });
  const view = window.createTreeView("metalsTreeView", {
    treeDataProvider: testView
  });
  return [view];
}

class MetalsTreeView implements TreeDataProvider<string> {
  didChange = new EventEmitter<string>();
  onDidChangeTreeData?: Event<string> = this.didChange.event;
  items = {};
  constructor(readonly client: LanguageClient, readonly out: OutputChannel) {}
  getTreeItem(uri: string): TreeItem {
    this.out.appendLine("getTreeItem() " + JSON.stringify(uri));
    const item = this.items[uri] as TreeViewNode;
    return {
      label: item.label,
      id: item.uri,
      resourceUri: Uri.parse(item.uri),
      collapsibleState: item.isCollapsible
        ? TreeItemCollapsibleState.Collapsed
        : TreeItemCollapsibleState.None
    };
  }
  getChildren(uri?: string): Thenable<string[]> {
    this.out.appendLine("getChildren() " + JSON.stringify(uri));
    return this.client
      .sendRequest(MetalsTreeViewGetChildren.type, {
        uri: uri
      })
      .then(result => {
        for (const item in this.items) {
          delete this.items[item];
        }
        result.nodes.forEach(n => {
          this.items[n.uri] = n;
        });
        return result.nodes.map(n => n.uri);
      });
  }
}
