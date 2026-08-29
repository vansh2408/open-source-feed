import { startApi } from './api.js';
import { loadConfig } from './config.js';
import { createPool, migrate, readFeed } from './db.js';
import { enrichOnce } from './enrich.js';
import { dbSink, pollOnce, pollWatch } from './poller.js';

function usage(): never {
  console.error(
    'Usage: tsx src/index.ts <migrate | serve | poll:once [language] | poll:watch | enrich | api | feed [limit]>'
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);
  if (!command) usage();

  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  // Long-running commands keep the pool open; one-shot commands close it.
  let oneShot = true;

  try {
    switch (command) {
      case 'migrate': {
        await migrate(pool);
        break;
      }

      case 'poll:once': {
        // All configured languages, or just the one given as an argument.
        const languages = arg ? [arg] : config.languages;
        if (languages.length === 0) {
          console.error('Fatal: LANGUAGES is empty.');
          process.exit(1);
        }
        // Write-through: a one-shot CLI process has nowhere to buffer.
        await pollOnce(dbSink(pool), config, languages);
        break;
      }

      case 'enrich': {
        await enrichOnce(pool, config);
        break;
      }

      case 'poll:watch': {
        oneShot = false;
        await pollWatch(dbSink(pool), config);
        break;
      }

      case 'api': {
        oneShot = false;
        await startApi(pool, config);
        break;
      }

      // Production entrypoint (`npm start`): migrate, then serve.
      //
      // A failed migration warns instead of aborting. The feed is served from
      // memory and refilled from GitHub, so an unreachable database costs
      // freshness of the persisted copy, not availability of the site - and
      // exiting here would turn a database outage into a Render crash loop
      // with nothing served at all. Migrations are idempotent DDL, so the next
      // boot reapplies them; a genuinely broken migration still surfaces
      // loudly in the logs and in every failed flush.
      case 'serve': {
        oneShot = false;
        try {
          await migrate(pool);
        } catch (err) {
          console.error(
            'WARNING: migrations failed, serving anyway:',
            err instanceof Error ? err.message : err
          );
        }
        await startApi(pool, config);
        break;
      }

      case 'feed': {
        const limit = arg ? Number.parseInt(arg, 10) : config.feedPageSize;
        if (!Number.isFinite(limit) || limit <= 0) {
          console.error(`Fatal: feed limit must be a positive integer, got ${JSON.stringify(arg)}.`);
          process.exit(1);
        }
        const rows = await readFeed(pool, { limit });
        if (rows.length === 0) {
          console.log('No issues stored yet. Run `npm run poll:once` first.');
          break;
        }
        for (const row of rows) {
          const created = row.created_at.toISOString().slice(0, 16).replace('T', ' ');
          const stars = `★${row.repo_stars}`.padEnd(7);
          const labels = row.labels.length > 0 ? ` [${row.labels.join(', ')}]` : '';
          console.log(`${created}  ${stars} ${row.repo_full_name}#${row.number}${labels}`);
          console.log(`                          ${row.title}`);
          console.log(`                          ${row.url}`);
        }
        console.log(`\n${rows.length} issue(s), newest first.`);
        break;
      }

      default:
        usage();
    }
  } finally {
    if (oneShot) await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
