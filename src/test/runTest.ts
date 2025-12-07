import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import { runTests } from '@vscode/test-electron';

function resolveWindowsShortPath(targetPath: string): string {
  if (process.platform !== 'win32' || !targetPath.includes(' ')) {
    return targetPath;
  }

  try {
    const { stdout, status } = cp.spawnSync('cmd', [
      '/c',
      `for %I in ("${targetPath}") do @echo %~sI`
    ], { encoding: 'utf8' });

    if (status === 0) {
      const shortPath = stdout.trim().replace(/^"|"$/g, '');
      if (shortPath) {
        return shortPath;
      }
    }
  } catch (error) {
    console.warn('Failed to resolve short path for VS Code tests:', error);
  }

  return targetPath;
}

async function main() {
  const repoRoot = path.resolve(__dirname, '../../');
  const extensionDevelopmentPath = resolveWindowsShortPath(repoRoot);
  const extensionTestsPath = resolveWindowsShortPath(path.resolve(__dirname, './suite/index'));

  const tempDir = os.tmpdir();
  const userDataDir = path.join(tempDir, 'vscode-test-user-' + Date.now());
  const extensionsDir = path.join(tempDir, 'vscode-test-extensions-' + Date.now());

  console.log('Test directories:');
  console.log('  Extension path:', extensionDevelopmentPath);
  console.log('  Tests path:', extensionTestsPath);
  console.log('  User data:', userDataDir);
  console.log('  Extensions:', extensionsDir);

  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        '--user-data-dir', userDataDir,
        '--extensions-dir', extensionsDir,
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--no-sandbox',
        '--disable-updates'
      ]
    });
  } catch (err) {
    console.error('Failed to run tests', err);
    process.exit(1);
  }
}

main();
