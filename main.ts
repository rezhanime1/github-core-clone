// Forge entrypoint: boot the app, announce ourselves to the trial env,
// then stay up until the suite reports it is done.
//
// Lifecycle (see the trial prompt): listen on an ephemeral port, POST the
// port to $MAKEFUN_ENV_URL/register, poll $MAKEFUN_ENV_URL/done about once
// a second, and exit 0 when it answers {"done": true}.
import { createApp } from "./app.ts";

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? "";
const POLL_INTERVAL_MS = 1000;
const REGISTER_ATTEMPTS = 5;
const REGISTER_RETRY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Tell the env where to reach us. A 200 means we are recorded; a 409
// means a previous attempt already landed, which counts as registered too.
// Anything else, or a thrown fetch error, earns another try.
async function announce(port: number): Promise<boolean> {
  for (let attempt = 1; attempt <= REGISTER_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port }),
      });
      if (res.ok || res.status === 409) return true;
      console.error(`register attempt ${attempt} refused: HTTP ${res.status}`);
    } catch (err) {
      console.error(`register attempt ${attempt} failed: ${err}`);
    }
    if (attempt < REGISTER_ATTEMPTS) await sleep(REGISTER_RETRY_MS);
  }
  return false;
}

// Ask the env, once a second, whether the suite has finished. A failed
// poll (network blip, stray body) never ends the loop — only a clean
// {"done": true} does.
async function waitUntilDone(): Promise<void> {
  for (;;) {
    try {
      const res = await fetch(`${ENV_URL}/done`);
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch (err) {
      console.error(`done poll failed: ${err}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function run(): Promise<number> {
  if (ENV_URL === "") {
    console.error("MAKEFUN_ENV_URL is not set");
    return 1;
  }
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    console.error("could not read the bound port");
    server.close();
    return 1;
  }
  const port = bound.port;
  console.log(`forge listening on port ${port}`);
  const registered = await announce(port);
  if (!registered) {
    console.error("registration failed after retries");
    server.close();
    return 1;
  }
  await waitUntilDone();
  server.close();
  return 0;
}

run().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
