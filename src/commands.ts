import * as path from 'path';

import * as vs from 'vscode';

import { Model, HistoryViewContext } from './model';
import { HistoryViewProvider } from './historyViewProvider';
import { InfoViewProvider } from './infoViewProvider';
import { GitService, GitRepo, GitRefType, GitCommittedFile, GitLogEntry, WorkingTree } from './gitService';
import { Tracer } from './tracer';
import { ExplorerViewProvider } from './explorerViewProvider';
import { Dataloader } from './dataloader';
import { PanelViewProvider } from './panelViewProvider';

function toGitUri(uri: vs.Uri, ref?: string): vs.Uri {
  return uri.with({
    scheme: 'git',
    path: uri.path,
    query: JSON.stringify({
      path: uri.fsPath,
      ref
    })
  });
}

async function selectBranch(
  gitService: GitService,
  repo: GitRepo,
  types = [GitRefType.Head, GitRefType.RemoteHead, GitRefType.Tag]
): Promise<vs.QuickPickItem[]> {
  const refs = (await gitService.getRefs(repo)).filter(ref => types.includes(ref.type));
  return refs.map(ref => {
    let description: string | undefined;
    if (ref.type === GitRefType.Head) {
      description = ref.commit;
    } else if (ref.type === GitRefType.Tag) {
      description = `Tag at ${ref.commit}`;
    } else if (ref.type === GitRefType.RemoteHead) {
      description = `Remote branch at ${ref.commit}`;
    }
    return { label: ref.name || ref.commit, description };
  });
}

async function branchCombination(gitService: GitService, repo: GitRepo): Promise<vs.QuickPickItem[]> {
  const refs = (await gitService.getRefs(repo)).filter(ref => {
    return ref.type != GitRefType.Tag;
  });
  const localRefs = refs.filter(ref => {
    return ref.type != GitRefType.RemoteHead;
  });
  let items: vs.QuickPickItem[] = [];
  localRefs.forEach(source => {
    refs.forEach(target => {
      if (source.name != target.name && source.commit != target.commit) {
        items.push({
          label: `${source.name || source.commit} .. ${target.name || target.commit}`
        });
      }
    });
  });
  return items;
}

interface RepoPickItem extends vs.QuickPickItem {
  repo: GitRepo;
}

const Back = Symbol('back');

interface RefPickItem extends vs.QuickPickItem {
  ref?: string; // defaults to the label
  pick?: () => Promise<string | typeof Back | undefined>; // opens a sub-picker that resolves the ref
}

// Enables the Backspace keybinding of workbench.action.quickInputBack (see package.json).
function setBackOnBackspace(on: boolean) {
  vs.commands.executeCommand('setContext', 'githd.backOnBackspace', on);
}

// Resolves to the accepted item, the typed text when no item matches, Back when the back button,
// its keybinding or Backspace on an empty input is triggered, or undefined when dismissed.
// It resolves once the picker is hidden, so that the next picker sets the Backspace context after this one clears it.
// While typing, `search` replaces `items` once the typing pauses.
function showRefPick(
  items: RefPickItem[] | Thenable<RefPickItem[]>,
  placeholder: string,
  back: boolean,
  search?: (value: string) => Thenable<RefPickItem[]>
): Promise<RefPickItem | string | typeof Back | undefined> {
  const picker = vs.window.createQuickPick<RefPickItem>();
  picker.placeholder = placeholder;
  picker.matchOnDescription = true;
  picker.buttons = back ? [vs.QuickInputButtons.Back] : [];
  // shows `list` once loaded, unless the input has changed by then
  const load = (list: RefPickItem[] | Thenable<RefPickItem[]>, value = picker.value) => {
    picker.busy = true;
    Promise.resolve(list).then(list => {
      if (picker.value === value) {
        picker.items = list;
        picker.busy = false;
      }
    });
  };
  load(items);
  let searching: NodeJS.Timeout | undefined;
  let picked: RefPickItem | string | typeof Back | undefined;
  return new Promise(resolve => {
    picker.onDidChangeValue(value => {
      setBackOnBackspace(back && !value);
      if (search) {
        load(items); // filtered natively until the search returns
        clearTimeout(searching);
        searching = value ? setTimeout(() => load(search(value), value), 300) : undefined;
      }
    });
    picker.onDidTriggerButton(() => {
      picked = Back;
      picker.hide();
    });
    picker.onDidAccept(() => {
      const accepted = picker.activeItems[0] ?? picker.value.trim();
      if (accepted) {
        picked = accepted;
        picker.hide();
      }
    });
    picker.onDidHide(() => {
      clearTimeout(searching);
      setBackOnBackspace(false);
      picker.dispose();
      resolve(picked);
    });
    setBackOnBackspace(back);
    picker.show();
  });
}

