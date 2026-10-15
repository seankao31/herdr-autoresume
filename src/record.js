'use strict';
// Event hook for pane.agent_status_changed: remember each resumable agent session's latest status.
//
// Every record is stamped with the server run (boot) that wrote it. When a session first changes
// status in a new run, its final status from the run before is kept in `prev`. The startup hook
// reads that final status, whether it runs before or after herdr has resumed the session.

const { bootId, herdr, readJson, recordFile, writeJsonAtomic } = require('./lib');

function main() {
  let event;
  try {
    event = JSON.parse(process.env.HERDR_PLUGIN_EVENT_JSON || '{}');
  } catch {
    return;
  }
  const paneId = event.data && event.data.pane_id;
  if (!paneId) return;

  // The event carries no session id, so read the pane. Its status is also more current than the
  // event's when hooks for quick successive changes finish out of order.
  const res = herdr(['pane', 'get', paneId], { allowError: true });
  const pane = res.result && (res.result.pane || res.result);
  const ref = pane && pane.agent_session;
  if (!ref || !ref.value) return; // no native session reference: herdr cannot resume it anyway

  const agent = pane.agent || ref.agent || event.data.agent;
  const file = recordFile(agent, ref.value);
  const boot = bootId();
  const now = new Date().toISOString();
  const old = readJson(file);
  if (old && old.boot === boot && old.ts > now) return; // a later hook already wrote a newer status

  const prev = !old ? null : old.boot !== boot ? { status: old.status, ts: old.ts, boot: old.boot } : old.prev || null;
  writeJsonAtomic(file, {
    agent,
    sessionId: ref.value,
    status: pane.agent_status || event.data.agent_status,
    paneId,
    cwd: pane.cwd,
    ts: now,
    boot,
    prev,
    handledTs: old ? old.handledTs : undefined,
    promptedAt: old ? old.promptedAt : undefined,
  });
}

main();
