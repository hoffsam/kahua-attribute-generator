const Module = require('module');
const originalLoad = Module._load;

const noop = () => undefined;

const stubUriFactory = value => ({
  fsPath: value,
  path: value,
  toString: () => value
});

const vscodeStub = {
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({
      get: () => undefined
    }),
    onDidChangeConfiguration: () => ({ dispose: noop })
  },
  window: {
    createStatusBarItem: () => ({ show: noop, hide: noop, dispose: noop, text: '' }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showTextDocument: async () => undefined,
    activeTextEditor: undefined
  },
  commands: {
    executeCommand: async () => undefined,
    registerCommand: () => ({ dispose: noop })
  },
  ProgressLocation: {
    Notification: 15
  },
  StatusBarAlignment: {
    Right: 2,
    Left: 1
  },
  Uri: {
    parse: stubUriFactory,
    file: stubUriFactory,
    joinPath: (...parts) => stubUriFactory(parts.join('/'))
  }
};

Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return vscodeStub;
  }
  return originalLoad.apply(this, arguments);
};