function toCommitItems(entries: GitLogEntry[]): RefPickItem[] {
  return entries.map(e => ({
    label: e.subject,
    description: `${e.hash}${e.ref} · ${e.author} · ${e.relativeDate}`,
    ref: e.hash
  }));
}

async function selectGitRepo(gitService: GitService): Promise<GitRepo | undefined> {
  const repos: GitRepo[] = gitService.getGitRepos();
  if (repos.length === 0) {
    return;
  }
  if (repos.length === 1) {
    return repos[0];
  }
  const pickItems: RepoPickItem[] = repos.map(repo => {
    return { label: path.basename(repo.root), description: repo.root, repo };
  });
  const item = await vs.window.showQuickPick(pickItems, {
    placeHolder: 'Select the git repo'
  });
  return item?.repo;
}

async function selectAuthor(gitService: GitService, repo: GitRepo): Promise<vs.QuickPickItem[]> {
  let authors = await gitService.getAuthors(repo);
  authors.unshift({ name: 'All', email: '' });
  return authors.map(author => {
    return { label: author.name, description: author.email };
  });
}

interface Command {
  id: string;
  method: Function;
}

const Commands: Command[] = [];

function command(id: string) {
  return function (_target: any, _key: string, descriptor: PropertyDescriptor) {
    if (!(typeof descriptor.value === 'function')) {
      throw new Error('not supported');
    }
    Commands.push({ id, method: descriptor.value });
  };
}

export class CommandCenter {
  constructor(
    context: vs.ExtensionContext,
    private _model: Model,
    private _loader: Dataloader,
    private _gitService: GitService,
    private _historyView: HistoryViewProvider,
    private _explorerView: ExplorerViewProvider
  ) {
    // register an empty document content provider
    vs.workspace.registerTextDocumentContentProvider('githd-empty', {
      provideTextDocumentContent: () => ''
    });

    context.subscriptions.push(
      ...Commands.map(({ id, method }) => {
        return vs.commands.registerCommand(id, (...args: any[]) =>
          Promise.resolve(method.apply(this, args)).catch(err => Tracer.error(`command ${id} failed ${err.message}`))
        );
      })
    );
  }

  @command('githd.viewHistory')
  async viewHistory(): Promise<void> {
    Tracer.verbose('Command: githd.viewHistory');
    const repo = await this._getOrUpdateRepo();
    if (repo) {
      this._viewHistory({ repo, branch: '' });
    }
  }

  @command('githd.viewFileHistory')
  async viewFileHistory(specifiedPath = vs.window.activeTextEditor?.document?.uri): Promise<void> {
    Tracer.verbose('Command: githd.viewFileHistory');
    if (!specifiedPath) {
      return;
    }
    let repo = await this._gitService.getGitRepo(specifiedPath.fsPath);
    if (!repo) {
      return;
    }
    return this._viewHistory({ specifiedPath, repo, branch: '' });
  }

  @command('githd.viewFolderHistory')
  async viewFolderHistory(specifiedPath: vs.Uri): Promise<void> {
    Tracer.verbose('Command: githd.viewFolderHistory');
    return this.viewFileHistory(specifiedPath);
  }

  @command('githd.viewLineHistory')
  async viewLineHistory(file = vs.window.activeTextEditor?.document?.uri): Promise<void> {
    Tracer.verbose('Command: githd.viewLineHistory');
    if (!file) {
      return;
    }

    let repo = await this._gitService.getGitRepo(file.fsPath);
    if (!repo) {
      return;
    }
    let line = vs.window.activeTextEditor?.selection?.active?.line;
    if (!line) {
      return;
    }
    line++;
    return this._viewHistory({ specifiedPath: file, line, repo, branch: '' });
  }

  @command('githd.viewAllHistory')
  async viewAllHistory(): Promise<void> {
    Tracer.verbose('Command: githd.viewAllHistory');
    if (this._model.historyViewContext) {
      return this._viewHistory(this._model.historyViewContext, true);
    }

    const selected = await this._getOrUpdateRepo();
    if (!selected) {
      return;
    }
    this._model.setHistoryViewContext({ repo: selected, branch: '' });
  }

