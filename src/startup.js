'use strict';
// Startup hook: runs once after herdr restores a session. Starts kept commands in their panes, then
// prompts agent sessions from the previous run: "continue" for those that were mid-task, a check-in
// for recently active idle ones that may have had background work.

const fs = require('node:fs');
const path = require('node:path');
const {
  KEEP_PREFIX,
  agentsDir,
  bootId,
  formatTime,
  freshMarker,
  herdr,
  isProcessRunning,
  loadConfig,
  log,
  readJson,
  readRecords,
  seedConfig,
  serviceSession,
  sessionKey,
  sleep,
  writeJsonAtomic,
} = require('./lib');

// A check-in reply within this long after our prompt is not new activity of the session's own.
const OWN_REPLY_MS = 10 * 60 * 1000;

const normDir = (p) => (p || '').replace(/[\\/]+$/, '').toLowerCase();

// The session's final status in the run before this one.
function finalStatusOfPreviousRun(rec, boot) {
  if (rec.boot !== boot) return { status: rec.status, ts: rec.ts };
  return rec.prev || null; // this run already wrote to the record, so the final status moved to prev
}

function planPrompts(config, boot) {
  const now = Date.now();
  const retentionMs = config.recordRetentionDays * 24 * 3600 * 1000;
  // Sessions in the restored layout. Others will not be resumed, so there is no point waiting.
  const panes = herdr(['pane', 'list'], { allowError: true }).result?.panes || [];
  const restored = new Set(panes.map((p) => p.agent_session && p.agent_session.value).filter(Boolean));

  const plan = [];
  for (const { file, rec } of readRecords()) {
    if (now - Date.parse(rec.ts) > retentionMs) {
      fs.rmSync(file, { force: true });
      continue;
    }
    if (!config.agents.includes(rec.agent)) continue;
    if (restored.size > 0 && !restored.has(rec.sessionId)) continue;
    const final = finalStatusOfPreviousRun(rec, boot);
    if (!final || rec.handledTs === final.ts) continue;

    if (config.interruptedStatuses.includes(final.status)) {
      plan.push({ file, rec, final, kind: 'continue' });
    } else if (config.idleSessions === 'check-in') {
      const age = now - Date.parse(final.ts);
      const recent = !config.idleCheckinWithinHours || age <= config.idleCheckinWithinHours * 3600 * 1000;
      const onlyOurReply = rec.promptedAt && Date.parse(final.ts) - Date.parse(rec.promptedAt) < OWN_REPLY_MS;
      if (recent && !onlyOurReply) plan.push({ file, rec, final, kind: 'check-in' });
    }
  }
  return { plan, restoredCount: restored.size };
}

function markPrompted(item) {
  const latest = readJson(item.file) || item.rec;
  writeJsonAtomic(item.file, { ...latest, handledTs: item.final.ts, promptedAt: new Date().toISOString() });
}

async function sendPrompts(plan, config, deadline) {
  let pending = [...plan];
  while (pending.length > 0 && Date.now() < deadline) {
    const agents = herdr(['agent', 'list'], { allowError: true }).result?.agents || [];
    for (const item of [...pending]) {
      const live = agents.find((a) => a.agent_session && a.agent_session.value === item.rec.sessionId);
      if (!live || !['idle', 'done'].includes(live.agent_status)) continue; // not resumed yet, starting, or blocked
      pending = pending.filter((p) => p !== item);
      await sleep(config.settleSeconds * 1000);
      const template = item.kind === 'continue' ? config.resumePrompt : config.checkinPrompt;
      const text = template.replace(/\{time\}/g, formatTime(item.final.ts));
      const args = ['agent', 'prompt', live.pane_id, text, '--wait', '--until', 'working', '--timeout', '20000'];
      let res = herdr(args, { allowError: true });
      if (res.error && res.error.code === 'agent_prompt_stalled') {
        await sleep(5000); // the agent's input box may not have been ready yet
        res = herdr(args, { allowError: true });
      }
      if (!res.error) markPrompted(item);
      const outcome = res.error ? `failed: ${res.error.code} ${res.error.message || ''}` : 'sent';
      log(`${item.rec.agent} ${item.rec.sessionId} (${live.pane_id}): ${item.kind} prompt ${outcome}`);
    }
    if (pending.length > 0) await sleep(2000);
  }
  for (const item of pending) {
    log(`${item.rec.agent} ${item.rec.sessionId}: not resumed within ${config.agentReadyTimeoutSec}s, ${item.kind} prompt not sent`);
  }
}

