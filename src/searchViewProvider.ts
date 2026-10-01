import { randomBytes } from 'crypto';

import * as vs from 'vscode';
import { Minimatch } from 'minimatch';

import { ExplorerViewProvider, FilesFilter } from './explorerViewProvider';

interface SearchState {
  search: string;
  matchCase: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  include: string;
  exclude: string;
}

// Comma separated globs like VS Code search. A plain name or path matches as a file or folder at any depth.
function globs(input: string): Minimatch[] {
  return input
    .split(/,(?![^{]*})/)
    .map(glob => glob.trim())
    .filter(glob => glob)
    .map(
      glob =>
        new Minimatch(/[*?[{]/.test(glob) ? glob : `{**/,}${glob.replace(/\/$/, '')}{,/**}`, {
          dot: true,
          matchBase: true
        })
    );
}

// Throws when the regex is invalid.
function compile(state: SearchState): FilesFilter {
  const include = globs(state.include);
  const exclude = globs(state.exclude);
  const source = state.useRegex ? state.search : state.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    path: file =>
      (!include.length || include.some(glob => glob.match(file))) && !exclude.some(glob => glob.match(file)),
    content: state.search
      ? new RegExp(state.wholeWord ? `(?<!\\w)(?:${source})(?!\\w)` : source, state.matchCase ? 'm' : 'mi')
      : undefined
  };
}

export class SearchViewProvider implements vs.WebviewViewProvider {
  constructor(
    context: vs.ExtensionContext,
    private _explorerView: ExplorerViewProvider
  ) {
    context.subscriptions.push(
      vs.window.registerWebviewViewProvider('githd.search', this, { webviewOptions: { retainContextWhenHidden: true } })
    );
  }

  resolveWebviewView(view: vs.WebviewView): void {
    view.webview.options = { enableScripts: true };
    view.webview.html = getHtml(randomBytes(16).toString('base64'));
    view.webview.onDidReceiveMessage((state: SearchState) => {
      let filter: FilesFilter;
      try {
        filter = compile(state);
      } catch (err) {
        view.webview.postMessage((err as Error).message);
        return;
      }
      view.webview.postMessage('');
      this._explorerView.setFilter(filter);
    });
  }
}

function getHtml(nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body { padding: 4px 8px; }
.box {
  display: flex;
  align-items: center;
  margin-bottom: 4px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
}
.box:focus-within { border-color: var(--vscode-focusBorder); }
input {
  flex: 1;
  min-width: 0;
  padding: 0 4px;
  border: 0;
  outline: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: 22px;
}
button {
  min-width: 22px;
  margin-right: 1px;
  padding: 1px 3px;
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  opacity: 0.75;
}
button:hover { background: var(--vscode-toolbar-hoverBackground); opacity: 1; }
button.active {
  background: var(--vscode-inputOption-activeBackground);
  color: var(--vscode-inputOption-activeForeground);
  border-color: var(--vscode-inputOption-activeBorder, transparent);
  opacity: 1;
}
#error { color: var(--vscode-errorForeground); font-size: 11px; }
</style>
</head>
<body>
<div class="box">
  <input id="search" placeholder="Search changed lines" aria-label="Search changed lines">
  <button id="matchCase" title="Match Case (Alt+C)">Aa</button>
  <button id="wholeWord" title="Match Whole Word (Alt+W)"><u>ab</u></button>
  <button id="useRegex" title="Use Regular Expression (Alt+R)">.*</button>
</div>
<div class="box"><input id="include" placeholder="files to include" aria-label="files to include"></div>
<div class="box"><input id="exclude" placeholder="files to exclude" aria-label="files to exclude"></div>
<div id="error"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const inputs = ['search', 'include', 'exclude'].map(id => document.getElementById(id));
const toggles = ['matchCase', 'wholeWord', 'useRegex'].map(id => document.getElementById(id));
const keys = { KeyC: toggles[0], KeyW: toggles[1], KeyR: toggles[2] };
let timer;

function send() {
  const state = {};
  inputs.forEach(input => (state[input.id] = input.value));
  toggles.forEach(toggle => (state[toggle.id] = toggle.classList.contains('active')));
  vscode.setState(state);
  vscode.postMessage(state);
}
function flip(toggle) {
  toggle.classList.toggle('active');
  send();
}

inputs.forEach(input => input.addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(send, 200);
}));
toggles.forEach(toggle => toggle.addEventListener('click', () => flip(toggle)));
document.addEventListener('keydown', event => {
  if (event.altKey && keys[event.code]) {
    event.preventDefault();
    flip(keys[event.code]);
  }
});
window.addEventListener('message', event => (document.getElementById('error').textContent = event.data));

const state = vscode.getState();
if (state) {
  inputs.forEach(input => (input.value = state[input.id]));
  toggles.forEach(toggle => toggle.classList.toggle('active', state[toggle.id]));
  send();
}
</script>
</body>
</html>`;
}