  @command('githd.viewBranchHistory')
  async viewBranchHistory(context?: HistoryViewContext): Promise<void> {
    Tracer.verbose('Command: githd.viewBranchHistory');
    let placeHolder: string = `Select a ref to see it's history`;
    let repo: GitRepo;
    if (context) {
      repo = context.repo;
      const specifiedPath = this._model.historyViewContext?.specifiedPath;
      if (specifiedPath) {
        placeHolder += ` of ${path.basename(specifiedPath.fsPath)}`;
      }
    } else {
      const selected = await this._getOrUpdateRepo();
      if (!selected) {
        return;
      }
      repo = selected;
    }
    placeHolder += ` (${repo.root})`;

    vs.window.showQuickPick(selectBranch(this._gitService, repo), { placeHolder }).then(item => {
      if (item) {
        if (context) {
          context.branch = item.label;
          this._viewHistory(context);
        } else {
          this._viewHistory({ branch: item.label, repo });
        }
      }
    });
  }

  @command('githd.viewAuthorHistory')
  viewAuthorHistory(): void {
    Tracer.verbose('Command: githd.viewAuthorHistory');
    const context = this._model.historyViewContext as HistoryViewContext;
    let placeHolder: string = `Select a author to see his/her commits`;
    vs.window
      .showQuickPick(selectAuthor(this._gitService, context.repo), {
        placeHolder
      })
      .then(item => {
        if (item) {
          const email = item.description;
          let context = this._model.historyViewContext;
          if (context) {
            context.author = email;
            this._viewHistory(context);
          }
        }
      });
  }

  @command('githd.viewStashes')
  async viewStashes(): Promise<void> {
    Tracer.verbose('Command: githd.viewStashes');
    const repo = await this._getOrUpdateRepo();
    if (repo) {
      this._viewHistory({ repo, isStash: true, branch: '' });
    }
  }

  @command('githd.diffBranch')
  async diffBranch(): Promise<void> {
    Tracer.verbose('Command: githd.diffBranch');
    const repo = await this._getOrUpdateRepo();
    if (!repo) {
      return;
    }
    this._diffSelections(repo);
  }

  @command('githd.diffFile')
  // explorer/context will pass two args while editor/context will one
  async diffFile(specifiedPath: vs.Uri, _: any, ref?: string): Promise<void> {
    Tracer.verbose('Command: githd.diffFile');
    return this._diffPath(specifiedPath, ref);
  }

  @command('githd.diffFolder')
  // explorer/context will pass two args while editor/context will one
  async diffFolder(specifiedPath: vs.Uri, _: any, ref?: string): Promise<void> {
    Tracer.verbose('Command: githd.diffFolder');
    return this._diffPath(specifiedPath, ref);
  }

  @command('githd.inputRef')
  async inputRef(): Promise<void> {
    Tracer.verbose('Command: githd.inputRef');
    const repo = await this._getOrUpdateRepo();
    if (!repo) {
      return;
    }
    vs.window
      .showInputBox({
        placeHolder: `Input a ref(sha1) to see it's committed files`
      })
      .then(ref => this._model.setFilesViewContext({ rightRef: ref?.trim(), repo }));
  }

  @command('githd.openCommit')
  openCommit(repo: GitRepo, ref: string, specifiedPath: vs.Uri): void {
    Tracer.verbose('Command: githd.openCommit');
    this._model.setFilesViewContext({ rightRef: ref, repo, specifiedPath });
  }

  @command('githd.diffCommits')
  async diffCommits(): Promise<void> {
    Tracer.verbose('Command: githd.diffCommits');
    const repo = await this._getOrUpdateRepo();
    if (!repo) {
      return;
    }
    const items: RefPickItem[] = [
      { label: 'HEAD' },
      {
        label: '$(git-commit) Commit...',
        description: 'recent commits on the current branch, or search all',
        pick: () =>
          this._pickCommit(repo, 'Recent commits on the current branch. Type to search all commits, or enter any ref')
      },
      {
        label: '$(git-branch) Branch...',
        description: 'local and remote branch heads',
        pick: () =>
          this._pickRef(
            selectBranch(this._gitService, repo, [GitRefType.Head, GitRefType.RemoteHead]),
            'Select a branch',
            true
          )
      },
      {
        label: '$(tag) Tag...',
        pick: () => this._pickRef(selectBranch(this._gitService, repo, [GitRefType.Tag]), 'Select a tag', true)
      }
    ];
    const workingTree: RefPickItem = {
      label: '$(edit) Working Tree',
      description: 'files on disk, editable',
      ref: WorkingTree
    };
    const refs: string[] = [];
    while (refs.length < 2) {
      const ref = await this._pickRef(
        refs.length ? [workingTree, ...items] : items,
        refs.length ? `Select the commit to compare against ${refs[0]}` : 'Select the base (left) commit',
        refs.length > 0
      );
      if (ref === undefined) {
        return;
      }
      if (ref === Back) {
        refs.pop();
      } else {
        refs.push(ref);
      }
    }
    const [leftRef, rightRef] = refs;
    this._model.setFilesViewContext({ repo, leftRef, rightRef });
  }

