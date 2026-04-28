const { spawn } = require('child_process');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(baseUrl, timeoutMs = 30000) {
  const start = Date.now();
  let lastError = null;

  while ((Date.now() - start) < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        const payload = await response.json().catch(() => ({}));
        if (payload?.status === 'healthy' || payload?.status === 'unhealthy') {
          return payload;
        }
      }
    } catch (error) {
      lastError = error;
    }

    await delay(500);
  }

  throw new Error(`El backend no respondió en ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}`);
}

async function startServer({ cwd, port, extraEnv = {} }) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  child.on('exit', (code) => {
    if (code !== null && code !== 0) {
      stderr += `\n[server exited with code ${code}]`;
    }
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await waitForHealth(baseUrl);
  } catch (error) {
    child.kill('SIGINT');
    throw new Error(`${error.message}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`);
  }

  return {
    baseUrl,
    child,
    getLogs() {
      return { stdout, stderr };
    },
    async stop() {
      if (child.killed || child.exitCode !== null) return;

      child.kill('SIGINT');

      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        delay(5000).then(async () => {
          if (child.exitCode !== null) return;
          child.kill('SIGKILL');
          await new Promise((resolve) => child.once('exit', resolve));
        })
      ]);
    }
  };
}

module.exports = {
  startServer
};
