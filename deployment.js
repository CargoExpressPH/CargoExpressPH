import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectDir = __dirname;

// Attempt to load .env file if process.env.VERCEL_TOKEN is not already set
if (!process.env.VERCEL_TOKEN && fs.existsSync(path.join(projectDir, '.env'))) {
  try {
    if (typeof process.loadEnvFile === 'function') {
      process.loadEnvFile(path.join(projectDir, '.env'));
    } else {
      const envContent = fs.readFileSync(path.join(projectDir, '.env'), 'utf8');
      envContent.split(/\r?\n/).forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
          const [key, ...vals] = trimmed.split('=');
          const k = key.trim();
          if (k && !process.env[k]) {
            process.env[k] = vals.join('=').trim();
          }
        }
      });
    }
  } catch (e) {
    // Ignore .env read error
  }
}

const vercelToken = process.env.VERCEL_TOKEN;
if (!vercelToken) {
  console.error('❌ Error: VERCEL_TOKEN environment variable is missing.');
  console.error('Please ensure VERCEL_TOKEN is defined in your .env file or environment variables.');
  process.exit(1);
}

// Helper function to recursively copy directories
function copyFolderSync(from, to) {
  if (!fs.existsSync(to)) {
    fs.mkdirSync(to, { recursive: true });
  }
  fs.readdirSync(from).forEach(element => {
    const fromPath = path.join(from, element);
    const toPath = path.join(to, element);
    if (fs.lstatSync(fromPath).isDirectory()) {
      copyFolderSync(fromPath, toPath);
    } else {
      fs.copyFileSync(fromPath, toPath);
    }
  });
}

// TLS verification is relaxed for the CHILD process only (some corporate
// proxies do SSL inspection). It used to be set on this process too, which
// disabled certificate checking for everything this script does — a wider hole
// than the problem needs. The child still receives it via `env` below.

// Anything that looks like a credential is masked before it reaches a log.
// The Vercel token used to be interpolated into the command string and echoed
// verbatim, so every deploy wrote a live production token to stdout — into
// terminal scrollback, CI logs, and anywhere output was captured.
function redact(s) {
  return String(s)
    .replace(/(--token[= ])\S+/gi, '$1***')
    .replace(/\b(vcp|vercel)_[A-Za-z0-9_-]{10,}/g, '$1_***')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{10,}/g, 'gh*_***')
    .replace(/\bsbp_[A-Za-z0-9]{10,}/g, 'sbp_***');
}

// Helper function to execute shell commands cleanly.
// `secretEnv` is merged into the child's environment so credentials are passed
// out-of-band rather than on the command line, where they would also be visible
// to any other process listing (ps / Task Manager).
function runCommand(cmd, secretEnv = {}) {
  console.log(`\n🚀 Executing: ${redact(cmd)}`);
  try {
    execSync(cmd, {
      cwd: projectDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        ...secretEnv,
        NODE_NO_WARNINGS: '1',
        NODE_TLS_REJECT_UNAUTHORIZED: '0'
      }
    });
    return true;
  } catch (err) {
    console.error(`\n❌ Command failed: ${redact(cmd)}`, redact(err.message));
    return false;
  }
}