  @command('githd.goBackHistoryView')
  goBackHistoryView(): void {
    Tracer.verbose('Command: githd.goBackHistoryView');
    this._model.goBackHistoryViewContext();
  }

  @command('githd.goForwardHistoryView')
  goForwardHistoryView(): void {
    Tracer.verbose('Command: githd.goForwardHistoryView');
    this._model.goForwardHistoryViewContext();
  }

  @command('githd.goBackFilesView')
  goBackFilesViewContext(): void {
    this._model.goBackFilesViewContext();
  }

  @command('githd.goForwardFilesView')
  goForwardFilesViewContext(): void {
    this._model.goForwardFilesViewContext();
  }

  @command('githd.refreshFilesView')
  async refreshFilesView(): Promise<void> {
    Tracer.verbose('Command: githd.refreshFilesView');
    await this._explorerView.refresh();
  }

  @command('githd.goBackNoMore')
  dummyForGoBackIcon(): void {}

  @command('githd.goForwardNoMore')
  dummyForGoForwardIcon(): void {}

  @command('githd.previousCommit')
  async previousCommit(): Promise<void> {
    Tracer.verbose('Command: githd.previousCommit');
    this._explorerView.showPreviousCommit();
  }

  @command('githd.nextCommit')
  async nextCommit(): Promise<void> {
    Tracer.verbose('Command: githd.nextCommit');
    this._explorerView.showNextCommit();
  }

  @command('githd.previousCommitNoMore')
  dummyForPreviousCommitIcon(): void {}

  @command('githd.nextCommitNoMore')
  dummyForNextCommitIcon(): void {}

  @command('githd.openCommittedFile')
  openCommittedFile(file: GitCommittedFile): void {
    Tracer.verbose('Command: githd.openCommittedFile');
    let rightRef = this._model.filesViewContext?.rightRef;
    let leftRef: string = rightRef + '~';
    let title = rightRef;
    if (this._model.filesViewContext?.leftRef) {
      leftRef = this._model.filesViewContext.leftRef;
      title = `${leftRef} .. ${rightRef}`;
    }
    title += ' | ' + path.basename(file.gitRelativePath);
    let left = ['A', 'U'].includes(file.status) ? vs.Uri.parse('githd-empty:') : toGitUri(file.oldFileUri, leftRef);
    let right = file.status == 'D' ? vs.Uri.parse('githd-empty:') : toGitUri(file.fileUri, rightRef);
    if (rightRef === WorkingTree && file.status != 'D') {
      right = file.fileUri; // editable
    }
    vs.commands.executeCommand<void>('vscode.diff', left, right, title, { preview: true });
  }

  @command('githd.openCommitInfo')
  openCommitInfo(): void {
    Tracer.verbose('Command: githd.openCommitInfo');
    vs.workspace.openTextDocument(InfoViewProvider.defaultUri).then(doc => {
      vs.languages.setTextDocumentLanguage(doc, 'githd');
      vs.window
        .showTextDocument(doc, { preview: true, preserveFocus: true })
        .then(() => vs.commands.executeCommand('cursorTop'));
    });
  }

  @command('githd.openLineDiff')
  openLineDiff(content: string): void {
    Tracer.verbose('Command: githd.openLineDiff');
    vs.workspace
      .openTextDocument({ content, language: 'diff' })
      .then(doc =>
        vs.window
          .showTextDocument(doc, { preview: true, preserveFocus: true })
          .then(() => vs.commands.executeCommand('cursorTop'))
      );
  }

  @command('githd.diffUncommittedFile')
  async diffUncommittedFile(file = vs.window.activeTextEditor?.document?.uri): Promise<void> {
    if (!file) {
      return;
    }
    Tracer.verbose('Command: githd.diffUncommittedFile');

    const repo = await this._gitService.getGitRepo(file.fsPath);
    if (!repo) {
      return;
    }
    vs.window
      .showQuickPick(selectBranch(this._gitService, repo), {
        placeHolder: `Select a ref to see the diff with local copy of ${path.basename(file.path)}`
      })
      .then(async item => {
        if (item) {
          return await vs.commands.executeCommand<void>(
            'vscode.diff',
            toGitUri(file, item.label),
            file,
            `${item.label} .. Uncommitted (${path.basename(file.path)})`,
            { preview: true }
          );
        }
      });
  }

