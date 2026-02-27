import { execSync } from 'node:child_process';
import { context, build } from 'esbuild';

function resolveCommitHash() {
  const envCommit =
    process.env.GITHUB_SHA
    || process.env.CF_PAGES_COMMIT_SHA
    || process.env.VERCEL_GIT_COMMIT_SHA
    || process.env.COMMIT_SHA;
  if (envCommit && envCommit.trim().length > 0) {
    return envCommit.trim();
  }
  try {
    return execSync('git rev-parse HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'dev';
  }
}

async function main() {
  const watch = process.argv.includes('--watch');
  const nodeEnv = watch ? 'development' : 'production';
  const commitHash = resolveCommitHash();
  const options = {
    entryPoints: ['src/main.ts', 'src/admin.ts'],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    outdir: 'dist',
    sourcemap: true,
    define: {
      'process.env.NODE_ENV': JSON.stringify(nodeEnv),
      __APP_COMMIT__: JSON.stringify(commitHash),
    },
    external: ['gl-matrix'],
  };

  if (watch) {
    const ctx = await context(options);
    await ctx.watch();
    const stamp = commitHash === 'dev' ? commitHash : commitHash.slice(0, 12);
    console.log(`[build_web] watch started (env=${nodeEnv}, commit=${stamp})`);
    return;
  }

  await build(options);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