// The pane for a kept command: the pane labelled for it, else a tab with its label (hand-written
// config), else a new tab, in a workspace that has a pane under its folder or in a new workspace.
function servicePane(svc) {
  let panes = herdr(['pane', 'list']).result.panes || [];
  const labelled = panes.find((p) => p.label === KEEP_PREFIX + svc.label);
  if (labelled) return labelled.pane_id;

  const tab = (herdr(['tab', 'list']).result.tabs || []).find((t) => t.label === svc.label);
  let paneId;
  if (tab) {
    paneId = (panes.find((p) => p.tab_id === tab.tab_id) || {}).pane_id;
  } else {
    const dir = normDir(svc.cwd);
    const home = panes.find((p) => normDir(p.cwd).startsWith(dir));
    const created = home
      ? herdr(['tab', 'create', '--workspace', home.workspace_id, '--cwd', svc.cwd, '--label', svc.label, '--no-focus'])
      : herdr(['workspace', 'create', '--cwd', svc.cwd, '--label', path.basename(dir) || svc.label, '--no-focus']);
    if (!home) herdr(['tab', 'rename', created.result.tab.tab_id, svc.label]);
    paneId = created.result.root_pane && created.result.root_pane.pane_id;
    if (!paneId) {
      panes = herdr(['pane', 'list']).result.panes || [];
      paneId = (panes.find((p) => p.tab_id === created.result.tab.tab_id) || {}).pane_id;
    }
  }
  if (!paneId) throw new Error('no pane to run it in');
  herdr(['pane', 'rename', paneId, KEEP_PREFIX + svc.label], { allowError: true });
  return paneId;
}

function startServices(config) {
  for (const svc of config.services) {
    if (svc.enabled === false || serviceSession(svc) !== sessionKey()) continue;
    try {
      if (svc.skipIfRunning && isProcessRunning(svc.skipIfRunning)) {
        log(`kept command ${svc.label}: already running outside herdr, not started`);
        continue;
      }
      const paneId = servicePane(svc);
      herdr(['pane', 'run', paneId, svc.command]);
      log(`kept command ${svc.label}: started in ${paneId}`);
    } catch (err) {
      log(`kept command ${svc.label}: ${err.message}`);
    }
  }
}

async function main() {
  if (seedConfig()) log('wrote missing settings to config.json with their defaults');
  const config = loadConfig();
  const boot = bootId();
  const deadline = Date.now() + config.agentReadyTimeoutSec * 1000;

  if (fs.existsSync(freshMarker())) {
    // Set by the "stop and start fresh" action, which also closed every workspace.
    fs.rmSync(freshMarker(), { force: true });
    fs.rmSync(agentsDir(), { recursive: true, force: true });
    log(`startup (session ${sessionKey()}): fresh start requested; nothing resumed, no kept commands started`);
    return;
  }

  const { plan, restoredCount } = planPrompts(config, boot);
  const describe = (kind) =>
    plan.filter((p) => p.kind === kind).map((p) => `${p.rec.agent} ${p.rec.sessionId} [${p.final.status}]`).join(', ') || 'none';
  log(
    `startup (session ${sessionKey()}, boot ${boot}): ${restoredCount} restored agent session(s); ` +
      `continue: ${describe('continue')}; check-in: ${describe('check-in')}`
  );
  startServices(config);
  await sendPrompts(plan, config, deadline);
  log('startup done');
}

main().catch((err) => {
  log(`startup error: ${err.stack || err.message}`);
  process.exitCode = 1;
});