async function main() {
  console.log('====================================================');
  console.log('📦 CargoExpressPH — Single-Command Production Deployment');
  console.log('====================================================\n');

  // 1. Run local production build via Vite
  console.log('1️⃣ Building production bundle with Vite...');
  if (!runCommand('npm run build')) {
    console.error('❌ Build failed. Aborting deployment.');
    process.exit(1);
  }

  // 2. Prepare Vercel prebuilt output folder structure
  const outputDir = path.join(projectDir, '.vercel', 'output');
  const staticDir = path.join(outputDir, 'static');

  console.log('\n2️⃣ Preparing Vercel prebuilt output directory...');
  if (fs.existsSync(outputDir)) {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
  fs.mkdirSync(staticDir, { recursive: true });

  // 3. Copy built files from dist to .vercel/output/static
  const distDir = path.join(projectDir, 'dist');
  console.log(`3️⃣ Copying dist files to ${staticDir}...`);
  copyFolderSync(distDir, staticDir);

  // 4. Write Vercel routing configuration config.json
  const config = {
    version: 3,
    routes: [
      {
        src: '/sw.js',
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Service-Worker-Allowed': '/'
        },
        continue: true
      },
      {
        src: '/manifest.json',
        headers: {
          'Cache-Control': 'no-cache'
        },
        continue: true
      },
      {
        handle: 'filesystem'
      },
      {
        src: '/(.*)',
        dest: '/index.html'
      }
    ]
  };

  const configPath = path.join(outputDir, 'config.json');
  console.log('4️⃣ Writing Vercel routing configuration...');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

  // 5. The .git directory is left alone.
  //
  //    This step used to rename .git to .git-temp for the duration of the
  //    deploy, to sidestep a Vercel CLI author check. On Windows that rename
  //    repeatedly failed PART WAY THROUGH: .git kept HEAD/config/index/objects
  //    while refs/ and ~570 objects ended up in .git-temp. A repository without
  //    refs/ is not a repository, so `git status` answered "not a git
  //    repository" and the project looked destroyed — while the script printed
  //    DEPLOYMENT SUCCESSFUL and exited 0.
  //
  //    Retrying the rename only retried the damage. The real answer is not to
  //    move the repository at all: `--prebuilt` uploads the already-built
  //    .vercel/output directory, so the CLI has no reason to inspect git
  //    metadata. Set SKIP_GIT_ISOLATION=0 to restore the old behaviour if some
  //    future CLI version genuinely needs it.
  const gitPath = path.join(projectDir, '.git');
  const gitTempPath = path.join(projectDir, '.git-temp');
  const isolateGit = process.env.SKIP_GIT_ISOLATION === '0';

  let gitRenamed = false;
  let deploySuccess = false;
  let gitRestoreFailed = false;

  try {
    if (isolateGit && fs.existsSync(gitPath)) {
      console.log('5️⃣ Temporarily isolating .git repository metadata...');
      try {
        fs.renameSync(gitPath, gitTempPath);
        gitRenamed = true;
      } catch (err) {
        console.warn('⚠️ Warning: Could not rename .git directory (locked by OS/IDE):', err.message);
        console.warn('Proceeding with Vercel deployment directly...');
      }
    } else {
      console.log('5️⃣ Leaving .git in place (no isolation needed for --prebuilt).');
    }

    // 6. Deploy prebuilt bundle to Vercel Production
    console.log('6️⃣ Deploying prebuilt bundle live to Vercel Production...');
    // The CLI reads VERCEL_TOKEN from the environment, so the token never
    // appears in the command string, the log, or the OS process list.
    deploySuccess = runCommand(
      'npx -y vercel deploy --prod --prebuilt --yes',
      { VERCEL_TOKEN: vercelToken }
    );
  } finally {
    // 7. Restore .git. This previously tried once, and on failure printed a
    //    warning and let the script exit 0 — so a repository left with no .git
    //    reported as a clean deploy. On Windows the rename intermittently hits
    //    EPERM because an indexer, antivirus or editor still holds a handle,
    //    which is transient: retrying a few times clears it.
    if (gitRenamed && fs.existsSync(gitTempPath)) {
      console.log('7️⃣ Restoring .git repository metadata...');
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let restored = false;
      for (let attempt = 1; attempt <= 6 && !restored; attempt++) {
        try {
          fs.renameSync(gitTempPath, gitPath);
          restored = true;
        } catch (err) {
          if (attempt === 6) {
            console.error(`\n❌ FAILED to restore .git after ${attempt} attempts: ${err.message}`);
          } else {
            console.warn(`   attempt ${attempt} failed (${err.code || err.message}), retrying…`);
            await sleep(attempt * 400);
          }
        }
      }

      if (!restored) {
        // Loud, and non-zero. Without .git the working copy still holds every
        // source file, but history, branches and remotes are inside .git-temp —
        // and to anyone opening the project it looks as though the repository
        // was destroyed.
        console.error('\n====================================================');
        console.error('🚨 YOUR REPOSITORY IS STILL RENAMED.');
        console.error('   .git-temp exists and .git does not. Nothing is lost.');
        console.error('   Close any editor or terminal holding the folder, then:');
        console.error(`     mv "${gitTempPath}" "${gitPath}"`);
        console.error('   (PowerShell: Move-Item .git-temp .git)');
        console.error('====================================================\n');
        gitRestoreFailed = true;
      } else {
        console.log('   .git restored.');
      }
    }
  }

  if (deploySuccess) {
    console.log('\n====================================================');
    console.log('✅ DEPLOYMENT SUCCESSFUL!');
    console.log('🌐 Live Production URL: https://cargoexpress-ph.vercel.app');
    console.log('====================================================\n');
  } else {
    console.error('\n❌ Deployment to Vercel failed.');
    process.exit(1);
  }

  // A shipped deploy with a broken repository is not a success. Exit non-zero
  // so CI fails and a human notices, rather than reading "SUCCESSFUL" above and
  // walking away from a project that has no .git.
  if (gitRestoreFailed) process.exit(2);
}

main().catch(err => {
  console.error('❌ Unexpected error during deployment:', redact(err?.stack || err));
  process.exit(1);
});
