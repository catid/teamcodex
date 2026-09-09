import { errorMessage } from '@teamcodex/core/errors';
import { importCredentials } from '@teamcodex/proxy/auth/tokens';
import { getConfigPath, loadOrCreateConfig, resetConfig } from '@teamcodex/proxy/config';

import { upsertChatGPTAccount } from './accounts.ts';
import { accountsCommand, apiCommand, removeCommand } from './commands/accounts.ts';
import { importCommand, loginCommand } from './commands/auth.ts';
import { showHelp } from './commands/help.ts';
import { envCommand,runCommand } from './commands/run.ts';
import { serveCommand } from './commands/serve.ts';
import { statusCommand } from './commands/status.ts';

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const command = args[0];

  switch (command) {
    case 'smoke': {
      const { smokeCommand } = await import('./commands/smoke.ts');
      await smokeCommand(args.slice(1));
      break;
    }
    case 'serve':
    case 'server':
      await serveCommand(args);
      break;
    case 'init': {
      const config = await loadOrCreateConfig();
      if (config.accounts.length === 0) {
        try {
          const creds = await importCredentials();
          await upsertChatGPTAccount(null, creds, 'import');
        } catch (err) {
          console.log(errorMessage('CREDENTIAL_IMPORT_SKIPPED', { message: (err instanceof Error ? err.message : String(err)) }));
          console.log('Add an account with: teamcodex login --device-auth');
        }
      }
      break;
    }
    case 'reset': {
      const { backupPath } = await resetConfig();
      console.log(`Reset config at ${getConfigPath()} (accounts preserved)`);
      if (backupPath) console.log(`Backup: ${backupPath}`);
      console.log('Restart any running TeamCodex server to apply the new settings.');
      break;
    }
    case 'run':
      await runCommand(args);
      break;
    case 'import':
      await importCommand(args);
      process.exit(0);
      break;
    case 'login':
      await loginCommand(args);
      process.exit(0);
      break;
    case 'env':
      await envCommand(args);
      process.exit(0);
      break;
    case 'status':
      try { await statusCommand(await loadOrCreateConfig(), args.slice(1)); }
      catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
      process.exit(0);
      break;
    case 'accounts':
      await accountsCommand(args);
      process.exit(0);
      break;
    case 'remove':
      await removeCommand(args);
      process.exit(0);
      break;
    case 'api':
      await apiCommand(args);
      process.exit(0);
      break;
    case 'help':
    case '--help':
    case '-h':
      showHelp();
      break;
    default:
      // No command or unknown command → start server
      if (command && !command.startsWith('-')) {
        console.error(errorMessage('UNKNOWN_COMMAND', { command }));
        showHelp();
        process.exit(1);
      }
      await serveCommand(args);
      break;
  }

}
