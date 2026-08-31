#!/usr/bin/env node
/**
 * `npm run dev` — checks the setup, then runs both halves in one terminal.
 *
 * The app needs two processes: the API on port 5000, and Expo serving the app
 * itself. Before this existed that meant two terminals and remembering which
 * folder each one belonged in, which is a lot to ask of somebody who has just
 * unzipped a folder.
 *
 * Written by hand rather than pulling in `concurrently`, for two reasons. The
 * output needs to be labelled per process so a database error is not mistaken
 * for a bundler error, and Ctrl+C has to take down the whole tree on Windows —
 * `node --watch` in the backend spawns a child of its own, and killing only the
 * parent leaves port 5000 held by an orphan. The next `npm run dev` then fails
 * with EADDRINUSE and no clue why.
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BACKEND = path.join(ROOT, 'backend');

/**
 * The port the API will actually use, read from backend/.env.
 *
 * Printed rather than assumed: the banner used to say 5000 unconditionally, so
 * anybody who had changed PORT was told to check a URL that answers nothing.
 * A wrong instruction is worse than no instruction.
 */
function apiPort() {
  try {
    const env = fs.readFileSync(path.join(BACKEND, '.env'), 'utf8');
    const match = env.match(/^PORT=(\d+)/m);
    if (match) return match[1];
  } catch { /* no .env yet — setup writes one, and 5000 is its default */ }
  return '5000';
}

const children = [];
let shuttingDown = false;

/** Prefixes every line so two streams in one terminal stay readable. */
function pipe(stream, label) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) console.log(`${label} ${line}`);
  });
}

/**
 * `command` is a whole command line, not a command plus args.
 *
 * Windows cannot run npm without a shell (npm is a .cmd, and Node refuses to
 * exec one directly), and an args array combined with `shell: true` is
 * deprecated for the escaping problems it causes. One string, quoted here.
 */
function start(label, command, cwd) {
  const child = spawn(command, { cwd, shell: true });
  children.push(child);
  pipe(child.stdout, label);
  pipe(child.stderr, label);

  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.log(`\n${label} stopped (exit ${code}).`);
    // If one half dies the other is useless, so take everything down rather
    // than leaving a half-running system that looks alive.
    shutdown(code === null ? 1 : code);
  });

  return child;
}

/**
 * Kills the whole process tree.
 *
 * On Windows `child.kill()` reaches only the shell we spawned, not the node it
 * started, so the API keeps holding its port. taskkill /T is what actually
 * clears it.
 */
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n  stopping…');

  for (const child of children) {
    if (child.exitCode !== null || !child.pid) continue;
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }
  }

  setTimeout(() => process.exit(code), 400);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// ---------------------------------------------------------------------------

// Setup runs first and inherits the terminal, so its questions and its errors
// are the plain ones the person needs — not something buried under bundler
// output. A non-zero exit means it already printed a fix; do not add noise.
const setup = spawnSync('node', [path.join(__dirname, 'setup.js')], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: false,
});

if (setup.status !== 0) process.exit(setup.status || 1);

console.log('  Starting the server and the app. Press Ctrl+C to stop both.\n');

start('[api] ', 'npm run dev', BACKEND);
start('[app] ', 'npx expo start', ROOT);

// Printed after a pause so it lands under Expo's own banner rather than being
// scrolled away by it.
setTimeout(() => {
  console.log('\n  ------------------------------------------------------------');
  console.log('  The app:  press  w  to open it in a web browser');
  console.log('            or scan the QR code with Expo Go on a phone');
  console.log(`  The API:  http://localhost:${apiPort()}/health`);
  console.log('  ------------------------------------------------------------\n');
}, 6000);