  @command('githd.setExpressMode')
  async setExpressMode(): Promise<void> {
    Tracer.verbose('Command: githd.setExpressMode');
    this._historyView.express = !this._historyView.express;
  }

  @command('githd.setRepository')
  async setRepository(): Promise<void> {
    Tracer.verbose('Command: githd.setRepository');

    const repo: GitRepo | undefined = await selectGitRepo(this._gitService);
    if (repo) {
      this._gitService.updateCurrentGitRepo(repo);
    }
  }

  @command('githd.clearFilesView')
  clearFilesView(): void {
    Tracer.verbose('Command: githd.clearFilesView');
    this._model.clearFilesViewContexts();
  }

  @command('githd.showStats')
  showStats(): void {
    Tracer.verbose('Command: githd.showStats');
    vs.commands.executeCommand(`${PanelViewProvider.viewType}.focus`);
  }

  private async _viewHistory(context: HistoryViewContext, all: boolean = false): Promise<void> {
    this._historyView.loadAll = all;
    await this._model.setHistoryViewContext(context);
  }

  private async _diffPath(specifiedPath: vs.Uri, ref?: string): Promise<void> {
    if (specifiedPath) {
      const repo = await this._gitService.getGitRepo(specifiedPath.fsPath);
      if (repo) {
        this._diffSelections(repo, specifiedPath, ref);
      }
    }
  }

  private async _diffSelections(repo: GitRepo, specifiedPath?: vs.Uri, ref?: string): Promise<void> {
    ref = ref || (await this._loader.getCurrentBranch(repo));
    const items: RefPickItem[] = [
      {
        label: 'Enter commit SHA',
        description: 'or search all commits',
        pick: () =>
          this._pickCommit(
            repo,
            `Type to search all commits, or a ref to compare with ${ref}, or 'ref1 .. ref2' to compare two refs`
          )
      },
      ...(await selectBranch(this._gitService, repo)),
      ...(await branchCombination(this._gitService, repo))
    ];
    const placeHolder: string = `Select a ref to see it's diff with ${ref} or select two refs to see their diffs`;
    let leftRef = await this._pickRef(items, placeHolder);
    let rightRef = ref;
    if (typeof leftRef !== 'string') {
      return;
    }

    if (leftRef.indexOf('..') != -1) {
      const diffBranch = leftRef.split('..');
      leftRef = diffBranch[0].trim();
      rightRef = diffBranch[1].trim();
    }

    this._model.setFilesViewContext({
      repo,
      leftRef,
      rightRef,
      specifiedPath
    });
  }

  // Picking an item with a sub-picker opens it, and going back from there shows `items` again.
  private async _pickRef(
    items: RefPickItem[] | Thenable<RefPickItem[]>,
    placeHolder: string,
    back = false,
    search?: (value: string) => Thenable<RefPickItem[]>
  ): Promise<string | typeof Back | undefined> {
    for (;;) {
      const picked = await showRefPick(items, placeHolder, back, search);
      if (typeof picked !== 'object') {
        return picked;
      }
      const ref = picked.pick ? await picked.pick() : (picked.ref ?? picked.label);
      if (ref !== Back) {
        return ref;
      }
    }
  }

  // Lists the recent commits of the current branch. Typing searches the messages of all commits, and a hash.
  private _pickCommit(repo: GitRepo, placeholder: string): Promise<string | typeof Back | undefined> {
    const count = this._model.configuration.commitsCount;
    // read from git, since the cached log entries of HEAD are not updated
    const recent = this._gitService.getLogEntries(repo, true, 0, count, 'HEAD').then(toCommitItems);
    return this._pickRef(recent, placeholder, true, async value => {
      const text = value.trim();
      const [byHash, byMessage, recentItems] = await Promise.all([
        /^[0-9a-f]{4,40}$/i.test(text) ? this._gitService.getLogEntries(repo, true, 0, 1, text) : [],
        this._gitService.searchCommits(repo, count, text.split(/\s+/)),
        recent
      ]);
      const found = new Map(toCommitItems([...byHash, ...byMessage]).map(item => [item.ref, item]));
      // the found commits, then the recent ones that match natively, like by author
      return [
        ...[...found.values()].map(item => ({ ...item, alwaysShow: true })),
        ...recentItems.filter(item => !found.has(item.ref))
      ];
    });
  }

  private async _getOrUpdateRepo(): Promise<GitRepo | undefined> {
    if (!this._gitService.currentGitRepo) {
      const repo: GitRepo | undefined = await selectGitRepo(this._gitService);
      if (!repo) {
        return;
      }
      this._gitService.updateCurrentGitRepo(repo);
    }
    return this._gitService.currentGitRepo;
  }
}
